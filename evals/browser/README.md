# Browser artifact evaluation

`evaluateHtmlInBrowser` loads an artifact in headless Chromium with the public
player's CSP sandbox, permissions policy, and two representative viewports. It
exercises controls and reports metadata-only signals for:

- runtime and console errors;
- blocked network attempts and CSP violations;
- declarative behavior scenarios and generic control state changes;
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
scenarios; generic clicks are a smoke test, not proof of pedagogical quality.
The corpus command evaluates every canonical reviewed seed and writes only
versioned metadata to `results/latest.v1.json`; it exits non-zero while any
foundation finding remains.
