import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { chromium } from 'playwright';
import {
  productionSeedParityIssues,
  seedApiRecord,
  serializeSeedFixtures,
  validateHtmlArtifact,
  validateSeedManifest,
} from './lib/html-artifact.mjs';

const validHtml = '<!doctype html><html lang="en-SG"><head><meta name="viewport" content="width=device-width"><title>Test</title><style>button{min-height:44px}</style></head><body><button>Try</button><script>document.querySelector("button").onclick=()=>{}</script></body></html>';

test('rejects decoded meta refresh directives', () => {
  for (const directive of ['&#114;efresh', ' REFRESH ']) {
    const html = validHtml.replace('</head>', `<meta http-equiv="${directive}" content="0;url=https://outside.invalid/"></head>`);
    assert.equal(validateHtmlArtifact(html).valid, false, directive);
  }
});

test('parses executable modules and skips inert script data using actual attributes', () => {
  for (const script of [
    '<script type=" MODULE ">export const fraction = 0.5;</script>',
    '<script type="application/json">{"enabled":true}</script>',
    '<script type="text/plain">not JavaScript at all</script>',
    '<script type="text/javascript; charset=utf-8">const value = ;</script>',
    '<script data-note="type=module">const value = 1;</script>',
  ]) {
    assert.deepEqual(validateHtmlArtifact(validHtml.replace(/<script>[\s\S]*?<\/script>/, script)).issues, [], script);
  }
});

test('rejects syntax-invalid executable scripts and inline handlers', () => {
  for (const snippet of [
    '<script type="module">export const fraction = ;</script>',
    '<script>const fraction = ;</script>',
    '<script type="text/javascript1.5">const fraction = ;</script>',
    '<button onclick="const fraction = ;">Try</button>',
  ]) {
    assert.ok(validateHtmlArtifact(validHtml.replace('</body>', `${snippet}</body>`)).issues
      .some((issue) => issue.code === 'javascript-syntax'), snippet);
  }
  assert.equal(validateHtmlArtifact(validHtml.replace('<button>', '<button onclick="return false">')).valid, true);
});

test('validates a complete self-contained artifact', () => {
  assert.deepEqual(validateHtmlArtifact(validHtml).issues, []);
  assert.deepEqual(
    validateHtmlArtifact(validHtml.replace('</body>', '<img src="assets/image-1" alt="Diagram"></body>')).issues,
    [],
    'managed teacher images are valid relative resources',
  );
});

test('rejects external dependencies, network calls, and invalid JavaScript', () => {
  const html = validHtml
    .replace('<body>', '<body><script src="https://cdn.example/a.js"></script>')
    .replace('document.querySelector("button").onclick=()=>{}', 'fetch("/data")\nlet =');
  const codes = validateHtmlArtifact(html).issues.map((issue) => issue.code);
  assert.ok(codes.includes('external-script'));
  assert.ok(codes.includes('network'));
  assert.ok(codes.includes('javascript-syntax'));
});

test('allows comments but rejects overlooked network and resource paths', () => {
  assert.equal(validateHtmlArtifact(validHtml.replace('document.', '// local interaction\ndocument.')).valid, true);
  for (const snippet of [
    '<form action="/collect"></form>',
    '<img srcset="small.png 1x, large.png 2x">',
    '<style>.hero{background:url(/image.png)}</style>',
    '<script>navigator.sendBeacon("/collect")</script>',
  ]) {
    const result = validateHtmlArtifact(validHtml.replace('</body>', `${snippet}</body>`));
    assert.equal(result.valid, false, snippet);
  }
});

test('validates manifest uniqueness and required metadata', () => {
  const seed = { id: 'stable-id', filename: 'stable-id.html', title: 'Title', summary: 'Summary', subject: 'science', level: 'secondary', locale: 'en-SG', learningObjective: 'Learn', tags: ['a', 'b', 'c'], interactionPattern: 'quiz', descriptor: 'Card', designCard: { layout: 'one screen' } };
  assert.deepEqual(validateSeedManifest({ schemaVersion: '1.0', seeds: [seed] }), []);
  const issues = validateSeedManifest({ schemaVersion: '1.0', seeds: [seed, { ...seed }] });
  assert.equal(issues.filter((issue) => issue.code === 'duplicate').length, 3);
  assert.equal(validateSeedManifest({ schemaVersion: '1.0', seeds: [seed] }, { expectedCount: 14 })[0].code, 'seed-count');
  assert.equal(validateSeedManifest({ schemaVersion: '1.0', seeds: [{ ...seed, tags: Array(21).fill('tag') }] })[0].code, 'tags');
  assert.equal(validateSeedManifest({ schemaVersion: '1.0', seeds: [{ ...seed, tags: ['a', 'b', 'x'.repeat(51)] }] })[0].code, 'tags');
});

test('builds a backend-neutral API record', () => {
  const record = seedApiRecord({ id: 'seed', title: 'Title', summary: 'Summary', subject: 'science', level: 'secondary', locale: 'en-SG', learningObjective: 'Learn', tags: ['one'], interactionPattern: 'quiz', descriptor: 'Compact', designCard: { accent: 'blue' } }, validHtml);
  assert.equal(record.seedId, 'seed');
  assert.equal(record.artifact.html, validHtml);
  assert.deepEqual(record.artifact.designCard, { accent: 'blue' });
  const fixtures = serializeSeedFixtures([record]);
  assert.equal(JSON.parse(fixtures.catalogue).seeds[0].seedId, 'seed');
  assert.equal(JSON.parse(fixtures.ndjson).seedId, 'seed');
});

test('requires exact production seed ID, revision, and source-hash parity', () => {
  const expected = [
    { artifact_id: 'one', revision_id: 'one-seed', source_hash: 'hash-one' },
    { artifact_id: 'two', revision_id: 'two-seed', source_hash: 'hash-two' },
  ];
  assert.deepEqual(productionSeedParityIssues(expected, structuredClone(expected)), []);
  const issues = productionSeedParityIssues(expected, [
    { artifact_id: 'one', revision_id: 'old', source_hash: 'wrong' },
    { artifact_id: 'stale', revision_id: 'stale-seed', source_hash: 'stale-hash' },
  ]);
  assert.ok(issues.some((issue) => issue.includes('Missing remote curated seed two')));
  assert.ok(issues.some((issue) => issue.includes('one points to revision old')));
  assert.ok(issues.some((issue) => issue.includes('one has a different source hash')));
  assert.ok(issues.some((issue) => issue.includes('Stale remote curated seed stale')));
});

test('all curated seeds initialise without browser errors', async () => {
  const directory = path.resolve('apps/ipad/Resources/Examples');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.html'));
  assert.equal(files.length, 18);
  for (const file of files) {
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => errors.push(error));
    virtualConsole.on('error', (error) => errors.push(error));
    const dom = new JSDOM(await readFile(path.join(directory, file), 'utf8'), {
      runScripts: 'dangerously',
      url: 'https://artifact.invalid/',
      virtualConsole,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    dom.window.close();
    assert.deepEqual(errors, [], file);
  }
});

test('seven curated sliders have independently specified accessible label names', async () => {
  const expected = {
    'catchment-under-pressure': { rain: 'Rainfall: mm/h', hard: 'Paved ground: %', drain: 'Drainage: mm/h' },
    'linear-function-explorer': { m: 'Gradient m:', c: 'Vertical intercept c:' },
    'line-golf': { m: 'Gradient m:', c: 'Vertical intercept c:' },
  };
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [example, names] of Object.entries(expected)) {
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent(await readFile(`apps/ipad/Resources/Examples/${example}.html`, 'utf8'));
      assert.equal(await page.getByRole('slider').count(), Object.keys(names).length);
      for (const [id, name] of Object.entries(names)) {
        const slider = page.getByRole('slider', { name, exact: true });
        assert.equal(await slider.count(), 1, `${example} #${id} accessible name: ${name}`);
        assert.equal(await slider.getAttribute('id'), id);
        assert.equal(await slider.evaluate((input) => input.labels.length), 1);
        assert.equal(await slider.evaluate((input) => input.labels[0].control.id), id);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('spelling misses teach the target pattern', async () => {
  const html = await readFile(
    path.resolve('apps/ipad/Resources/Examples/spell-it-before-the-sun-sets.html'),
    'utf8',
  );
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const z = dom.window.document.querySelector('[data-ch="z"]');
  assert.ok(z);
  z.click();
  const msg = dom.window.document.getElementById('msg').textContent;
  assert.match(msg, /silent/i);
  assert.doesNotMatch(msg, /^No Z in this word\. A ray is added\.$/);
  dom.window.close();
});

test('editing a graded answer clears its stale ✓/✗ state', async () => {
  const directory = path.resolve('apps/ipad/Resources/Examples');
  const browser = await chromium.launch({ headless: true });
  const stateOf = (page, selector) =>
    page.$eval(selector, (el) => ({
      correct: el.classList.contains('correct'),
      incorrect: el.classList.contains('incorrect'),
      mark: el.nextElementSibling?.textContent ?? '',
      invalid: el.getAttribute('aria-invalid'),
    }));
  try {
    const inputCase = async (file, correct, wrong) => {
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent(await readFile(path.join(directory, file), 'utf8'));
      await page.fill('#term', correct);
      await page.click('#check');
      assert.deepEqual(await stateOf(page, '#term'), { correct: true, incorrect: false, mark: '✓', invalid: 'false' }, file);
      await page.fill('#term', wrong);
      assert.deepEqual(await stateOf(page, '#term'), { correct: false, incorrect: false, mark: '', invalid: null }, `${file} edit clears`);
      await page.click('#check');
      assert.deepEqual(await stateOf(page, '#term'), { correct: false, incorrect: true, mark: '✗', invalid: 'true' }, `${file} regraded`);
      await page.fill('#term', correct);
      assert.deepEqual(await stateOf(page, '#term'), { correct: false, incorrect: false, mark: '', invalid: null }, `${file} cleared without regrading`);
      await page.close();
    };
    await inputCase('source-reliability-check.html', 'corroboration', 'bias');
    await inputCase('persuasive-language-lab.html', 'rhetorical question', 'alliteration');

    const selectCase = async (file, selectSelector, checkSelector) => {
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent(await readFile(path.join(directory, file), 'utf8'));
      const selects = await page.$$(selectSelector);
      for (const select of selects) {
        await select.evaluate((el) => {
          el.value = el.dataset.a ?? el.dataset.answer;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
      await page.click(checkSelector);
      const [first, second] = selects;
      const stateOfEl = (el) =>
        el.evaluate((e) => ({
          correct: e.classList.contains('correct'),
          incorrect: e.classList.contains('incorrect'),
          mark: e.nextElementSibling?.textContent ?? '',
          invalid: e.getAttribute('aria-invalid'),
        }));
      const wrong = await first.evaluate((el) =>
        [...el.options].map((o) => o.value).find((v) => v && v !== (el.dataset.a ?? el.dataset.answer)),
      );
      assert.ok(wrong, `${file} has a wrong option`);
      await first.evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, wrong);
      assert.deepEqual(await stateOfEl(first), { correct: false, incorrect: false, mark: '', invalid: null }, `${file} edit clears`);
      const other = await stateOfEl(second);
      assert.equal(other.correct, true, `${file} sibling keeps its grade`);
      assert.equal(other.mark, '✓');
      await page.click(checkSelector);
      assert.deepEqual(await stateOfEl(first), { correct: false, incorrect: true, mark: '✗', invalid: 'true' }, `${file} regraded wrong`);
      const right = await first.evaluate((el) => el.dataset.a ?? el.dataset.answer);
      await first.evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, right);
      assert.deepEqual(await stateOfEl(first), { correct: false, incorrect: false, mark: '', invalid: null }, `${file} correct edit only clears`);
      await page.close();
    };
    await selectCase('cool-box-fair-test-lab.html', '#vars select', '#checkVars');
    await selectCase('paragraph-structure-sequencer.html', '#jobs select', '#checkJ');
    await selectCase('market-street-field-notes.html', '#notes select', '#check');

    // market-street evidence select (single control, group 2)
    {
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent(await readFile(path.join(directory, 'market-street-field-notes.html'), 'utf8'));
      await page.selectOption('#evidence', 'ok');
      await page.click('#checkE');
      assert.deepEqual(await stateOf(page, '#evidence'), { correct: true, incorrect: false, mark: '✓', invalid: 'false' });
      const wrong = await page.$eval('#evidence', (el) =>
        [...el.options].map((o) => o.value).find((v) => v && v !== 'ok'),
      );
      await page.selectOption('#evidence', wrong);
      assert.deepEqual(await stateOf(page, '#evidence'), { correct: false, incorrect: false, mark: '', invalid: null }, 'evidence edit clears');
      await page.click('#checkE');
      assert.deepEqual(await stateOf(page, '#evidence'), { correct: false, incorrect: true, mark: '✗', invalid: 'true' });
      await page.selectOption('#evidence', 'ok');
      assert.deepEqual(await stateOf(page, '#evidence'), { correct: false, incorrect: false, mark: '', invalid: null }, 'evidence correct edit only clears');
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('line golf rejects a half-unit miss on a horizontal hole', async () => {
  const html = await readFile(
    path.resolve('apps/ipad/Resources/Examples/line-golf.html'),
    'utf8',
  );
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  assert.equal(dom.window.onLine(0.5, 0, 1, 1), false);
  assert.equal(dom.window.onLine(0, 1, 1, 1), true);
  assert.equal(dom.window.onLine(2, 1, 1, 3), true);
  dom.window.close();
});
