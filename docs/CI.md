# CI measurement and verification

`npm run verify` runs the same eight checks listed in `package.json`, with at
most two npm commands active (one on a single-core host). CI appends the API
dry-run build with `npm run verify -- api:build`. Commands retain their own
test workers, isolation, browsers, timeouts and typechecker settings.

Every command finishes even if another fails; any non-zero exit, signal or
failure to launch fails the aggregate. This replaces fail-fast ordering, not
the checks themselves. Output streams live, followed by a per-command timing
table in the log and GitHub job summary. A slow failure can therefore take
longer to report overall, but the run retains all available check results.

## Baseline: 30 consecutive GitHub runs

Measured on 4 November 2026, covering 17 October–3 November: 8 PR runs, 4 pushes
and 18 schedules. The Jobs API supplies step durations and job creation/start
timestamps. Queue time below is **job creation to start**, excluding dependency
waits and any delay before GitHub creates a scheduled run. Native jobs were
created a median 8 seconds after workflow creation, after `changes` completed.

| Measurement | Samples | Median | Range |
| --- | ---: | ---: | ---: |
| Node queue | 30 | 3s | 2–4s |
| Node job, including setup and cleanup | 30 | 144s | 116–200s |
| Installed-dependency restore | 30 | 2s | 0–7s |
| `npm ci` on installed-cache misses | 3 | 7s | 7–8s |
| Playwright browser and OS dependency install | 30 | 42s | 32–85s |
| Original serial `verify` | 30 | 90.5s | 70–104s |
| API dry-run build | 30 | 2s | 1–2s |
| Native queue | 26 | 4s | 2–366s |
| Native setup action | 26 | 34s | 9–78s |
| Unsigned device Release build | 26 | 48s | 27–58s |
| Debug unit-test step (build + launch + tests) | 26 | 260s | 129–615s |
| UI queue | 20 | 3.5s | 2–366s |
| UI setup action | 20 | 38.5s | 14–93s |
| UI test step (build + launch + tests) | 20 | 842s | 551–1048s |
| Whole UI job | 20 | 917s | 617–1118s |

The installed-dependency cache hit **27/30** times: 7/8 PRs, 3/4 pushes and
17/18 schedules. Hits are identified by the skipped `npm ci` step, corroborated
by cache-hit logs. Both extant caches are on `refs/heads/master`: approximately
90 MB installed dependencies and 100 MB npm downloads. Master already seeds
the cache; no additional seeding job is warranted. The last installed-cache
miss, [run 40594651510](https://github.com/tinkertanker/tapplet/actions/runs/40594651510),
saved the key that subsequent runs hit. Keep the exact fingerprint and pristine
pre-test save. This change touches fingerprint inputs, so its first run may miss.

In [the latest baseline run](https://github.com/tinkertanker/tapplet/actions/runs/41739580154),
Playwright spent about 23 seconds installing OS packages and 8 seconds fetching
the browsers. A browser-only cache cannot eliminate the OS setup. There is no
measured cache-restore saving here to justify adding another cache yet.

## Local serial/parallel comparison

Measurements used the same two-vCPU Linux orb, Node 22.23.4, locked dependencies
and installed Chromium/WebKit, based on commit
[`fa6fb46`](https://github.com/tinkertanker/tapplet/commit/fa6fb46e52a8e1308a50c22965b809c31856e8b2).
No benchmark suites ran concurrently with each other. Browser/setup time is
excluded from both sides; these numbers are not hosted GitHub speedup claims.

| Command | Wall time | Result |
| --- | ---: | --- |
| Original `&&` chain plus API build, including the new runner tests | 102.81s | All pass |
| `npm run verify -- api:build`, trial 1 | 73.52s | All pass |
| Same, trial 2 | 74.15s | All pass |
| Same, trial 3 | 73.25s | All pass |

The final runner's median is **73.52s**, saving **29.29s (28.5%)** against the
exact serial command with equivalent tests. Earlier per-command serial profiles
were 116.26s, 103.19s and 105.03s; the third also included the new runner tests.
Their median per-command times were 21.13s root tests, 25.98s API tests, 4.11s
API typecheck, 2.74s eval typecheck, 0.33s example validation, 0.47s artifact
evaluation, 12.79s model tests, 35.93s browser-evaluator tests and 1.62s build.
Two-command prototypes took 68.22s and 67.56s before adding the runner tests;
the final-command numbers above include their overhead and are the claim.

No workflow was dispatched and no changes were pushed to obtain these numbers.
Check the new per-command job summary after an authorised CI run to measure the
hosted improvement, including cache misses and browser installation.

## Why command-level parallelism is safe

Both TypeScript commands use `noEmit`. Corpus validation reads the canonical
HTML and compares existing generated fixtures; it does not regenerate them.
Tests use separate processes/browser contexts, disposable temporary directories
and ephemeral server ports. The build alone writes `services/api/dist`; no
other check consumes that output. No new dependency or external service is
needed. The two-command ceiling avoids unbounded nested test/browser workers.

The runner regression test uses real npm scripts in a temporary package. A
rendezvous proves overlap; event records prove the concurrency ceiling and
completion of every check. Independent failures in each of three queue
positions must fail the aggregate even when later checks pass. Its serial
implementation failed these tests; the parallel implementation passed all five
test results on both two-core and single-core CPU affinity. Empty arguments
and an unavailable npm executable also exit 1.

Coverage comparison: all original scripts and test-file arguments remain;
only five runner test results are added. The full passing counts are now
**77 repository tests, 486 API tests across 18 files, 13 model tests and 20
browser-evaluator tests**, with zero skips, plus both typechecks, both corpus
checks and the API build. API containment still runs Chromium **and WebKit**.

## Native investigation is separate from the Node speedup

No native job, path filter, label/schedule gate, command, simulator selection,
result bundle, diagnostics or artifact-retention setting changed. The workflow
still gates deployment on the entire Node job. There is no native speedup claim
and the initial Node-only change did not rerun native tests. The separately
requested assertion fix and Mac validation are recorded below.

Timestamped logs in run 41739580154 separate the native costs:

- Simulator discovery alone took about 26–27 seconds. Xcode selection took
  4–5 seconds; pinned XcodeGen installation took 3–4 seconds; project generation
  took less than a second. Caching XcodeGen would address very little time.
- Unit tests: approximately 52 seconds to the last build output, another
  167 seconds until XCTest began, then 75 tests in 13.9 seconds. The launch
  interval includes simulator/install/test-runner work, not measured boot time
  alone. The unit job also compiles the UI test target under the existing scheme.
- UI tests: approximately 59 seconds to the last build output, another
  152 seconds until XCTest began, then 16 tests in 627.6 seconds. Most UI time
  is actual test execution, with substantial launch and teardown overhead too.
- A [successful comparison run](https://github.com/tinkertanker/tapplet/actions/runs/40781949346)
  used the same Xcode 26.3 / iOS 26.2 and ran the 16 UI tests in 513.6 seconds.

Seven recent UI runs failed. The latest baseline failure was a stale assertion
at `apps/ipad/UITests/TappletUITests.swift:279`: it expected “its revision history”
while `AppletProjectCard.swift` displays “all its earlier versions”. This is
not a timing failure to conceal with retries, skips or relaxed assertions.
[Its existing xcresult and diagnostics artifact](https://github.com/tinkertanker/tapplet/actions/runs/41739580154/artifacts/13281406753)
was uploaded successfully; its original seven-day retention remains in force.
An earlier failure was in `testReopenedEditorShowsAChangeStillBeingMade`, so
the stale copy assertion does not explain every historical failure.

Preboot overlap or separate build/test phases could help native launch time,
but need a Mac experiment with the same destinations, configurations, test
counts and xcresult evidence before changing the gates. No runner purchase,
typechecker replacement, test-isolation relaxation or affected-test filtering
is part of this change.

## Follow-up: stale assertion fixed and verified on a Mac satellite

The user separately requested this fix. Only the expected confirmation string
changed; the exact-copy assertion, cancellation, retained-tapplet assertions
and screenshot attachments remain. Application code did not change.

On an Amp `mac.medium` satellite using Xcode 26.3 (17C529), iOS 26.2 and an
iPad Pro 13-inch (M5) simulator:

- Before: the unchanged deletion test reproduced the line-279 failure;
  `xcodebuild` exited 65 after 88 seconds.
- After: the full Debug suite passed **75 unit tests and all 16 UI tests**,
  with zero failures or skips; `xcodebuild` exited 0 after 290 seconds.
  The deletion-cancellation test passed in 16.155 seconds. The earlier
  `testReopenedEditorShowsAChangeStillBeingMade` failure did not recur.
- Both xcresult bundles and logs were retained. The passing test's screenshots
  were inspected: the new copy is visible, and cancellation keeps the tapplet
  with its Open button. These timings are validation evidence, not a native
  performance comparison against GitHub's runners.

The canonical `xcodebuild test` command used project `apps/ipad/Tapplet.xcodeproj`,
scheme `Tapplet`, configuration `Debug`, the same explicit simulator destination
before and after, `CODE_SIGNING_ALLOWED=NO`, and the loopback API URL. Local
validation added `-jobs 2 COMPILER_INDEX_STORE_ENABLE=NO` and isolated DerivedData
at `apps/ipad/.derived-data/assertion-simulator`. The before run selected only
`TappletUITests/TappletUITests/testDeletingATappletCanBeCancelled`; the after run
used no test filter. No signing, release, deployment or workflow changes were
needed for this follow-up.

## Reproduce without changing shared state

Install locked dependencies and the same browsers as CI, then compare serial
and parallel execution on the same idle machine:

```sh
npm ci
npx playwright install --with-deps --only-shell chromium webkit
time sh -c 'npm test && npm run api:test && npm run api:typecheck && npm run eval:typecheck && npm run examples:validate && npm run eval:artifacts && npm run eval:model:test && npm run eval:browser:test && npm run api:build'
time npm run verify -- api:build
```

For hosted timings, read `gh run list --workflow ci.yml --limit 30 --json
databaseId,createdAt,event` and `gh api
repos/tinkertanker/tapplet/actions/runs/<id>/jobs`; inspect a sample with
`gh run view <id> --log`. Cache inventory is available from
`gh api repos/tinkertanker/tapplet/actions/caches`. These are read-only queries;
no workflow or deployment needs to be triggered to collect the baseline.
