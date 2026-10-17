import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedApiRecord, validateHtmlArtifact, validateSeedManifest } from './html-artifact.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const seedDirectory = path.join(repoRoot, 'apps', 'ipad', 'Resources', 'Examples');
const manifestPath = path.join(seedDirectory, 'manifest.json');
// The curated corpus size; change it together with the manifest.
const SEED_COUNT = 18;

// Reads the canonical example manifest and every listed HTML file, and throws
// unless each seed validates and matches its manifest entry.
export async function loadValidatedSeeds() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const manifestFailures = validateSeedManifest(manifest, { expectedCount: SEED_COUNT });
  if (manifestFailures.length) throw new Error(`Tapplet HTML seed validation failed:\n- ${manifestFailures.map((issue) => `manifest: ${issue.message}`).join('\n- ')}`);
  const failures = [];
  const records = [];
  const listedFiles = new Set();
  for (const seed of manifest.seeds ?? []) {
    const sourcePath = path.resolve(seedDirectory, seed.filename ?? '');
    if (path.dirname(sourcePath) !== seedDirectory) {
      failures.push(`${seed.id ?? 'unknown'}: filename escapes apps/ipad/Resources/Examples.`);
      continue;
    }
    listedFiles.add(seed.filename);
    let html;
    try {
      html = await readFile(sourcePath, 'utf8');
    } catch {
      failures.push(`${seed.id}: missing source file ${seed.filename}.`);
      continue;
    }
    const result = validateHtmlArtifact(html);
    result.issues.forEach((issue) => failures.push(`${seed.id} [${issue.code}]: ${issue.message}`));
    const title = /<title\b[^>]*>([^<]+)<\/title>/i.exec(html)?.[1].trim();
    const locale = /<html\b[^>]*\blang=["']([^"']+)["']/i.exec(html)?.[1];
    if (title !== seed.title) failures.push(`${seed.id}: manifest title does not match <title>.`);
    if (locale !== seed.locale) failures.push(`${seed.id}: manifest locale does not match <html lang>.`);
    records.push(seedApiRecord(seed, html));
  }
  const sourceFiles = (await readdir(seedDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => entry.name);
  sourceFiles.filter((file) => !listedFiles.has(file)).forEach((file) => failures.push(`${file}: HTML source is not listed in the manifest.`));
  if (failures.length) throw new Error(`Tapplet HTML seed validation failed:\n- ${failures.join('\n- ')}`);
  return { manifest, records };
}
