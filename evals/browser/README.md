# Browser artifact evaluation

`evaluateHtmlInBrowser` loads an artifact in headless Chromium with the public
player's CSP sandbox, permissions policy, and two representative viewports. It
exercises controls and reports metadata-only signals for:

- runtime and console errors;
- blocked network attempts and CSP violations;
- isolated declarative behavior scenarios and isolated generic control state changes;
- horizontal overflow, clipped controls, and initial viewport coverage;
- accessible control names, IDs, image alternatives, headings, and focus;
- touch-target size, text size, and overlapping controls.

It does **not** retain HTML, console text, URL paths or query strings,
screenshots, images, prompts, or learner/teacher data. Independent screenshot
or model-based visual review remains a separate, opt-in experiment. Install the
pinned browser once with `npx playwright install chromium`, then run:

```sh
npm run eval:browser:test
npm run eval:browser
```

The live model harness invokes the same evaluator in memory before discarding
each generated source. Exact classroom interactions can be added as declarative
scenarios. Each scenario and each of the first 12 generic controls starts in a
fresh browser page; controls are exercised through Playwright actionability and
generic behavior passes only when at least 80% produce an observable DOM or
native form-state change within 100 ms. Same-origin requests other than the main
document and managed image loads are blocked and counted. This is a bounded
smoke test, not proof of pedagogical quality. The harness also checks that
required lesson terms are rendered rather than merely present in script or
style source. The corpus command evaluates every canonical reviewed seed and
writes only schema 2.0 metadata to `results/latest.v2.json`; it exits non-zero
while any foundation finding remains. The incompatible schema 1.0 snapshot is
preserved separately at `results/latest.v1.json`.
