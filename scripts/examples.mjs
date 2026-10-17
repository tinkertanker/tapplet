#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { serializeSeedFixtures, productionSeedParityIssues } from './lib/html-artifact.mjs';
import { loadValidatedSeeds } from './lib/seed-corpus.mjs';
import { d1Results, executeD1 } from './lib/wrangler-d1.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectory = path.join(repoRoot, 'scripts', 'fixtures', 'examples');

async function packageFixtures() {
  const { manifest, records } = await loadValidatedSeeds();
  await mkdir(fixtureDirectory, { recursive: true });
  const fixtures = serializeSeedFixtures(records);
  await writeFile(path.join(fixtureDirectory, 'catalogue.json'), fixtures.catalogue);
  await writeFile(path.join(fixtureDirectory, 'api-import.ndjson'), fixtures.ndjson);
  console.log(`Packaged ${manifest.seeds.length} examples for catalogue and API import fixtures.`);
}

async function verifyFixtures(records) {
  const expected = serializeSeedFixtures(records);
  const [catalogue, ndjson] = await Promise.all([
    readFile(path.join(fixtureDirectory, 'catalogue.json'), 'utf8'),
    readFile(path.join(fixtureDirectory, 'api-import.ndjson'), 'utf8'),
  ]).catch(() => { throw new Error('Packaged fixtures are missing; run the package command.'); });
  if (catalogue !== expected.catalogue || ndjson !== expected.ndjson) {
    throw new Error('Packaged fixtures are stale; run the package command.');
  }
}

async function importSeeds() {
  const endpoint = option('--endpoint') ?? process.env.STUDIO_HTML_IMPORT_ENDPOINT;
  if (!endpoint) throw new Error('Provide --endpoint URL or STUDIO_HTML_IMPORT_ENDPOINT.');
  const { records } = await loadValidatedSeeds();
  const token = process.env.STUDIO_SEED_IMPORT_TOKEN ?? process.env.STUDIO_HTML_IMPORT_TOKEN;
  if (!token) throw new Error('Set STUDIO_SEED_IMPORT_TOKEN before importing reviewed seeds.');
  for (const record of records) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(record),
    });
    if (!response.ok) throw new Error(`Import failed for ${record.seedId}: HTTP ${response.status}.`);
    console.log(`Imported ${record.seedId}.`);
  }
}

async function verifyProductionSeedParity() {
  const { records } = await loadValidatedSeeds();
  const expected = records.map((record) => ({
    artifact_id: record.seedId,
    revision_id: `${record.seedId}-seed`,
    source_hash: createHash('sha256').update(record.artifact.html).digest('hex'),
  }));
  const query = 'SELECT r.artifact_id, r.revision_id, v.source_hash FROM retrieval_entries r JOIN revisions v ON v.id=r.revision_id WHERE r.curated=1 ORDER BY r.artifact_id';
  const result = executeD1(query);
  if (result.status !== 0) throw new Error('Could not read production curated seed metadata with Wrangler.');
  const remote = d1Results(result.stdout);
  if (!Array.isArray(remote)) throw new Error('Wrangler did not return production curated seed metadata as JSON.');
  const issues = productionSeedParityIssues(expected, remote);
  if (issues.length) throw new Error(`Production curated seed parity failed:\n- ${issues.join('\n- ')}`);
  console.log(`Verified exact production parity for ${expected.length} curated Tapplet seeds.`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const command = process.argv[2] ?? 'validate';
try {
  if (command === 'validate') {
    const { manifest, records } = await loadValidatedSeeds();
    await verifyFixtures(records);
    console.log(`Validated ${manifest.seeds.length} self-contained Tapplet HTML seeds.`);
  } else if (command === 'package') await packageFixtures();
  else if (command === 'import') await importSeeds();
  else if (command === 'parity') await verifyProductionSeedParity();
  else throw new Error('Usage: node scripts/examples.mjs validate|package|import|parity [--endpoint URL]');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
