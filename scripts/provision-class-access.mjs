import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createClassCode,
  parseClassNumber,
  parseMaximumUses,
} from './class-access.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serviceDirectory = resolve(repositoryRoot, 'services/api');
const outputDirectory = resolve(repositoryRoot, '.studio-class-codes');
const usage = 'Usage: npm run class-access:provision -- <4-digit class number> <maximum uses 1-100> <future ISO expiry>';

export function parseFutureIsoExpiry(value, now = Date.now()) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value || timestamp <= now) {
    throw new Error('The class-code expiry must be an explicit future ISO-8601 timestamp (for example, 2030-01-01T00:00:00.000Z).');
  }
  return value;
}

export function readProvisioningFile(path, expected) {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`${path} must be a regular file, not a link or special file.`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let contents;
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`${path} must be a regular file.`);
    }
    fchmodSync(descriptor, 0o600);
    contents = readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  const code = contents.match(/\n(\d{4}[A-Z]{8})\n?$/)?.[1];
  if (!code || !contents.includes(`# Class: ${expected.classNumber}\n`) ||
      !contents.includes(`# Maximum activations: ${expected.maximumUses}\n`) ||
      !contents.includes(`# Expires: ${expected.expiresAt}\n`) || !code.startsWith(expected.classNumber)) {
    throw new Error(`${path} does not match this request. Preserve it and use its recorded arguments to retry, or move it to the Trash before rotating the code.`);
  }
  return code;
}

export function ensureProtectedDirectory(path) {
  if (existsSync(path)) {
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`${path} must be a real directory, not a link or special file.`);
    }
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  chmodSync(path, 0o700);
}

function codeHash(code) {
  return createHash('sha256').update(`class-code:${code}`).digest('hex');
}
function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function provisioningStatement({ hash, label, maximumUses, expiresAt, createdAt }) {
  return `INSERT INTO class_codes (code_hash, label, maximum_uses, expires_at, created_at) VALUES (` +
    `${sqlString(hash)}, ${sqlString(label)}, ${maximumUses}, ${sqlString(expiresAt)}, ${sqlString(createdAt)}) ` +
    `ON CONFLICT(code_hash) DO UPDATE SET code_hash=excluded.code_hash ` +
    `WHERE class_codes.label=excluded.label AND class_codes.maximum_uses=excluded.maximum_uses ` +
    `AND class_codes.expires_at=excluded.expires_at RETURNING label, maximum_uses, expires_at;`;
}

export function provisioningResultMatches(output, expected) {
  let rows;
  try {
    const executions = JSON.parse(output);
    rows = executions?.[0]?.success === true ? executions[0].results : undefined;
  } catch {
    return false;
  }
  return rows?.length === 1 && rows[0]?.label === expected.label &&
    rows[0]?.maximum_uses === expected.maximumUses && rows[0]?.expires_at === expected.expiresAt;
}

function main() {
  if (process.argv.length !== 5) throw new Error(usage);
  const classNumber = parseClassNumber(process.argv[2], usage);
  const maximumUses = parseMaximumUses(process.argv[3], usage);
  const expiresAt = parseFutureIsoExpiry(process.argv[4]);
  const outputPath = resolve(outputDirectory, `${classNumber}.txt`);
  ensureProtectedDirectory(outputDirectory);
  const code = existsSync(outputPath)
    ? readProvisioningFile(outputPath, { classNumber, maximumUses, expiresAt })
    : createClassCode(classNumber);
  const expected = { label: `Class ${classNumber}`, maximumUses, expiresAt };
  const statement = provisioningStatement({
    hash: codeHash(code),
    ...expected,
    createdAt: new Date().toISOString(),
  });
  const contents = [
    '# Tapplet class code',
    `# Class: ${classNumber}`,
    `# Maximum activations: ${maximumUses}`,
    `# Expires: ${expiresAt}`,
    '# Share only with this class. Each iPad activation consumes one use.',
    '',
    code,
    '',
  ].join('\n');

  if (!existsSync(outputPath)) {
    writeFileSync(outputPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }

  const result = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'DB', '--remote', '--profile', 'tinkertanker', '--json', '--command', statement],
    { cwd: serviceDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0 || !provisioningResultMatches(result.stdout, expected)) {
    throw new Error(
      `Could not confirm matching remote provisioning. The code remains protected at ${outputPath}; retry this identical command after checking Wrangler authentication and connectivity.`,
    );
  }
  console.log(`Provisioned class ${classNumber} with a maximum of ${maximumUses} activations.`);
  console.log(`The code was written with owner-only permissions to ${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
