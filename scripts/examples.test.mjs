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
    '<script>navigator.serviceWorker.register("worker.js")</script>',
    '<script type="module">import confetti from "https://outside.invalid/confetti.js";</script>',
    '<style>@import"https://outside.invalid/a.css";</style>',
    '<script>const Request = XMLHttpRequest; new Request();</script>',
    '<script>const beacon = navigator; beacon.sendBeacon("/collect")</script>',
  ]) {
    const result = validateHtmlArtifact(validHtml.replace('</body>', `${snippet}</body>`));
    assert.equal(result.valid, false, snippet);
  }
});

test('accepts custom attributes and script variables the production validator accepts', () => {
  for (const snippet of [
    '<button data-action="check" data-src="pool-1" data-href="x">Go</button>',
    '<script data-src="pool-1">const pool = 1;</script>',
    '<link data-rel="stylesheet">',
    '<script>const action = event.target.dataset.action; let src = card.dataset.src; var poster = 1;</script>',
  ]) {
    assert.deepEqual(validateHtmlArtifact(validHtml.replace('</body>', `${snippet}</body>`)).issues, [], snippet);
  }
  for (const snippet of [
    '<img alt=""\nsrc="https://outside.invalid/a.png">',
    '<svg><use\nxlink:href="https://outside.invalid/a.svg#i"/></svg>',
    '<script>const image = new Image(); image.src = "https://outside.invalid/a.png";</script>',
    '<script>box.innerHTML = \'<img src="https://outside.invalid/a.png">\';</script>',
  ]) {
    assert.equal(validateHtmlArtifact(validHtml.replace('</body>', `${snippet}</body>`)).valid, false, snippet);
  }
});

test('rejects the URLs, multi-source and embedded markup the production validator rejects', () => {
  for (const snippet of [
    '<a href="">Empty</a>',
    '<a href="data:text/html,hi">Data document</a>',
    '<img alt="" src="data:image/svg+xml,<svg></svg>">',
    '<form action="#"></form>',
    '<video poster="assets/image-1"></video>',
    '<template><video poster="assets/image-1"></video></template>',
    '<script>el.setAttribute("srcset", "assets/image-1 1x");</script>',
    '<script>box.innerHTML = \'<video poster="assets/image-1">\';</script>',
    '<script>box.innerHTML = `<img\n  src="https://outside.invalid/a.png">`;</script>',
    '<script>document.body.innerHTML = `<img\nsrc="https://outside.invalid/x.png">`;</script>',
    '<p>\nhref="https://outside.invalid"</p>',
    '<iframe srcdoc="hi"></iframe>',
  ]) {
    assert.equal(validateHtmlArtifact(validHtml.replace('</body>', `${snippet}</body>`)).valid, false, snippet);
  }
  for (const snippet of [
    '<a href="#top">Top</a>',
    '<img alt="" src="data:image/png;base64,AAAA">',
    '<style>.a{fill:url(#gradient)}</style>',
    '<script>box.innerHTML = \'<button data-src="x"><img alt="" src="assets/image-1"></button>\';</script>',
    '<script>const poster = "Poster"; if (poster == "x") {}</script>',
  ]) {
    assert.deepEqual(validateHtmlArtifact(validHtml.replace('</body>', `${snippet}</body>`)).issues, [], snippet);
  }
});

test('rejects storage and Cache API references the production validator rejects', () => {
  for (const snippet of [
    '<script>localStorage.setItem("score", "1");</script>',
    '<script>const store = caches;</script>',
    '<button onclick="caches.keys()">Save</button>',
    '<template><script>caches.open("x")</script></template>',
    '<p>document.cookie</p>',
  ]) {
    assert.ok(validateHtmlArtifact(validHtml.replace('</body>', `${snippet}</body>`)).issues.some((issue) => issue.code === 'storage'), snippet);
  }
  for (const snippet of ['<p>A plant cell caches energy.</p>', '<script type="application/json">{"caches":1}</script>']) {
    assert.deepEqual(validateHtmlArtifact(validHtml.replace('</body>', `${snippet}</body>`)).issues, [], snippet);
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
  // A y guess is for the long i sound that opens "island", not a vowel the silent s replaces.
  dom.window.document.querySelector('[data-ch="y"]').click();
  assert.match(dom.window.document.getElementById('msg').textContent, /^No y\. The long i sound at the start is spelled with just i/);
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
      if (file === 'paragraph-structure-sequencer.html') {
        assert.match(await page.textContent('#jm'), /A supporting detail explains one stage of the process/);
      }
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
      assert.match(await page.textContent('#em'), /A photo shows the trees, but not whether the street got cooler/);
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

test('line golf ignores a second check while the next hole loads', async () => {
  const html = await readFile(
    path.resolve('apps/ipad/Resources/Examples/line-golf.html'),
    'utf8',
  );
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const { document } = dom.window;
  document.getElementById('m').value = '2';
  document.getElementById('c').value = '1';
  document.getElementById('check').click();
  document.getElementById('check').click();
  assert.match(document.getElementById('msg').textContent, /^All flags hit in 1 stroke,/);
  assert.equal(document.getElementById('strokes').textContent, '1');
  dom.window.close();
});

test('line golf keeps the next hole as set after Reset during the hole pause', async () => {
  const html = await readFile(
    path.resolve('apps/ipad/Resources/Examples/line-golf.html'),
    'utf8',
  );
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const { document } = dom.window;
  document.getElementById('m').value = '2';
  document.getElementById('c').value = '1';
  document.getElementById('check').click();
  document.getElementById('reset').click();
  assert.equal(document.getElementById('hole').textContent, '2');
  document.getElementById('m').value = '-1';
  document.getElementById('check').click();
  await new Promise((resolve) => { setTimeout(resolve, 1400); });
  assert.equal(document.getElementById('m').value, '-1');
  assert.equal(document.getElementById('strokes').textContent, '1');
  dom.window.close();
});

test('line golf Play again keeps keyboard focus on the course controls', async () => {
  const html = await readFile(
    path.resolve('apps/ipad/Resources/Examples/line-golf.html'),
    'utf8',
  );
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const { document } = dom.window;
  for (const [m, c] of [['2', '1'], ['-1', '2'], ['0', '1']]) {
    document.getElementById('reset').click();
    document.getElementById('m').value = m;
    document.getElementById('c').value = c;
    document.getElementById('check').click();
  }
  const again = document.getElementById('again');
  assert.equal(again.style.display, 'inline-block');
  again.focus();
  again.click();
  assert.equal(again.style.display, 'none');
  assert.equal(document.activeElement, document.getElementById('m'));
  dom.window.close();
});

test('fair-test variables and confounds give choice-specific feedback', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(await readFile('apps/ipad/Resources/Examples/cool-box-fair-test-lab.html', 'utf8'));
    await page.$$eval('#vars select', (selects) => selects.forEach((select) => {
      select.value = select.dataset.answer;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }));
    const variable = page.locator('#vars select').first();
    await variable.selectOption('same');
    await page.click('#checkVars');
    assert.equal(await page.locator('#vars .mark.correct').count(), 5);
    assert.equal(await page.locator('#vars .mark.incorrect').count(), 1);
    assert.match(await page.textContent('#vm'), /^✗ 5 of 6 correct\./);
    assert.match(await page.textContent('#vm'), /If this were different for each bottle, could you still tell which lining worked\?/);
    assert.equal(await variable.getAttribute('aria-invalid'), 'true');
    await variable.selectOption('changed');
    assert.deepEqual(await variable.evaluate((el) => ({
      incorrect: el.classList.contains('incorrect'),
      mark: el.nextElementSibling?.textContent ?? '',
      invalid: el.getAttribute('aria-invalid'),
    })), { incorrect: false, mark: '', invalid: null });

    const confound = page.locator('input[data-spoil="1"]').first();
    await confound.check();
    await page.click('#diagnose');
    assert.match(await page.textContent('#dm'), /^✗ You have found 1 of 2\./);
    assert.equal(await confound.evaluate((el) => el.nextElementSibling.textContent), '✓');
    const irrelevant = page.locator('input[data-spoil="0"]').first();
    await irrelevant.check();
    await page.click('#diagnose');
    assert.match(await page.textContent('#dm'), /A tick marked ✗ is part of a fair test/);
    assert.equal(await irrelevant.evaluate((el) => el.nextElementSibling.textContent), '✗');
    await irrelevant.uncheck();
    assert.deepEqual(await irrelevant.evaluate((el) => ({
      mark: el.nextElementSibling?.textContent ?? '',
      invalid: el.getAttribute('aria-invalid'),
    })), { mark: '', invalid: null });
    await page.close();
  } finally {
    await browser.close();
  }
});

test('named-technique hints change on each wrong attempt', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [file, answer] of [
      ['persuasive-language-lab.html', 'rhetorical question'],
      ['source-reliability-check.html', 'corroboration'],
    ]) {
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent(await readFile(`apps/ipad/Resources/Examples/${file}`, 'utf8'));
      await page.fill('#term', 'wrong guess');
      const hints = new Set();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await page.click('#check');
        const message = await page.textContent('#tm');
        assert.match(message, /^✗ Try again\./, file);
        hints.add(message);
      }
      assert.equal(hints.size, 3, file);
      await page.fill('#term', answer);
      await page.click('#check');
      assert.match(await page.textContent('#tm'), /^✓ Correct!/, file);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('named techniques accept a trailing full stop and doubled spaces', async () => {
  for (const [file, answer] of [
    ['persuasive-language-lab.html', 'Rhetorical  question. '],
    ['source-reliability-check.html', 'Corroboration. '],
  ]) {
    const html = await readFile(path.resolve(`apps/ipad/Resources/Examples/${file}`), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
    const { document } = dom.window;
    document.getElementById('term').value = answer;
    document.getElementById('check').click();
    assert.match(document.getElementById('tm').textContent, /^✓ Correct!/, file);
    dom.window.close();
  }
});

test('source check feedback explains the wrong option the student chose', async () => {
  const html = await readFile(path.resolve('apps/ipad/Resources/Examples/source-reliability-check.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const { document } = dom.window;
  const [copy, rumour] = [...document.querySelectorAll('[data-kind="check"] button:not([data-ok])')];
  const feedback = () => document.querySelector('[data-kind="check"]').nextElementSibling.textContent;
  rumour.click();
  assert.match(feedback(), /^✗ Try again\. An anonymous rumour/);
  assert.doesNotMatch(feedback(), /copy/);
  copy.click();
  assert.match(feedback(), /^✗ Try again\. A bigger copy/);
  document.querySelector('[data-kind="check"] [data-ok]').click();
  assert.match(feedback(), /^✓ Correct!/);
  dom.window.close();
});

test('plant-cell matches are listed as structure beside job', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(await readFile('apps/ipad/Resources/Examples/plant-cell-hotspots.html', 'utf8'));
    await page.locator('.hot').evaluateAll((spots) => spots.forEach((spot) => spot.click()));
    await page.click('#picks [data-s="3"]');
    await page.click('#jobs [data-j="1"]');
    assert.equal(await page.locator('#matchedList .match-row').count(), 0);
    assert.match(await page.textContent('#feedback'), /^✗ /);
    await page.click('#jobs [data-j="3"]');
    assert.equal(await page.locator('#matchedList .match-row').count(), 1);
    assert.match(await page.textContent('#matchedList .match-row'), /^Nucleus→Contains genetic material/);
    assert.equal(await page.getAttribute('#panel', 'aria-live'), 'polite', 'tapped structure names are announced');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('plant-cell wall and membrane markers sit on their own layers at every width', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [390, 820, 1024]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.route('**/*', (route) => route.abort());
      await page.setContent(await readFile('apps/ipad/Resources/Examples/plant-cell-hotspots.html', 'utf8'));
      const [wall, membrane] = await page.evaluate(() => {
        const cell = document.querySelector('.cell').getBoundingClientRect();
        return [0, 1].map((index) => {
          const spot = document.querySelector(`.hot[data-i="${index}"]`).getBoundingClientRect();
          return spot.left + spot.width / 2 - cell.left;
        });
      });
      assert.ok(wall >= 0 && wall <= 18, `cell wall marker centre ${wall}px is on the 18px wall at ${width}px`);
      assert.ok(membrane > wall && membrane <= 25, `membrane marker centre ${membrane}px is just inside the wall at ${width}px`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('mean-and-median scores can be moved without dragging', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(await readFile('apps/ipad/Resources/Examples/mean-and-median.html', 'utf8'));
    const score = page.getByRole('slider', { name: 'Score 1', exact: true });
    assert.equal(await page.getByRole('slider').count(), 7);
    await score.focus();
    for (let press = 0; press < 8; press += 1) await page.keyboard.press('ArrowRight');
    assert.equal(await score.getAttribute('aria-valuenow'), '11');
    assert.equal(await page.textContent('#mean'), '7.0');
    await page.selectOption('#which', 'mean');
    await page.selectOption('#why', 'all');
    await page.click('#check');
    assert.match(await page.textContent('#feedback'), /^The mean was pulled/);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('mean-and-median keeps every dot inside the plot when all seven scores match', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(await readFile('apps/ipad/Resources/Examples/mean-and-median.html', 'utf8'));
    const moves = { 'Score 1': 'ArrowRight', 'Score 6': 'ArrowLeft', 'Score 7': 'ArrowLeft' };
    for (const [name, key] of Object.entries(moves)) {
      await page.getByRole('slider', { name, exact: true }).focus();
      await page.keyboard.press(key);
    }
    const tops = await page.$$eval('#dots circle', (dots) => dots.map((dot) => dot.cy.baseVal.value - dot.r.baseVal.value));
    assert.equal(tops.length, 7);
    for (const top of tops) assert.ok(top >= 0, `a dot's top edge at y=${top} is cut off above the plot`);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('shadow lamp beam starts at the lamp wherever the lamp is moved', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(await readFile('apps/ipad/Resources/Examples/where-the-shadow-falls.html', 'utf8'));
    const offset = () => page.evaluate(() => {
      const bulb = document.querySelector('#lamp circle').getBoundingClientRect();
      const beam = document.getElementById('beam').getBoundingClientRect();
      return Math.abs(beam.left - (bulb.left + bulb.width / 2));
    });
    assert.ok(await offset() < 1, 'starting beam apex is at the lamp');
    await page.focus('#lamp');
    for (let press = 0; press < 6; press += 1) await page.keyboard.press('ArrowRight');
    assert.ok(await offset() < 1, 'moved beam apex follows the lamp');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('shadow lamp is exposed as a slider that reports where the lamp is', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(await readFile('apps/ipad/Resources/Examples/where-the-shadow-falls.html', 'utf8'));
    const lamp = page.getByRole('slider', { name: 'Drag lamp left or right' });
    assert.equal(await lamp.getAttribute('aria-valuetext'), 'left of the object');
    await lamp.focus();
    for (let press = 0; press < 12; press += 1) await page.keyboard.press('ArrowRight');
    assert.equal(await lamp.getAttribute('aria-valuenow'), '360');
    assert.equal(await lamp.getAttribute('aria-valuetext'), 'above the object');
    for (let press = 0; press < 4; press += 1) await page.keyboard.press('ArrowRight');
    assert.equal(await lamp.getAttribute('aria-valuetext'), 'right of the object');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('shadow rays never pass through the opaque object', async () => {
  const html = await readFile(
    path.resolve('apps/ipad/Resources/Examples/where-the-shadow-falls.html'),
    'utf8',
  );
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const { document, KeyboardEvent } = dom.window;
  document.querySelector('[data-value="right"]').click();
  document.querySelector('[data-value="long"]').click();
  document.getElementById('check').click();
  const lamp = document.getElementById('lamp');
  const press = (key) => lamp.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  for (let step = 0; step < 6; step += 1) press('ArrowLeft');
  for (let step = 0; step < 40; step += 1) {
    for (const id of ['ray1', 'ray2']) {
      const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((name) => +document.getElementById(id).getAttribute(name));
      for (let t = 0; t <= 1; t += 0.01) {
        const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
        assert.ok(!(x > 336 && x < 394 && y > 146 && y < 249), `${id} enters the object at lamp step ${step}: (${x}, ${y})`);
      }
    }
    press('ArrowRight');
  }
  dom.window.close();
});

test('shadow readout names the side the shadow actually falls on', async () => {
  const html = await readFile(
    path.resolve('apps/ipad/Resources/Examples/where-the-shadow-falls.html'),
    'utf8',
  );
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const { document, KeyboardEvent } = dom.window;
  document.querySelector('[data-value="right"]').click();
  document.querySelector('[data-value="long"]').click();
  document.getElementById('check').click();
  const lamp = document.getElementById('lamp');
  const moveRight = (presses) => {
    for (let press = 0; press < presses; press += 1) lamp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    return document.getElementById('direction').textContent;
  };
  // The lamp starts at x 180; the object spans x 335 to 395.
  assert.equal(moveRight(10), 'right', 'lamp at 330, left of the object');
  assert.equal(moveRight(1), 'under', 'lamp at 345, above the object');
  assert.equal(moveRight(4), 'left', 'lamp at 405, right of the object');
  dom.window.close();
});

test('ordering feedback marks each step, clears on moves, and counts correct positions', async () => {
  const cases = [
    { file: 'cool-box-fair-test-lab.html', list: '#steps', check: '#checkSteps', message: '#sm', move: 1, marks: ['✓', '✗', '✗', '✗', '✗'], count: '1 of 5' },
    { file: 'market-street-field-notes.html', list: '#steps', check: '#checkS', message: '#sm', move: 1, marks: ['✓', '✗', '✗', '✗'], count: '1 of 4' },
    { file: 'paragraph-structure-sequencer.html', list: '#order', check: '#checkO', message: '#om', move: 3, marks: ['✗', '✓', '✓', '✗'], count: '2 of 4' },
  ];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const example of cases) {
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent(await readFile(`apps/ipad/Resources/Examples/${example.file}`, 'utf8'));
      await page.click(example.check);
      const initialMarks = await page.$$eval(`${example.list} [data-order-step]`, (steps) =>
        steps.map((step) => step.nextElementSibling?.classList.contains('mark') ? step.nextElementSibling.textContent : ''),
      );
      assert.equal(initialMarks.length, example.marks.length, example.file);
      await page.click(`${example.list} button[data-i="${example.move}"]`);
      assert.equal(await page.textContent(example.message), '', `${example.file} move clears feedback`);
      const cleared = await page.$$eval(`${example.list} [data-order-step]`, (steps) =>
        steps.map((step) => ({
          mark: step.nextElementSibling?.classList.contains('mark') ? step.nextElementSibling.textContent : '',
          invalid: step.getAttribute('aria-invalid'),
        })),
      );
      assert.deepEqual(cleared, example.marks.map(() => ({ mark: '', invalid: null })), `${example.file} move clears step marks`);
      await page.click(example.check);
      const marks = await page.$$eval(`${example.list} [data-order-step]`, (steps) =>
        steps.map((step) => step.nextElementSibling?.classList.contains('mark') ? step.nextElementSibling.textContent : ''),
      );
      assert.deepEqual(marks, example.marks, example.file);
      assert.match(await page.textContent(example.message), new RegExp(`^✗ ${example.count} steps are in the right place\\.`), example.file);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('moving a step up keeps keyboard focus on the moved step', async () => {
  const cases = [
    { file: 'cool-box-fair-test-lab.html', list: '#steps' },
    { file: 'market-street-field-notes.html', list: '#steps' },
    { file: 'paragraph-structure-sequencer.html', list: '#order' },
  ];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const example of cases) {
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent(await readFile(`apps/ipad/Resources/Examples/${example.file}`, 'utf8'));
      const stepText = (index) => page.$$eval(`${example.list} [data-order-step]`, (steps, i) => steps[i].textContent.replace(/^\d+\. /, ''), index);
      const moving = await stepText(2);
      await page.focus(`${example.list} button[data-i="2"]`);
      await page.keyboard.press('Enter');
      assert.equal(await stepText(1), moving, `${example.file} first press moves the step`);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.i), '1', `${example.file} focus follows the step`);
      await page.keyboard.press('Enter');
      assert.equal(await stepText(0), moving, `${example.file} second press moves it again`);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.i), '1', `${example.file} focus stays in the list`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('town budget shares never go negative while dragging sliders', async () => {
  const html = await readFile(
    path.resolve('apps/ipad/Resources/Examples/town-council-budget.html'),
    'utf8',
  );
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const { document, Event } = dom.window;
  const shares = () => ['estate', 'clinic', 'youth', 'lifts']
    .map((id) => Number.parseInt(document.getElementById(`${id}Value`).textContent, 10));
  const drag = (id, to) => {
    const input = document.getElementById(id);
    const step = to > +input.value ? 1 : -1;
    for (let value = +input.value; value !== to;) {
      value += step;
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const values = shares();
      assert.ok(values.every((share) => share >= 0), `${id} ${value}: ${values.join(', ')}`);
      assert.equal(values.reduce((sum, share) => sum + share, 0), 100, `${id} ${value}`);
    }
  };
  drag('lifts', 0);
  drag('youth', 100);
  drag('youth', 0);
  dom.window.close();
});

test('town budget accepts either group when two are hit equally hard', async () => {
  const html = await readFile(
    path.resolve('apps/ipad/Resources/Examples/town-council-budget.html'),
    'utf8',
  );
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const { document } = dom.window;
  // 50 min clinic wait and 50% lift breakdown risk are the joint worst outcomes.
  dom.window.eval('values.splice(0, 4, 33, 15, 30, 22); draw();');
  assert.equal(document.getElementById('waitText').textContent, '50 min');
  assert.equal(document.getElementById('riskText').textContent, '50%');
  for (const group of ['clinic', 'lifts']) {
    document.querySelector(`[data-group="${group}"]`).click();
    assert.match(document.getElementById('feedback').textContent, /^✓ Correct!/, group);
  }
  document.querySelector('[data-group="youth"]').click();
  assert.match(document.getElementById('feedback').textContent, /^✗ Try again\./);
  dom.window.close();
});

test('conductor sort feedback uses the right article for each bin', async () => {
  const html = await readFile(
    path.resolve('apps/ipad/Resources/Examples/conductor-or-insulator.html'),
    'utf8',
  );
  for (const [item, wrongBin, miss, expected] of [
    ['Copper coin', 'insulator', /^Not an insulator\./, /Copper coin is a conductor\./],
    ['Rubber band', 'conductor', /^Not a conductor\./, /Rubber band is an insulator\./],
  ]) {
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
    const { document } = dom.window;
    for (let life = 0; life < 3; life += 1) {
      [...document.querySelectorAll('#items button')].find((button) => button.textContent === item).click();
      document.querySelector(`[data-bin="${wrongBin}"]`).click();
      if (life === 0) assert.match(document.getElementById('msg').textContent, miss);
    }
    assert.match(document.getElementById('msg').textContent, expected);
    dom.window.close();
  }
});

test('choosing a conductor object keeps keyboard focus on that object', async () => {
  const html = await readFile(
    path.resolve('apps/ipad/Resources/Examples/conductor-or-insulator.html'),
    'utf8',
  );
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const { document } = dom.window;
  const foil = () => [...document.querySelectorAll('#items button')].find((button) => button.textContent === 'Aluminium foil');
  foil().focus();
  foil().click();
  assert.equal(document.activeElement, foil());
  assert.equal(foil().getAttribute('aria-pressed'), 'true');
  dom.window.close();
});

test('conductor Try again keeps keyboard focus on the objects', async () => {
  const html = await readFile(
    path.resolve('apps/ipad/Resources/Examples/conductor-or-insulator.html'),
    'utf8',
  );
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const { document } = dom.window;
  for (let life = 0; life < 3; life += 1) {
    [...document.querySelectorAll('#items button')].find((button) => button.textContent === 'Copper coin').click();
    document.querySelector('[data-bin="insulator"]').click();
  }
  const again = document.getElementById('again');
  assert.equal(again.style.display, 'block');
  again.focus();
  again.click();
  assert.equal(again.style.display, 'none');
  assert.equal(document.activeElement, document.querySelector('#items button'));
  dom.window.close();
});

test('answering a times-tables question keeps keyboard focus on the next choices', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(await readFile('apps/ipad/Resources/Examples/times-tables-lightning.html', 'utf8'));
    const answer = () => page.$eval('#q', (q) => {
      const [a, b] = q.textContent.match(/\d+/g).map(Number);
      return String(a * b);
    });
    const right = await answer();
    await page.locator('#choices button', { hasText: new RegExp(`^${right}$`) }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#choices button:disabled'));
    assert.equal(await page.evaluate(() => document.activeElement?.closest('#choices') !== null && !document.activeElement.disabled), true);

    await page.evaluate(() => document.activeElement.blur());
    await page.$eval('#choices button', (button) => button.click());
    await page.waitForFunction(() => !document.querySelector('#choices button:disabled'));
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true, 'a tap without focus does not move focus');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('times-tables round changes keep keyboard focus on the next control', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(await readFile('apps/ipad/Resources/Examples/times-tables-lightning.html', 'utf8'));
    const answer = () => page.$eval('#q', (q) => {
      const [a, b] = q.textContent.match(/\d+/g).map(Number);
      return String(a * b);
    });
    const focused = () => page.evaluate(() => (document.activeElement?.closest('#choices') ? 'choice' : document.activeElement?.id));
    const right = await answer();
    await page.locator('#choices button', { hasText: new RegExp(`^(?!${right}$)\\d+$`) }).first().focus();
    await page.keyboard.press('Enter');
    await page.evaluate('time = 0');
    await page.waitForSelector('#end', { state: 'visible' });
    assert.equal(await focused(), 'review', 'time running out mid-answer moves focus to Practise missed facts');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'choice', 'Practise missed facts moves focus to the choices');
    await page.locator('#choices button', { hasText: new RegExp(`^${await answer()}$`) }).focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#again-play', { state: 'visible' });
    assert.equal(await focused(), 'again-play', 'finishing the review moves focus to Play again');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'choice', 'Play again moves focus to the choices');
    await page.evaluate('time = 1');
    await page.waitForSelector('#end', { state: 'visible' });
    assert.equal(await focused(), 'again', 'time running out between answers moves focus to Play again');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'choice', 'Play again after time up moves focus to the choices');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('guessing a spelling letter keeps keyboard focus on the letter keys', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(await readFile('apps/ipad/Resources/Examples/spell-it-before-the-sun-sets.html', 'utf8'));
    const focused = () => page.evaluate(() => document.activeElement?.dataset.ch ?? document.activeElement?.id);
    await page.focus('[data-ch="m"]');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'n', 'a miss moves focus to the next key');
    await page.focus('[data-ch="z"]');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'a', 'the last key wraps to the first key');
    for (const ch of ['i', 's', 'l', 'a', 'n', 'd']) {
      await page.focus(`[data-ch="${ch}"]`);
      await page.keyboard.press('Enter');
    }
    assert.equal(await focused(), 'next', 'a finished word moves focus to Next word');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'a', 'Next word moves focus to the new letter keys');
    for (const word of ['enough', 'science', 'receipt', 'friend', 'rhythm']) {
      for (const ch of new Set(word)) {
        await page.focus(`[data-ch="${ch}"]`);
        await page.keyboard.press('Enter');
      }
      assert.equal(await focused(), 'next');
      await page.keyboard.press('Enter');
    }
    assert.equal(await focused(), 'again', 'Next word after the last word moves focus to Play again');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'a', 'Play again moves focus to the letter keys');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('every curated control has an accessible name', async () => {
  const directory = path.resolve('apps/ipad/Resources/Examples');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.html'));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const file of files) {
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent(await readFile(path.join(directory, file), 'utf8'));
      const unnamed = (await page.locator('body').ariaSnapshot())
        .split('\n')
        .filter((line) => /^\s*- (?:button|checkbox|combobox|listbox|radio|slider|spinbutton|textbox)(?: \[[^\]]*\])*:?$/.test(line));
      assert.deepEqual(unnamed, [], file);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('cutting part of the reason is called out as cutting a key fact', async () => {
  const html = await readFile(path.resolve('apps/ipad/Resources/Examples/cut-extra-words.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const { document } = dom.window;
  [...document.querySelectorAll('#editor .token')].find((token) => token.textContent === 'it keeps tables clear').click();
  document.getElementById('check').click();
  assert.match(document.getElementById('feedback').textContent, /^A key fact was cut\..*\bwhy the rule helps\.$/);
  dom.window.close();
});

test('fraction divisor feedback does not deny that dividing both parts keeps the value', async () => {
  const html = await readFile(path.resolve('apps/ipad/Resources/Examples/fraction-equivalence-diagnostic.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const { document } = dom.window;
  for (const divisor of ['3', '4']) {
    document.querySelector(`#q3 [data-d="${divisor}"]`).click();
    const feedback = document.getElementById('f3').textContent;
    // 4÷3 over 2 and 1 over 1.5 still equal 2/3; only the whole-number parts differ.
    assert.doesNotMatch(feedback, /not 2\/3/);
    assert.match(feedback, /not 2 and 3\./);
  }
  dom.window.close();
});

test('inclusive-language feedback describes the notice\'s action, not a clean-up', async () => {
  const html = await readFile(path.resolve('apps/ipad/Resources/Examples/persuasive-language-lab.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://artifact.invalid/' });
  const { document } = dom.window;
  const item = document.querySelector('.item');
  item.querySelector('button[data-ok]').click();
  const feedback = item.querySelector('.msg').textContent;
  // The notice asks readers to bring their own containers to cut waste.
  assert.doesNotMatch(feedback, /clean-up/);
  assert.match(feedback, /cutting waste/);
  dom.window.close();
});

test('no curated control sits inside an image, whose children assistive tech hides', async () => {
  const directory = path.resolve('apps/ipad/Resources/Examples');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.html'));
  for (const file of files) {
    const dom = new JSDOM(await readFile(path.join(directory, file), 'utf8'));
    const hidden = [...dom.window.document.querySelectorAll(
      '[role="img"] :is(button, input, select, textarea, a[href], [tabindex], [role="button"])',
    )].map((control) => control.outerHTML.slice(0, 60));
    assert.deepEqual(hidden, [], file);
    dom.window.close();
  }
});

test('tap-to-select corpus controls expose their pressed state', async () => {
  const pressed = (document) => [...document.querySelectorAll('[aria-pressed="true"]')].map((el) => el.textContent);
  const load = async (file) => new JSDOM(
    await readFile(path.resolve(`apps/ipad/Resources/Examples/${file}`), 'utf8'),
    { runScripts: 'dangerously', url: 'https://artifact.invalid/' },
  );

  const cut = await load('cut-extra-words.html');
  const tokens = [...cut.window.document.querySelectorAll('#editor .token')];
  assert.ok(tokens.every((token) => token.getAttribute('aria-pressed') === 'false'));
  const padding = tokens.find((token) => token.textContent === 'very important and useful');
  padding.click();
  assert.deepEqual(pressed(cut.window.document), ['very important and useful']);
  padding.click();
  assert.deepEqual(pressed(cut.window.document), []);
  padding.click();
  cut.window.document.getElementById('reset').click();
  assert.deepEqual(pressed(cut.window.document), []);
  cut.window.close();

  const shadow = await load('where-the-shadow-falls.html');
  const { document } = shadow.window;
  const choice = (question, value) => document.querySelector(`[data-question="${question}"] [data-value="${value}"]`);
  assert.ok([...document.querySelectorAll('.choices button')].every((button) => button.getAttribute('aria-pressed') === 'false'));
  choice('direction', 'left').click();
  choice('direction', 'right').click();
  choice('length', 'long').click();
  assert.deepEqual(pressed(document), ['right', 'long']);
  document.getElementById('reset').click();
  assert.deepEqual(pressed(document), []);
  shadow.window.close();

  const cell = await load('plant-cell-hotspots.html');
  const cellDocument = cell.window.document;
  cellDocument.querySelectorAll('.hot').forEach((spot) => spot.click());
  assert.ok([...cellDocument.querySelectorAll('#picks button')].every((button) => button.getAttribute('aria-pressed') === 'false'));
  cellDocument.querySelector('#picks [data-s="4"]').click();
  cellDocument.querySelector('#picks [data-s="3"]').click();
  assert.deepEqual(pressed(cellDocument), ['Nucleus']);
  cellDocument.querySelector('#jobs [data-j="3"]').click();
  assert.deepEqual(pressed(cellDocument), []);
  cellDocument.querySelector('#picks [data-s="0"]').click();
  cellDocument.getElementById('reset').click();
  assert.deepEqual(pressed(cellDocument), []);
  cell.window.close();
});
