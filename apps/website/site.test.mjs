import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { parse as parseJsonc } from 'jsonc-parser';

const siteDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(siteDirectory, 'public');
const sourceIcon = path.join(
  siteDirectory,
  '../ipad/Sources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png',
);
const pages = ['index.html', 'privacy/index.html', '404.html'];

function read(relativePath) {
  return readFileSync(path.join(publicDirectory, relativePath), 'utf8');
}

function documentFor(relativePath) {
  return new JSDOM(read(relativePath)).window.document;
}

function text(document) {
  return document.body.textContent.replace(/\s+/g, ' ').trim();
}

function pngSummary(bytes) {
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[chunk[9]] ?? 0;
    }
    if (type === 'IDAT') data.push(chunk);
    offset += length + 12;
  }
  // Every PNG filter type leaves the first pixel of the first row unchanged.
  const raw = inflateSync(Buffer.concat(data));
  const corner = [...raw.subarray(1, 4)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return { width, height, channels, corner: `#${corner}` };
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

test('Wrangler config is a static assets-only Worker with no bindings', () => {
  const config = parseJsonc(readFileSync(path.join(siteDirectory, 'wrangler.jsonc'), 'utf8'));
  assert.equal(config.name, 'tapplet-preview');
  assert.equal(config.account_id, 'b8b1032c61d9475cd00229c74db7ec72');
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.assets, {
    directory: './public',
    html_handling: 'drop-trailing-slash',
    not_found_handling: '404-page',
  });
  assert.deepEqual(
    Object.keys(config).sort(),
    ['$schema', 'account_id', 'assets', 'compatibility_date', 'name', 'preview_urls', 'workers_dev'],
  );
});

test('brand icon is an unmodified copy whose background matches the page canvas', () => {
  const copied = readFileSync(path.join(publicDirectory, 'AppIcon-1024.png'));
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(copied), digest(readFileSync(sourceIcon)));
  const icon = pngSummary(copied);
  assert.equal(icon.width, 1024);
  assert.equal(icon.height, 1024);
  const canvas = read('styles.css').match(/--canvas:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.equal(canvas?.toLowerCase(), icon.corner);
});

test('pages are script-free, self-contained and accessible', () => {
  for (const page of pages) {
    const document = documentFor(page);
    assert.equal(document.documentElement.lang, 'en-GB', page);
    assert.ok(document.title, page);
    assert.match(document.querySelector('meta[name="viewport"]')?.content ?? '', /width=device-width/, page);
    assert.equal(document.querySelectorAll('h1').length, 1, page);
    assert.equal(document.querySelectorAll('script, iframe, form, input, nav, noscript').length, 0, page);
    for (const element of document.querySelectorAll('*'))
      for (const attribute of element.attributes)
        assert.doesNotMatch(attribute.name, /^on/i, `${page} has an inline handler`);
    for (const image of document.querySelectorAll('img'))
      assert.ok(image.hasAttribute('alt'), `${page} image needs alt text`);
    for (const element of document.querySelectorAll('[href], [src]')) {
      const reference = element.getAttribute('href') ?? element.getAttribute('src');
      if (reference.startsWith('mailto:')) {
        assert.equal(reference, 'mailto:hello@tk.sg', page);
        continue;
      }
      assert.match(reference, /^\/(?!\/)/, `${page} references ${reference}`);
      const target = reference === '/' ? '/index.html' : reference;
      const candidates = [target, `${target}.html`, `${target}/index.html`];
      assert.ok(
        candidates.some((candidate) => existsSync(path.join(publicDirectory, candidate))),
        `${page} references missing ${reference}`,
      );
    }
  }
});

test('landing page contains only the logo, title, description, status and privacy link', () => {
  const document = documentFor('index.html');
  assert.equal(document.querySelector('main img')?.getAttribute('src'), '/AppIcon-1024.png');
  assert.equal(document.querySelector('h1')?.textContent, 'Tapplet');
  assert.equal(document.querySelectorAll('main p').length, 2);
  assert.match(document.querySelector('.tagline')?.textContent ?? '', /classroom activities/);
  assert.equal(document.querySelector('.status')?.textContent, 'Coming soon');
  const links = [...document.querySelectorAll('a')];
  assert.deepEqual(
    links.map((link) => [link.textContent, link.getAttribute('href')]),
    [['Privacy', '/privacy']],
  );
});

test('privacy notice has its date, sections, contact and return link', () => {
  const document = documentFor('privacy/index.html');
  const body = text(document);
  assert.match(document.querySelector('.updated')?.textContent ?? '', /6 October 2026/);
  assert.ok(document.querySelectorAll('h2').length >= 8);
  assert.ok([...document.querySelectorAll('a[href="/"]')].some((link) => /home/i.test(link.textContent)));
  assert.ok(document.querySelector('a[href="mailto:hello@tk.sg"]'));
  for (const phrase of [
    'Tinkertanker Pte Ltd',
    'Keychain',
    'anyone who has its link',
    '90 days',
    '180 days',
    '7 days',
    '14 days',
    'not instant',
    'Cloudflare',
    'IP address',
  ])
    assert.ok(body.includes(phrase), `privacy notice should mention ${phrase}`);
  assert.doesNotMatch(body, /no personal (data|information)|do not collect any|never log|immediately (deleted|discarded)/i);
});

test('styles avoid remote resources and horizontal overflow', () => {
  const css = read('styles.css');
  assert.doesNotMatch(css, /@import|@font-face|url\(/i);
  assert.doesNotMatch(css, /\b100vw\b/);
  assert.doesNotMatch(css, /(?:^|[\s;{])(?:min-)?width:\s*\d{3,}px/);
  assert.match(css, /max-width:\s*100%/);
  assert.match(css, /overflow-wrap:/);
  assert.match(css, /:focus-visible\s*{[^}]*outline:/);
});

test('headers forbid scripts and remote requests', () => {
  const headers = read('_headers');
  assert.match(headers, /Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'self';/);
  assert.doesNotMatch(headers, /script-src|https?:/);
});

test('published files contain no access-code-shaped values or external URLs', () => {
  for (const file of listFiles(publicDirectory)) {
    if (file.endsWith('.png')) continue;
    const content = readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /\b\d{4}[A-Za-z]{8}\b/, file);
    assert.doesNotMatch(content, /https?:\/\//, file);
  }
});
