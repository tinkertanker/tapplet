# Production-path model evaluation

The version 2 harness sends `artifact-requests.json` through `createStudioApp`
and `createModelProvider`, not a parallel prompt or validation implementation.
It imports the canonical reviewed seed corpus through the real seed route, uses
the repository's current retrieval ranking, executes generation, zero-to-two
finding-led repairs, revision, host image insertion, optimistic conflict,
history restore, and the Chromium evaluator. The generated and revised source
exists only in memory and is discarded after evaluation.

Install the pinned browser and run focused tests without provider credentials:

```sh
npx playwright install chromium
npm run eval:model:test
npm run eval:browser:test
```

Run the production policy with the provider configuration used by the API:

```sh
OPENCODE_API_KEY=... \
npm run eval:model
```

The default provider and model come from `services/api/wrangler.jsonc`.
`EVAL_PROVIDER` accepts the same provider names as the service. Set
`EVAL_BASE_URL` and `EVAL_API_KEY` only when an explicit override is intended.
The runner rejects non-HTTPS URLs, embedded URL credentials, invalid repair
counts, and unknown modes. `EVAL_REPETITIONS` is bounded to 1–20.

## Controlled ablations

Comma-separated plural variables form a Cartesian experiment matrix:

```sh
EVAL_RETRIEVAL_MODES=production,none,curated-only,published-inclusive,published-only \
EVAL_MAX_REPAIRS_VALUES=0,1,2 \
EVAL_PROMPT_BOUNDARY_MODES=bounded,legacy-unbounded \
EVAL_REASONING_EFFORTS=default,low,high \
EVAL_REPETITIONS=3 \
npm run eval:model
```

Use a smaller controlled matrix in practice. The first configuration is the
baseline and the report records quality, revision retention, browser behavior,
context bytes/tokens/cache use, and p50/p95 latency deltas. `published-only`
uses an entirely synthetic publication containing instruction-like source text;
`published-inclusive` follows the current curated-first ranking. These modes
are evaluation adapters and do not alter runtime retrieval policy. `EVAL_CASES`
selects stable case IDs. `EVAL_BROWSER=false` is an explicit diagnostic escape
hatch and is recorded in provenance.

## Provenance and privacy

Single runs write `results/latest.v2.json`; matrices write
`results/latest-ablation.v2.json`; moderation writes
`results/latest-moderation.v2.json`. Version 2 includes the Git commit, prompt
version, manifest and retrieval snapshot hashes, non-secret provider settings,
Node/platform, policy settings, aggregate distributions, and metadata-only
traces. It omits briefs, prompts, generated/revised HTML, images, console and
exception text, student/teacher data, and keys. Legacy 18 July results are
isolated under `results/archive` and are not comparable.

The moderation corpus uses synthetic complete HTML and calls the production
`provider.moderate` method:

```sh
npm run eval:model-moderation
```

Durable asynchronous generation, generator vision, and independent visual
model review remain disabled conditional experiments. Browser geometry and
behavior metrics are not a substitute for teacher review or pedagogical
judgement.
