import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClassCode,
  normaliseClassCode,
  parseClassNumber,
  parseMaximumUses,
} from './class-access.mjs';
import {
  ensureProtectedDirectory,
  parseFutureIsoExpiry,
  provisioningResultMatches,
  provisioningStatement,
  readProvisioningFile,
} from './provision-class-access.mjs';

test('creates six random digits, preserving leading zeroes', () => {
  assert.equal(createClassCode(() => 42), '000042');
  assert.equal(createClassCode(() => 999999), '999999');
  assert.match(createClassCode(), /^\d{6}$/);
});

test('requires an operator-supplied four-digit class number', () => {
  assert.equal(parseClassNumber('0042'), '0042');
  for (const value of ['123', '12345', '12A4', ' 1234 ']) {
    assert.throws(() => parseClassNumber(value));
  }
});

test('requires a fixed activation limit between 1 and 100', () => {
  assert.equal(parseMaximumUses('1'), 1);
  assert.equal(parseMaximumUses('30'), 30);
  assert.equal(parseMaximumUses('100'), 100);
  for (const value of ['0', '101', '-1', '1.5', ' 30 ']) {
    assert.throws(() => parseMaximumUses(value));
  }
});

test('normalises compact and hyphenated class codes to the same value', () => {
  assert.equal(normaliseClassCode(' 000-042 '), '000042');
  assert.equal(normaliseClassCode(' cdefgh '), 'CDEFGH');
  assert.equal(normaliseClassCode('1234abcdefgh'), '1234ABCDEFGH');
  assert.equal(normaliseClassCode(' 1234-abcd-efgh '), '1234ABCDEFGH');
  for (const value of ['12345', '1234567', 'AB12CD', '123-ABCD', '12345-ABCD', '1234-ABC1', 'ABCD-1234', '1234ABCDE', '1234--ABC', '1234ABCD', '1234-abcd']) {
    assert.equal(normaliseClassCode(value), null);
  }
});

test('requires an explicit canonical future ISO expiry', () => {
  assert.equal(parseFutureIsoExpiry('2030-01-01T00:00:00.000Z', Date.parse('2029-01-01T00:00:00Z')), '2030-01-01T00:00:00.000Z');
  for (const value of [undefined, '2030-01-01', '2030-01-01T00:00:00Z', '2028-01-01T00:00:00.000Z']) {
    assert.throws(() => parseFutureIsoExpiry(value, Date.parse('2029-01-01T00:00:00Z')));
  }
});

test('reuses only a matching protected provisioning file after a failed attempt', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tapplet-class-')), '0042.txt');
  writeFileSync(path, '# Tapplet class code\n# Class: 0042\n# Maximum activations: 30\n# Expires: 2030-01-01T00:00:00.000Z\n\n0042ABCDEFGH\n', { mode: 0o644 });
  const expected = { classNumber: '0042', maximumUses: 30, expiresAt: '2030-01-01T00:00:00.000Z' };
  assert.equal(readProvisioningFile(path, expected), '0042ABCDEFGH');
  assert.equal(readFileSync(path, 'utf8').includes('0042ABCDEFGH'), true);
  assert.equal(statSync(path).mode & 0o077, 0);
  assert.throws(() => readProvisioningFile(path, { ...expected, maximumUses: 31 }));
  writeFileSync(path, '# Tapplet class code\n# Class: 0042\n# Maximum activations: 30\n# Expires: 2030-01-01T00:00:00.000Z\n\n000042\n');
  assert.equal(readProvisioningFile(path, expected), '000042');
});

test('rejects linked credential files and directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'tapplet-class-links-'));
  const target = join(root, 'target');
  writeFileSync(target, 'not a credential');
  const linkedFile = join(root, 'linked-file');
  symlinkSync(target, linkedFile);
  assert.throws(() => readProvisioningFile(linkedFile, {
    classNumber: '0042',
    maximumUses: 30,
    expiresAt: '2030-01-01T00:00:00.000Z',
  }));

  const directory = join(root, 'directory');
  mkdirSync(directory);
  const linkedDirectory = join(root, 'linked-directory');
  symlinkSync(directory, linkedDirectory);
  assert.throws(() => ensureProtectedDirectory(linkedDirectory));
});

test('uses a convergent remote insert and confirms exact metadata without exposing the code', () => {
  const expected = {
    label: 'Class 0042',
    maximumUses: 30,
    expiresAt: '2030-01-01T00:00:00.000Z',
  };
  const statement = provisioningStatement({
    hash: 'safe-hash',
    ...expected,
    createdAt: '2029-01-01T00:00:00.000Z',
  });
  assert.match(statement, /ON CONFLICT\(code_hash\) DO UPDATE/);
  assert.match(statement, /RETURNING label, maximum_uses, expires_at/);
  assert.doesNotMatch(statement, /0042ABCDEFGH/);
  const output = JSON.stringify([{ success: true, results: [{
    label: expected.label,
    maximum_uses: expected.maximumUses,
    expires_at: expected.expiresAt,
  }] }]);
  assert.equal(provisioningResultMatches(output, expected), true);
  assert.equal(provisioningResultMatches(JSON.stringify([{ success: true, results: [] }]), expected), false);
  assert.equal(provisioningResultMatches(output, { ...expected, maximumUses: 31 }), false);
});

test('CLI replaces only a confirmed numeric collision and preserves uncertain retries', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tapplet-class-allocation-')));
  t.after(() => process.platform === 'darwin' ? spawnSync('trash', [root]) : rmSync(root, { recursive: true, force: true }));
  for (const directory of ['scripts', 'services/api', 'bin', '.studio-class-codes']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const name of ['class-access.mjs', 'provision-class-access.mjs']) {
    copyFileSync(new URL(name, import.meta.url), join(root, 'scripts', name));
  }
  const path = join(root, '.studio-class-codes', '0042.txt');
  const contents = '# Tapplet class code\n# Class: 0042\n# Maximum activations: 30\n# Expires: 2099-01-01T00:00:00.000Z\n\n123456\n';
  writeFileSync(path, contents, { mode: 0o600 });
  const dbPath = join(root, 'database.sqlite');
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec('CREATE TABLE class_codes(code_hash TEXT PRIMARY KEY,label TEXT,maximum_uses INTEGER,use_count INTEGER DEFAULT 0,expires_at TEXT,created_at TEXT)');
  const hash = code => createHash('sha256').update(`class-code:${code}`).digest('hex');
  sqlite.prepare('INSERT INTO class_codes VALUES(?,?,?,?,?,?)').run(hash('123456'), 'Class 0042', 9, 7, '2090-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  writeFileSync(join(root, 'bin/npx'), `#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
if (process.env.FAIL_TRANSPORT) process.exit(1);
const db = new DatabaseSync(process.env.TEST_DB);
if (process.env.COLLIDE && !existsSync(process.env.COLLIDE)) {
  const code = readFileSync(process.env.TEST_CODE_FILE,'utf8').trim().split('\\n').at(-1);
  const hash = createHash('sha256').update('class-code:'+code).digest('hex');
  db.prepare('INSERT OR IGNORE INTO class_codes VALUES(?,?,?,?,?,?)').run(hash,'Other class',9,7,'2090-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  writeFileSync(process.env.COLLIDE,'done');
}
const results = db.prepare(process.argv.at(-1)).all();
console.log(JSON.stringify([{success:true,results}]));
db.close();
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TEST_DB: dbPath, TEST_CODE_FILE: path };
  const run = extraEnv => spawnSync(process.execPath, [join(root, 'scripts/provision-class-access.mjs'), '0042', '30', '2099-01-01T00:00:00.000Z'], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  try {
    assert.notEqual(run({ FAIL_TRANSPORT: '1' }).status, 0);
    assert.equal(readFileSync(path, 'utf8'), contents);
    assert.notEqual(run({ FAIL_TRANSPORT: '' }).status, 0);
    assert.equal(readFileSync(path, 'utf8'), contents);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM class_codes').get().count, 1);
    renameSync(path, join(root, 'original-code.txt'));
    const result = run({ FAIL_TRANSPORT: '', COLLIDE: join(root, 'collided') });
    assert.equal(result.status, 0, result.stderr);
    const code = readProvisioningFile(path, { classNumber: '0042', maximumUses: 30, expiresAt: '2099-01-01T00:00:00.000Z' });
    assert.match(code, /^\d{6}$/);
    assert.notEqual(code, '123456');
    assert.equal(statSync(path).mode & 0o077, 0);
    assert.deepEqual({ ...sqlite.prepare('SELECT label,maximum_uses,use_count FROM class_codes WHERE code_hash=?').get(hash('123456')) }, { label: 'Class 0042', maximum_uses: 9, use_count: 7 });
    assert.equal(sqlite.prepare('SELECT label FROM class_codes WHERE code_hash=?').get(hash(code)).label, 'Class 0042');
    assert.equal(run({ FAIL_TRANSPORT: '' }).status, 0);
    assert.equal(readProvisioningFile(path, { classNumber: '0042', maximumUses: 30, expiresAt: '2099-01-01T00:00:00.000Z' }), code);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM class_codes').get().count, 3);
  } finally {
    sqlite.close();
  }
});
