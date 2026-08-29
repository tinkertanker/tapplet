import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHtmlInBrowser } from "./evaluate";

const goodFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Browser evaluator fixture</title><style>*{box-sizing:border-box}body{font:16px system-ui;margin:0}main{max-width:40rem;margin:auto;padding:16px}button{min-width:120px;min-height:48px;font:inherit}</style></head><body><main><h1>Browser evaluator fixture</h1><button id="check" type="button">Check answer</button><p id="feedback" aria-live="polite"></p></main><script>document.getElementById('check').addEventListener('click',()=>{document.getElementById('feedback').textContent='Correct';document.body.dataset.checked='yes'})</script></body></html>`;

const badFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bad fixture</title><style>body{width:1400px;font-size:10px}button{width:20px;height:20px}</style></head><body><main><h1>Bad fixture</h1><button id="same"></button><button id="same">B</button><img src="assets/example"><script>fetch('https://example.invalid/student?q=private').catch(()=>{});setTimeout(()=>{throw new Error('private content')},0)</script></main></body></html>`;

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
