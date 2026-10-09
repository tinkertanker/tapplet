import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseClassCode, parseClassNumber } from './class-access.mjs';

const usage = 'Usage: npm run class-access:shorten -- <4-digit class number> <--local|--remote>';
const classNumber = parseClassNumber(process.argv[2], usage);
const target = process.argv[3];
if (!['--local', '--remote'].includes(target) || process.argv.length !== 4) {
  throw new Error(usage);
}
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(repositoryRoot, '.studio-class-codes', `${classNumber}.txt`);
const lines = readFileSync(outputPath, 'utf8').split(/\r?\n/)
  .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
const code = lines.length === 1 ? normaliseClassCode(lines[0]) : null;
if (!code || !/^\d{4}[A-Z]{8}$/.test(code) || !code.startsWith(classNumber)) {
  throw new Error(`${outputPath} must contain the original twelve-character code for this class.`);
}
const hash = (value) => createHash('sha256').update(`class-code:${value}`).digest('hex');
const fullHash = hash(code);
const shortHash = hash(code.slice(-6));
// One row owns both forms: never reset capacity, usage or expiry during backfill.
const statement = `UPDATE class_codes SET short_code_hash='${shortHash}' ` +
  `WHERE code_hash='${fullHash}' AND (short_code_hash IS NULL OR short_code_hash='${shortHash}') ` +
  'RETURNING label, maximum_uses, use_count, expires_at;';
const result = spawnSync('npx', [
  'wrangler', 'd1', 'execute', 'DB', target, '--profile', 'tinkertanker', '--json', '--command', statement,
], { cwd: resolve(repositoryRoot, 'services/api'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let responses;
try {
  if (result.status !== 0) throw new Error();
  responses = JSON.parse(result.stdout);
} catch {
  // Wrangler output can include SQL containing both credential hashes.
  throw new Error('Could not confirm the shortened class code. Check Wrangler authentication and connectivity, then retry the same command.');
}
const rows = Array.isArray(responses) && responses.length === 1 &&
  responses[0]?.success === true && Array.isArray(responses[0].results)
  ? responses[0].results : [];
if (rows.length !== 1) {
  throw new Error(`No matching class code was updated for class ${classNumber}. Check the target database and original code file.`);
}
console.log(`Enabled the last six characters for class ${classNumber}. Existing usage, activation limit and expiry are unchanged.`);
