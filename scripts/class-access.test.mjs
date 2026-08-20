import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('creates four digits followed by eight unambiguous uppercase letters', () => {
  const selected = [0, 1, 2, 3, 4, 5, 6, 7];
  assert.equal(createClassCode('1234', () => selected.shift()), '1234ABCDEFGH');
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
  assert.equal(normaliseClassCode('1234abcdefgh'), '1234ABCDEFGH');
  assert.equal(normaliseClassCode(' 1234-abcd-efgh '), '1234ABCDEFGH');
  for (const value of ['123-ABCD', '12345-ABCD', '1234-ABC1', 'ABCD-1234', '1234ABCDE', '1234--ABC', '1234ABCD', '1234-abcd']) {
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
