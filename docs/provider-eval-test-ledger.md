# Provider, script and evaluation pruning ledger

Baseline: `29d98e3ef7b9ef8498d742eccf92d2413420f9d7` on `master`.
Policy: [provider-eval-test-policy.md](provider-eval-test-policy.md).
This pass changes tests and documentation only. It does not edit `apps/ipad`,
API report/public-player/app-route/repository tests, runtime code or settings.
The final candidate incorporates `master` at
`b6095859915b12ee513d70924b7466d45c42276a` by a normal merge. Upstream changes,
including the mean-and-median checks in `scripts/examples.test.mjs`, are preserved.

## Measurements and complete inventory

All 13 scoped files were inventoried and every test body inspected. “Changed”
means a test/assertion changed; “retained” means the file is byte-for-byte intact.
Both groups were executed in the scoped checks. No file was omitted for having
no obvious cuts. Functions count source `it`, `it.each`, `test` and `t.test`
registrations, not helper functions. Cases count runner-collected tests, including
the Node parent test in `run-checks.test.mjs`.

| File | Disposition | Functions before → after | Cases before → after | Lines before → after |
| --- | --- | ---: | ---: | ---: |
| `services/api/test/tkslopper.test.ts` | Inspected, changed, passed | 54 → 53 | 100 → 95 | 1490 → 1474 |
| `services/api/test/createProvider.test.ts` | Inspected, changed, passed | 16 → 15 | 26 → 24 | 420 → 404 |
| `services/api/test/anthropicProvider.test.ts` | Inspected, retained, passed | 6 → 6 | 12 → 12 | 248 → 248 |
| `services/api/test/generation.test.ts` | Inspected, changed, passed | 61 → 61 | 120 → 117 | 1401 → 1399 |
| `scripts/class-access.test.mjs` | Inspected, retained, passed | 10 → 10 | 10 → 10 | 225 → 225 |
| `scripts/examples.test.mjs` | Inspected, changed, passed | 48 → 48 | 48 → 48 | 1089 → 1144 |
| `scripts/live-image-fixture.test.mjs` | Inspected, retained, passed | 1 → 1 | 1 → 1 | 22 → 22 |
| `scripts/publication-browser-fixture.test.mjs` | Inspected, retained, passed | 1 → 1 | 1 → 1 | 77 → 77 |
| `scripts/run-checks.test.mjs` | Inspected, changed, passed | 2 → 2 | 5 → 3 | 71 → 71 |
| `evals/browser/evaluate.test.ts` | Inspected, retained, passed | 20 → 20 | 20 → 20 | 391 → 391 |
| `evals/model/production-harness.test.ts` | Inspected, retained, passed | 7 → 7 | 7 → 7 | 402 → 402 |
| `evals/model/run.test.ts` | Inspected, changed, passed | 5 → 5 | 5 → 5 | 111 → 113 |
| `evals/model/validator-parity.test.ts` | Inspected, retained, passed | 1 → 1 | 1 → 1 | 174 → 174 |
| **Total** | **13 inspected and executed; 6 changed** | **232 → 230** | **356 → 344** | **6121 → 6144** |

The table preserves the original baseline. The merge adds 55 upstream lines to
`scripts/examples.test.mjs` without changing registrations or collected case counts.
Against the integrated `master` base, scoped lines are **6176 → 6144**; the pruning
still removes 32 lines. No upstream behavioural assertion was removed or weakened.

Vitest `it.each` rows: **151 → 143** (tkslopper 58 → 54, factory 14 → 13,
Anthropic 9 → 9, generation 70 → 67). Dynamically collected Node child rows:
**4 → 2**, all in `run-checks.test.mjs`. Other loops and fixture matrices remain
intact. The Kimi assertions were moved onto an existing identical operation;
that consolidation removes setup, not behaviour. Lines include blanks/comments
and exclude these two new documents. Counts came from TypeScript AST registration
counts, physical newline counts and actual runner totals, not test-name searches.

Measured in the Linux orb, Node 22.23.4, npm 10.9.10, installed locked dependencies:

| Command | Before | After | Result |
| --- | ---: | ---: | --- |
| `npm run api:test -- test/tkslopper.test.ts test/createProvider.test.ts test/anthropicProvider.test.ts test/generation.test.ts` | 3.28 s | 2.95 s | 258 → 248 passed |
| `node --import tsx --test scripts/*.test.mjs evals/**/*.test.ts` | 77.86 s | 73.61 s | 98 → 96 passed; no skips |
| **Sequential scoped wall time** | **81.14 s** | **76.56 s** | **356 → 344 passed** |

These are single elapsed-time samples including startup, not a speed benchmark.
Browser startup, cache warmth and scheduling can dominate such a small pruning.
After measurements include the restored HTTP 504 row and the integrated upstream
checks, so the before/after samples also differ in upstream behavioural coverage.
The final JSONC fixture refinement was also checked with `eval:model:test`.

Final integrated `npm run verify`: **all eight checks passed**, 77.91 s elapsed. It ran
75 root Node tests, 481 API cases in 18 files, 13 model-evaluation tests and
20 browser-evaluation tests, plus both typechecks, corpus validation and artifact
evaluations. No skipped tests were reported. `git diff --check` also passed.

The first Node baseline failed 37 tests because Chromium was absent; that failed
13.06 s run is excluded from the comparison. Installing Chromium produced the
successful baseline above. The first full `npm run verify` also lacked WebKit;
that 68.73 s failed run is not a passing baseline. Local repair commands were
`npx playwright install chromium` and `npx playwright install --with-deps webkit`.
The missing browser step in `.agents/setup` was reported separately, not changed
in this scope. No test was skipped or weakened to repair the environment.

## Every removal and its detection consequence

Categories use the source skill's vocabulary. Non-identical inputs are explicitly
**accepted risk**, even when the current code routes them through one branch.
No removal is justified by assumed upstream coverage or retired behaviour.

| File / removed test, row or assertion | Category | Detection lost; retained witness |
| --- | --- | --- |
| `tkslopper`: `defaults efforts, endpoint and request limit` | Configuration/constant inspection; redundant coverage for request projections | Loses the exact **1,048,576-byte default** pin. Explicit byte-limit rejection, UTF-8 inclusive boundary and oversized-image preflight remain. `sends strict Responses bodies for every model operation` still checks default artifact/review efforts, gateway URL and endpoint. `exchanges the service credential for de-duplicated capabilities` checks the control-plane URL. `sends a strict image review body without detail` checks the default image body's omission of reasoning. |
| `tkslopper`: HTTP **409** row | Accepted risk | A conflict-specific incorrect retry flag or extra attempt may escape; 400/402/403 non-retryable and 429/500/503 retryable paths remain. No auth status removed. |
| `tkslopper`: HTTP **413** row | Accepted risk | A payload-too-large-specific incorrect retry flag or extra attempt may escape. Local byte-limit/pre-network checks remain, but are not claimed as an equivalent HTTP witness. |
| `tkslopper`: HTTP **415** row | Accepted risk | An unsupported-media-type-specific incorrect retry flag or extra attempt may escape. The retained 400 row checks the ordinary invalid-request path, not this exact status. |
| `tkslopper`: HTTP **502** row | Accepted risk | A 502-specific incorrect retry flag or extra attempt may escape. 502 image-review unavailability/privacy and error trace checks remain; those do not replace the removed retry assertion. |
| `createProvider`: `omits DeepSeek reasoning fields for other OpenCode chat models` | Redundant coverage, after moving its assertions | **None.** The retained `keeps other OpenCode Go models on chat completions: kimi-k3` row constructs the same environment/provider, invokes `generate`, and now also asserts absence of `thinking` and `reasoning_effort` in the captured request. It still checks the endpoint and absence of `reasoning`. |
| `createProvider`: `glm-5.3` chat-fallback row | Accepted risk | GLM-specific wrong dialect or unwanted `reasoning` could escape. Kimi remains a representative unrelated family; bare `muse-spark` and `gpt-4o` preserve near-family boundaries. No credential or moderation assertion is removed. |
| `generation`: design-card row `"card"` | Accepted risk | A scalar-string-only failure to discard optional metadata, or an unnecessary repair for that value, could escape. Null, array, invalid title, description and tags remain; HTML validation is unchanged. |
| `generation`: comment row `null` | Accepted risk | Null-specific retention of an invalid comment or unnecessary repair could escape; numeric non-string, whitespace-only and oversize cases remain. |
| `generation`: comment row `""` | Accepted risk | Empty-string-specific retention/repair could escape; whitespace trimming to empty remains exercised. No source/output fencing or trace assertion is removed. |
| `generation`: `PROMPT_VERSION === "html-v9"` and now-unused import | Configuration/constant inspection | The arbitrary version label can change without this test failing. Actual exemplar/current-HTML/candidate delimiters, escaping of forged boundaries and legacy opt-in checks remain. |
| `scripts/examples`: `files.length === 18` | Configuration/constant inspection | A nonempty corpus changing size no longer fails this smoke test solely on cardinality. It still executes every discovered HTML file and rejects an empty corpus; manifest validity, packaging parity and activity-specific behaviour remain. |
| `scripts/run-checks`: `second fails` child row | Accepted risk | A failure specific to the slower second job's position/completion order could escape. All-pass and first-job-fails runs still check every job's completion, exit aggregation, output, report and concurrency. |
| `scripts/run-checks`: `third fails` child row | Accepted risk | A failure specific to a queued third job could escape. Keeping the early first-job failure is important to exercise continued scheduling after failure; this is not described as equivalent queued-failure coverage. |
| `evals/model/run`: deployed `openrouter` / `openai/gpt-6-luna` / `low` assertions and real-file dependency | Configuration/constant inspection | No longer pins or validates the current deployment file through this test. A disposable JSONC file now supplies independent synthetic settings to the same loader and plan. Effort inheritance, alternate-provider reset and endpoint/credential-selection assertions remain. The fixture includes a comment so JSONC acceptance is still exercised. |

## Retained contracts, by file

- **tkslopper:** configuration rejection; request/schema/tool absence; moderation
  and image-review results; grant expiry/refresh/denial/concurrency; credential
  routing; service bindings; no-content traces/logs; metadata projection and
  deadlines. Keep all image-error and auth-status rows, even where retry code is shared.
  **HTTP 504 is retained, not accepted risk:** its `retryable=true`, one gateway
  call and one grant exchange assertions protect the shared generation/moderation
  transport against timeout-specific replay. A proxy timeout can follow upstream
  execution; fresh idempotency keys per send could then duplicate billed or
  moderated work. Abort/deadline tests exercise a different failure mechanism.
- **createProvider:** every provider's construction/credential path, native versus
  third-party headers, Responses/Chat family boundaries, moderation routing and
  explicit evaluation overrides. These are consumer wiring tests, not helper duplicates.
- **anthropicProvider:** all 12 cases retained. Real loopback redirect trap,
  private traces, bounded prompts, moderation schema/results, refusal/truncation,
  non-echoed HTTP failures and malformed output cover distinct consequences.
- **generation:** sandbox/MIME matrices, source fencing, asset references and
  required-image insertion/escaping, bounded repair, response statuses, optional
  metadata representatives and metadata-only traces. Syntax and URL cases are
  application acceptance policy, not merely Acorn/parse5's responsibility.
- **class-access:** all class-code formats, bounds, expiry, file permissions,
  symlink rejection, allocation collisions and uncertain retries. The CLI tests
  restart real child processes and use disposable SQLite; same-process calls
  would not replace their recovery evidence.
- **examples:** all 48 functions retained, including teaching feedback, accessibility,
  keyboard focus, timer/reset state, independent activity controls and the
  separately implemented tooling HTML validator. `expectedCount` rejection in
  manifest validation remains: a caller-supplied constraint is not the corpus-size pin.
- **live-image-fixture:** entire test retained, including the digest. The loader's
  PNG metadata/dimension checks alone do not establish safe image identity.
- **publication-browser-fixture:** private origin-bound cleanup, symlinks, permissions,
  no-network rejection and exact deletion identities all retained.
- **run-checks:** real subprocess success and early-failure aggregation, bounded
  concurrency, queued completion and generated summaries retained.
- **browser/evaluate:** all 20 functions retained. Fresh browsing contexts,
  CSP/network blocking, no-source metadata, independently breakable native
  control interactions, accessibility and visibility semantics all add detection.
- **production-harness:** all seven functions retained. Production API wiring,
  retrieval modes/ranking, revision/image/conflict/restore, privacy on rejected
  output, and visible versus source-only retention are not replaced by evaluator units.
- **model/run:** credential isolation, provenance-safe input, explicit ablations
  and configuration-to-provider wiring retained. The deployed-value snapshot
  becomes a loader contract test rather than being deleted wholesale.
- **validator-parity:** complete snippet matrix retained. It compares two owned
  validators; shared parser dependencies do not make that boundary redundant.

## Iterative audit and review verdict

1. **Inventory/baseline:** inspected scoped bodies and relevant owners in the
   provider factory/adapters, managed config/client, generation, tooling HTML
   validator, evaluation loader/harness/browser and CLI fixtures. Inventoried
   `verify:live`, publication prepare/cleanup, class provisioning/shortening,
   example import/parity and model/browser evaluation runners. Inspected their
   effectful entry points without invoking live writes, paid inference or remote
   provisioning. CI adds only the API dry-run build to the eight verify checks.
2. **Pilot:** pruned managed settings/retry variants and factory duplication.
   Targeted tests passed (117 at that intermediate state). A fresh diff review
   required exact Kimi request assertions to remain, and refused to prune
   moderation/credential matrices merely because model names looked similar.
3. **Fresh tranche:** applied the rules to generation, scripts and evaluations.
   Kept array-shaped invalid cards (different guard), all HTML/MIME cases and
   cross-validator parity. Replaced deployment snapshots with synthetic config.
   Kept the safe-image identity pin and all independently authored teaching tests.
4. **Recheck:** restored the original timeout test after recognising that a
   proposed signal-only replacement would miss removal of the finite deadline.
   Chose the first-job failure, not the slower second-job failure, as the retained
   runner case so continued scheduling after an early error stays exercised.
   Rechecked earlier removals against both refinements; no protected loss accepted.
5. **Final self-review:** all removed assertions/rows are enumerated above; no
   unused fixture/helper remains and only the unused prompt-version import was
   removed. All 13 files were executed, including unchanged files. No dependency
   ownership or retirement claims were used to justify a deletion.
6. **Independent review cycle 1 — REQUEST_CHANGES:** the reviewer identified the
   removed HTTP 504 row as protected moderation coverage (Required/P2). Restored
   that single row with its existing retryable, call-count and exchange-count
   assertions, and refined the policy to retain HTTP-timeout no-replay witnesses.
   This is preventive coverage, not a claim that current runtime code replays 504.
   The reviewer accepted the other removals; their classifications remain unchanged.
7. **Independent review cycle 2 — NO MATERIAL FINDINGS:** exact head
   `02fbf0008b7d11c90a72f1e4942e79ff2f2a2d22` resolved the Required/P2 finding.
   The reviewer independently verified all per-file counts and reran full and
   scoped checks successfully. This review preceded integration of newer `master`.
8. **Final integration:** merged `master` at `b609585` without conflicts or history
   rewriting. The upstream mean-and-median checks remain intact; the only pruning
   change to that file is still the fixed-size assertion becoming a nonempty check.
   Updated line counts for the upstream additions. Independent review cycle 3 is
   the final authorised cycle and must bind this integrated candidate before merge.

Steps 1–5 are self-review, **not independent review**; steps 6–7 record the independent
review arranged by PM. This implementation thread created no subagents or other
threads. The modest reduction is deliberate, not a target shortfall.
Ambiguous candidates (deadline construction and safe-image hash) were retained,
not silently classified as harmless pins. PM arranges independent review; YJ
alone approves merge. YJ's separate merge approval is conditional on clean
cycle-3 review and exact-head CI; it does not authorise deployment.
