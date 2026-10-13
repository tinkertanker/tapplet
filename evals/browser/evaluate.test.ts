import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateHtmlInBrowser } from "./evaluate";

const goodFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Browser evaluator fixture</title><style>*{box-sizing:border-box}body{font:16px system-ui;margin:0}main{max-width:40rem;margin:auto;padding:16px}button{min-width:120px;min-height:48px;font:inherit}</style></head><body><main><h1>Browser evaluator fixture</h1><button id="check" type="button">Check answer</button><p id="feedback" aria-live="polite"></p></main><script>document.getElementById('check').addEventListener('click',()=>{document.getElementById('feedback').textContent='Correct';document.body.dataset.checked='yes'})</script></body></html>`;

const badFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bad fixture</title><style>body{width:1400px;font-size:10px}button{width:20px;height:20px}</style></head><body><main><h1>Bad fixture</h1><button id="same"></button><button id="same">B</button><img src="assets/example"><script>fetch('https://example.invalid/student?q=private').catch(()=>{});setTimeout(()=>{throw new Error('private content')},75)</script></main></body></html>`;
const inertFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Inert fixture</title><style>body{font:16px system-ui}button{min-width:120px;min-height:48px}</style></head><body><main><h1>Inert fixture</h1><button type="button">Does nothing</button></main></body></html>`;
const nativeStateFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Native state fixture</title><style>body{font:16px system-ui}input{width:44px;height:44px}</style></head><body><main><h1>Native state fixture</h1><label><input type="checkbox"> Ready</label></main></body></html>`;
const delayedFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Delayed fixture</title><style>body{font:16px system-ui}button{min-width:120px;min-height:48px}</style></head><body><main><h1>Delayed fixture</h1><button id="check" type="button">Check</button><p id="feedback" aria-live="polite"></p></main><script>check.onclick=()=>setTimeout(()=>{feedback.textContent='Ready';document.body.dataset.ready='yes'},75)</script></body></html>`;
const mixedFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mixed fixture</title><style>body{font:16px system-ui}button{min-width:120px;min-height:48px}</style></head><body><main><h1>Mixed fixture</h1><button id="works" type="button">Works</button><button type="button">Inert one</button><button type="button">Inert two</button><button type="button">Inert three</button><button type="button">Inert four</button></main><script>const workingButton=document.getElementById('works');workingButton.onclick=()=>{workingButton.textContent='Changed'}</script></body></html>`;
const hiddenTextFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hidden text fixture</title><style>body{font:16px system-ui}</style></head><body><main><h1>Hidden text fixture</h1><p>Visible lesson text</p></main><script>const hiddenContractTerm='fraction';</script></body></html>`;
const visuallyHiddenTextFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Visually hidden text fixture</title><style>body{font:16px system-ui}.hidden{opacity:0;position:fixed;left:-9999px}</style></head><body><main><h1>Visually hidden text fixture</h1><p>Visible lesson text</p><span class="hidden">fraction</span></main></body></html>`;
const windowNameFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Window name fixture</title><style>body{font:16px system-ui}button{min-width:120px;min-height:48px}</style></head><body><main><h1>Window name fixture</h1><button id="remember" type="button">Remember</button></main><script>if(window.name==='remembered')document.body.dataset.inherited='yes';document.getElementById('remember').onclick=()=>{window.name='remembered';document.getElementById('remember').textContent='Remembered'}</script></body></html>`;
const sameOriginFetchFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Same-origin fetch fixture</title><style>body{font:16px system-ui}</style></head><body><main><h1>Same-origin fetch fixture</h1></main><script>fetch('/').catch(()=>{})</script></body></html>`;
const unreachableFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unreachable fixture</title><style>html,body{height:100%;overflow:hidden}body{font:16px system-ui}button{position:fixed;top:900px;min-width:120px;min-height:48px}</style></head><body><main><h1>Unreachable fixture</h1><button type="button" onclick="this.textContent='Changed'">Unreachable</button></main></body></html>`;

test("browser evaluator executes deterministic interactions without retaining source", async () => {
  const result = await evaluateHtmlInBrowser(goodFixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
    scenarios: [{
      name: "check answer",
      actions: [{ type: "click", selector: "#check" }],
      assertions: [
        { selector: "#feedback", textIncludes: "Correct" },
        { selector: "body", attribute: { name: "data-checked", value: "yes" } },
      ],
    }],
  });

  assert.equal(result.passed, true);
  assert.equal(result.viewports[0]?.behavior.scenarios[0]?.passed, true);
  assert.equal(result.viewports[0]?.behavior.scenarios[0]?.stateChanged, true);
  assert.doesNotMatch(JSON.stringify(result), /Browser evaluator fixture|Correct/);
});

test("browser evaluator reports sandbox, accessibility, viewport, and runtime failures as metadata", async () => {
  const result = await evaluateHtmlInBrowser(badFixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
  });
  const viewport = result.viewports[0]!;

  assert.equal(result.passed, false);
  assert.equal(viewport.sandbox.passed, false);
  assert.ok(viewport.sandbox.cspViolationCount > 0);
  assert.equal(viewport.accessibilityBasic.passed, false);
  assert.ok(viewport.accessibilityBasic.duplicateIdCount > 0);
  assert.ok(viewport.accessibilityBasic.imageMissingAltCount > 0);
  assert.equal(viewport.viewportFit.passed, false);
  assert.ok(viewport.viewportFit.horizontalOverflowPixels > 0);
  assert.ok(viewport.behavior.pageErrorCount > 0);
  assert.equal(viewport.renderedQuality.passed, false);
  assert.doesNotMatch(JSON.stringify(result), /private content|student\?q/);
});

test("browser evaluator rejects inert controls and observes bounded delayed behavior", async () => {
  const inert = await evaluateHtmlInBrowser(inertFixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
  });
  assert.equal(inert.viewports[0]?.behavior.changedControlCount, 0);
  assert.equal(inert.viewports[0]?.behavior.passed, false);

  const nativeState = await evaluateHtmlInBrowser(nativeStateFixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
  });
  assert.equal(nativeState.viewports[0]?.behavior.changedControlCount, 1);
  assert.equal(nativeState.viewports[0]?.behavior.passed, true);

  const delayed = await evaluateHtmlInBrowser(delayedFixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
    scenarios: [{
      name: "delayed feedback",
      actions: [{ type: "click", selector: "#check" }],
      assertions: [
        { selector: "#feedback", textIncludes: "Ready" },
        { selector: "body", attribute: { name: "data-ready", value: "yes" } },
      ],
    }],
  });
  assert.equal(delayed.viewports[0]?.behavior.scenarios[0]?.passed, true);
  assert.equal(delayed.viewports[0]?.behavior.scenarios[0]?.stateChanged, true);
  assert.equal(delayed.viewports[0]?.behavior.changedControlCount, 1);
  assert.equal(delayed.viewports[0]?.behavior.passed, true);
});

test("generic interactions distinguish autonomous timers from synchronous and delayed handlers", async () => {
  const timer = `<p id="clock"></p><script>let ticks=0;setInterval(()=>{document.getElementById('clock').textContent=String(++ticks)},20)</script>`;
  const fixtures = [
    { html: inertFixture, changed: 0, passed: false },
    { html: goodFixture, changed: 1, passed: true },
    { html: delayedFixture, changed: 1, passed: true },
  ];
  for (const fixture of fixtures) {
    const result = await evaluateHtmlInBrowser(fixture.html.replace('</body>', `${timer}</body>`), {
      viewports: [{ name: "phone", width: 390, height: 844 }],
    });
    assert.equal(result.viewports[0]?.behavior.changedControlCount, fixture.changed);
    assert.equal(result.viewports[0]?.behavior.passed, fixture.passed);
    assert.equal(result.passed, fixture.passed);
  }
});

test("generic interactions compare randomized starting states without crediting autonomous changes", async () => {
  const randomTimer = `<p id="question"></p><p id="clock"></p><script>question.textContent=String(Math.random());let ticks=0;setInterval(()=>{clock.textContent=String(++ticks)},20)</script>`;
  for (const fixture of [
    { html: goodFixture, changed: 1 },
    { html: inertFixture, changed: 0 },
  ]) {
    const result = await evaluateHtmlInBrowser(fixture.html.replace("</body>", `${randomTimer}</body>`), {
      viewports: [{ name: "phone", width: 390, height: 844 }],
    });
    assert.equal(result.viewports[0]?.behavior.changedControlCount, fixture.changed);
    assert.equal(result.passed, fixture.changed === 1);
  }
});

test("generic interactions recognize the randomized times-tables seed", async () => {
  const html = await readFile(new URL("../../apps/ipad/Resources/Examples/times-tables-lightning.html", import.meta.url), "utf8");
  const result = await evaluateHtmlInBrowser(html, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
  });
  assert.equal(result.viewports[0]?.behavior.interactionPassRate, 1);
  assert.equal(result.viewports[0]?.behavior.passed, true);
});

test("browser evaluator isolates controls and requires most exercised controls to change", async () => {
  const result = await evaluateHtmlInBrowser(mixedFixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
  });

  assert.equal(result.viewports[0]?.behavior.exercisedControlCount, 5);
  assert.equal(result.viewports[0]?.behavior.changedControlCount, 1);
  assert.equal(result.viewports[0]?.behavior.interactionPassRate, 0.2);
  assert.equal(result.viewports[0]?.behavior.passed, false);
});

test("browser evaluator resets declarative scenarios and checks rendered text", async () => {
  const isolated = await evaluateHtmlInBrowser(goodFixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
    scenarios: [
      {
        name: "mutate the page",
        actions: [{ type: "click", selector: "#check" }],
        assertions: [{ selector: "body", attribute: { name: "data-checked", value: "yes" } }],
      },
      {
        name: "must not inherit prior state",
        actions: [],
        assertions: [{ selector: "body", attribute: { name: "data-checked", value: "yes" } }],
      },
    ],
  });
  assert.equal(isolated.viewports[0]?.behavior.scenarios[0]?.passed, true);
  assert.equal(isolated.viewports[0]?.behavior.scenarios[1]?.passed, false);

  const renderedText = await evaluateHtmlInBrowser(hiddenTextFixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
    scenarios: [{
      name: "visible content",
      actions: [],
      assertions: [{ selector: "body", textIncludes: "fraction" }],
    }],
  });
  assert.equal(renderedText.viewports[0]?.behavior.scenarios[0]?.passed, false);

  const visuallyHiddenText = await evaluateHtmlInBrowser(visuallyHiddenTextFixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
    scenarios: [{
      name: "visually hidden content",
      actions: [],
      assertions: [{ selector: "body", textIncludes: "fraction", visible: true }],
    }],
  });
  assert.equal(visuallyHiddenText.viewports[0]?.behavior.scenarios[0]?.passed, false);

  const browsingContext = await evaluateHtmlInBrowser(windowNameFixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
    scenarios: [
      {
        name: "set browsing-context state",
        actions: [{ type: "click", selector: "#remember" }],
        assertions: [],
      },
      {
        name: "must use a fresh browsing context",
        actions: [],
        assertions: [{ selector: "body", attribute: { name: "data-inherited", value: "yes" } }],
      },
    ],
  });
  assert.equal(browsingContext.viewports[0]?.behavior.scenarios[0]?.passed, true);
  assert.equal(browsingContext.viewports[0]?.behavior.scenarios[1]?.passed, false);
});

test("browser evaluator blocks same-origin API-shaped requests and rejects unreachable controls", async () => {
  const network = await evaluateHtmlInBrowser(sameOriginFetchFixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
  });
  assert.equal(network.viewports[0]?.sandbox.passed, false);
  assert.ok((network.viewports[0]?.sandbox.sameOriginUnexpectedRequestCount ?? 0) > 0);

  const unreachable = await evaluateHtmlInBrowser(unreachableFixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
  });
  assert.equal(unreachable.viewports[0]?.viewportFit.controlsOutsideInitialViewport, 1);
  assert.ok((unreachable.viewports[0]?.behavior.interactionErrorCount ?? 0) > 0);
  assert.equal(unreachable.viewports[0]?.behavior.passed, false);
  assert.equal(unreachable.passed, false);
});

test("browser evaluator does not name an unlabelled select after its options", async () => {
  const fixture = (select: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Select name fixture</title><style>body{font:16px system-ui}select{min-width:120px;min-height:48px}</style></head><body><main><h1>Select name fixture</h1><p id="question">Which evidence tests the claim?</p>${select}</main></body></html>`;
  const unlabelled = await evaluateHtmlInBrowser(
    fixture('<select><option value="">Choose…</option><option>Temperatures</option></select>'),
    { viewports: [{ name: "phone", width: 390, height: 844 }] },
  );
  assert.equal(unlabelled.viewports[0]?.accessibilityBasic.unnamedControlCount, 1);
  assert.equal(unlabelled.viewports[0]?.accessibilityBasic.passed, false);

  const labelled = await evaluateHtmlInBrowser(
    fixture('<select aria-labelledby="question"><option value="">Choose…</option><option>Temperatures</option></select>'),
    { viewports: [{ name: "phone", width: 390, height: 844 }] },
  );
  assert.equal(labelled.viewports[0]?.accessibilityBasic.unnamedControlCount, 0);
});

test("generic interactions move a range whose maximum is off its step", async () => {
  const fixture = (range: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Range fixture</title><style>body{font:16px system-ui}input{width:200px;height:44px}</style></head><body><main><h1>Range fixture</h1><label for="speed">Speed <output id="shown">0</output></label>${range}</main><script>speed.oninput=()=>{shown.value=speed.value}</script></body></html>`;
  for (const range of [
    '<input id="speed" type="range" min="0" max="25" step="2" value="0">',
    '<input id="speed" type="range" min="0" max="25" step="2" value="24">',
    '<input id="speed" type="range" value="100">',
  ]) {
    const result = await evaluateHtmlInBrowser(fixture(range), {
      viewports: [{ name: "phone", width: 390, height: 844 }],
    });
    assert.equal(result.viewports[0]?.behavior.interactionErrorCount, 0);
    assert.equal(result.viewports[0]?.behavior.changedControlCount, 1);
    assert.equal(result.viewports[0]?.behavior.passed, true);
  }
});

test("generic interactions fill colour, time and calendar inputs in their own formats", async () => {
  const fixture = (type: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Typed input fixture</title><style>body{font:16px system-ui}input{width:200px;height:44px}</style></head><body><main><h1>Typed input fixture</h1><label for="pick">Pick <output id="shown"></output></label><input id="pick" type="${type}"></main><script>pick.oninput=()=>{shown.value=pick.value}</script></body></html>`;
  for (const type of ["color", "time", "datetime-local", "month", "week"]) {
    const result = await evaluateHtmlInBrowser(fixture(type), {
      viewports: [{ name: "phone", width: 390, height: 844 }],
    });
    assert.equal(result.viewports[0]?.behavior.interactionErrorCount, 0, type);
    assert.equal(result.viewports[0]?.behavior.changedControlCount, 1, type);
  }
});

test("browser evaluator names a control by the image it contains", async () => {
  const fixture = (alt: string, image = `<img src="assets/diagram" alt="${alt}">`) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Image button fixture</title><style>body{font:16px system-ui}button{min-width:120px;min-height:48px}img{width:100px;height:40px}</style></head><body><main><h1>Image button fixture</h1><button type="button" id="pick">${image}</button><p id="feedback"></p></main><script>pick.onclick=()=>{feedback.textContent='Chosen'}</script></body></html>`;
  const named = await evaluateHtmlInBrowser(fixture("A fraction diagram"), {
    viewports: [{ name: "phone", width: 390, height: 844 }],
  });
  assert.equal(named.viewports[0]?.accessibilityBasic.unnamedControlCount, 0);
  assert.equal(named.viewports[0]?.accessibilityBasic.passed, true);

  const decorative = await evaluateHtmlInBrowser(fixture(""), {
    viewports: [{ name: "phone", width: 390, height: 844 }],
  });
  assert.equal(decorative.viewports[0]?.accessibilityBasic.unnamedControlCount, 1);

  for (const image of [
    '<img src="assets/diagram" alt="Play" aria-hidden="true">',
    '<span aria-hidden="true"><img src="assets/diagram" alt="Play"></span>',
    '<img src="assets/diagram" alt="Play" style="display:none">',
    '<img src="assets/diagram" alt="Play" style="visibility:hidden">',
    '<span aria-hidden="true">Play</span>',
    '<span style="display:none">Play</span>',
    '<span style="visibility:hidden">Play</span>',
  ]) {
    const hidden = await evaluateHtmlInBrowser(fixture("", image), {
      viewports: [{ name: "phone", width: 390, height: 844 }],
    });
    assert.equal(hidden.viewports[0]?.accessibilityBasic.unnamedControlCount, 1, image);
  }

  // Hiding is judged inside the control, so an image names its button
  // wherever a text label would.
  const inHiddenRegion = await evaluateHtmlInBrowser(
    fixture("A fraction diagram").replace("<button", '<div aria-hidden="true"><button').replace("</button>", "</button></div>"),
    { viewports: [{ name: "phone", width: 390, height: 844 }] },
  );
  assert.equal(inHiddenRegion.viewports[0]?.accessibilityBasic.unnamedControlCount, 0);
});

test("browser evaluator does not treat script-only focus targets as controls", async () => {
  const result = await evaluateHtmlInBrowser(
    goodFixture.replace("<main>", '<main tabindex="-1">').replace("<h1>", '<h1 tabindex="-1">'),
    { viewports: [{ name: "phone", width: 390, height: 844 }] },
  );
  assert.equal(result.viewports[0]?.behavior.controlCount, 1);
  assert.equal(result.viewports[0]?.renderedQuality.overlappingControlPairCount, 0);
  assert.equal(result.viewports[0]?.renderedQuality.passed, true);
  assert.equal(result.passed, true);
});

test("browser evaluator treats controls in an inert section as locked, like disabled ones", async () => {
  const result = await evaluateHtmlInBrowser(
    goodFixture.replace(
      '<p id="feedback"',
      '<section inert><h2>Next step</h2><button type="button">Locked one</button><button type="button">Locked two</button></section><p id="feedback"',
    ),
    { viewports: [{ name: "phone", width: 390, height: 844 }] },
  );
  const viewport = result.viewports[0]!;
  assert.equal(viewport.behavior.controlCount, 1);
  assert.equal(viewport.behavior.exercisedControlCount, 1);
  assert.equal(viewport.behavior.interactionErrorCount, 0);
  assert.equal(viewport.accessibilityBasic.focusFailureCount, 0);
  assert.equal(result.passed, true);
});

test("browser evaluator treats controls in a disabled fieldset as disabled", async () => {
  const result = await evaluateHtmlInBrowser(
    goodFixture.replace(
      '<p id="feedback"',
      '<fieldset disabled><legend>Next step</legend><button type="button">Locked one</button><input type="checkbox" aria-label="Locked choice"></fieldset><p id="feedback"',
    ),
    { viewports: [{ name: "phone", width: 390, height: 844 }] },
  );
  const viewport = result.viewports[0]!;
  assert.equal(viewport.behavior.controlCount, 1);
  assert.equal(viewport.behavior.exercisedControlCount, 1);
  assert.equal(viewport.behavior.interactionErrorCount, 0);
  assert.equal(viewport.accessibilityBasic.focusFailureCount, 0);
  assert.equal(result.passed, true);
});

test("generic interactions skip native buttons marked aria-disabled", async () => {
  const result = await evaluateHtmlInBrowser(
    goodFixture.replace(
      '<p id="feedback"',
      '<button type="button" aria-disabled="true">Next step</button><p id="feedback"',
    ),
    { viewports: [{ name: "phone", width: 390, height: 844 }] },
  );
  const viewport = result.viewports[0]!;
  assert.equal(viewport.behavior.exercisedControlCount, 1);
  assert.equal(viewport.behavior.interactionErrorCount, 0);
  assert.equal(result.passed, true);
});

test("generic interactions do not type into read-only result fields", async () => {
  const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Read-only fixture</title><style>body{font:16px system-ui}input,textarea{width:200px;min-height:48px}</style></head><body><main><h1>Read-only fixture</h1><label for="width">Width</label><input id="width" type="number" value="3"><label for="area">Area</label><input id="area" readonly value="9"><label for="note">Working</label><textarea id="note" readonly>3 × 3</textarea></main><script>width.oninput=()=>{area.value=String(width.value*3)}</script></body></html>`;
  const result = await evaluateHtmlInBrowser(fixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
  });
  const viewport = result.viewports[0]!;
  assert.equal(viewport.behavior.exercisedControlCount, 1);
  assert.equal(viewport.behavior.interactionErrorCount, 0);
  assert.equal(viewport.behavior.passed, true);
});

test("browser evaluator measures a labelled checkbox by its label's touch target", async () => {
  const fixture = (label: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Checkbox target fixture</title><style>body{font:16px system-ui}label{display:flex;align-items:center;gap:10px;min-height:48px}</style></head><body><main><h1>Checkbox target fixture</h1>${label}</main></body></html>`;
  const labelled = await evaluateHtmlInBrowser(
    fixture("<label><input type=\"checkbox\"> Different locations</label>"),
    { viewports: [{ name: "phone", width: 390, height: 844 }] },
  );
  assert.equal(labelled.viewports[0]?.renderedQuality.undersizedTouchTargetCount, 0);

  const bare = await evaluateHtmlInBrowser(
    fixture("<input type=\"checkbox\" aria-label=\"Different locations\">"),
    { viewports: [{ name: "phone", width: 390, height: 844 }] },
  );
  assert.equal(bare.viewports[0]?.renderedQuality.undersizedTouchTargetCount, 1);

  const slider = await evaluateHtmlInBrowser(
    fixture("<label>Angle <input type=\"range\"></label>"),
    { viewports: [{ name: "phone", width: 390, height: 844 }] },
  );
  assert.equal(slider.viewports[0]?.renderedQuality.undersizedTouchTargetCount, 1);
});

test("generic interactions choose a file for a file input", async () => {
  const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>File fixture</title><style>body{font:16px system-ui}input{min-width:200px;min-height:48px}</style></head><body><main><h1>File fixture</h1><label for="photo">Your drawing</label><input id="photo" type="file" accept="image/*"><p id="chosen" aria-live="polite"></p></main><script>photo.onchange=()=>{chosen.textContent=photo.files.length+' file chosen'}</script></body></html>`;
  const result = await evaluateHtmlInBrowser(fixture, {
    viewports: [{ name: "phone", width: 390, height: 844 }],
  });
  const viewport = result.viewports[0]!;
  assert.equal(viewport.behavior.exercisedControlCount, 1);
  assert.equal(viewport.behavior.interactionErrorCount, 0);
  assert.equal(viewport.behavior.changedControlCount, 1);
  assert.equal(viewport.behavior.passed, true);
});
