# Provider, script and evaluation test policy

This policy governs the scoped pruning pass based on
[`minimal-risk-tests`](https://github.com/gauravmm/g9k-skills/blob/master/skills/minimal-risk-tests/SKILL.md).
There is no numerical reduction target. The companion
[ledger](provider-eval-test-ledger.md) records individual decisions and measurements.

## Boundaries that must keep their detection

Never trade away detection of privacy or student-data leaks; authentication,
authorisation or class-code errors; provider credential/API-key crossover;
moderation failures; publication or asset ownership errors; or HTML sandbox and
preview-security failures. Keep distinct entry points and channels even when
they share helpers. A passing helper test cannot detect a caller bypassing it.

The API provider factory owns credential selection and dialect wiring. The
Anthropic adapter owns redirect confinement. Managed inference owns grant
validation, expiry, refresh, denial and credential routing. Generation owns
HTML acceptance, bounded repair and image insertion; tooling has a separate
HTML validator whose parity is independently breakable. The browser evaluator
owns browser confinement and metadata-only results. CLI class provisioning and
publication cleanup own their filesystem, origin and remote-identity boundaries.

## Local retention rules

- Keep actual request, response and browser observations, not just helper or
  settings checks. Grant exchanges, image review, metadata GETs and direct
  inference have different authority; none substitutes for another.
- A MIME-type matrix can protect executable HTML, and an HTTP-error matrix can
  protect privacy or authorisation. Neither is automatically redundant because
  the implementation shares a branch. Keep protected rows intact.
- Retain the HTTP 504 no-replay witness for the shared generation/moderation
  transport. A proxy timeout can follow upstream execution, and each send uses
  a fresh idempotency key: a future timeout-specific replay could duplicate
  billed or moderated work. Transport abort/deadline tests do not replace this
  HTTP-response witness, including its single-call and single-exchange assertions.
- Remove chosen configuration snapshots only when boundary witnesses remain.
  Test evaluation configuration loading with synthetic settings rather than
  the currently deployed provider/model. External-input validation, including
  count limits, is behaviour rather than a configuration pin.
- A timeout-spy assertion is not necessarily just a duration pin: replacing it
  with an `AbortSignal` type check loses detection of a signal with no deadline.
  Retain the managed-inference deadline witness rather than weaken its evidence.
- Keep a nonempty corpus observation instead of a fixed corpus size. Conversely,
  the live-upload image digest is a safety-relevant identity check: PNG metadata
  validation alone cannot detect replacement with a photograph of a pupil.
- Label pruned ordinary input variants as **accepted risk**, not redundancy,
  unless a retained test matches path, boundary and assertion. Optional comment
  and design-card shape variations are distinct from HTML validation and
  student-data handling; prune only the former.
- Preserve independently authored curated activities' behavioural checks.
  Similar controls in different HTML files do not have a shared implementation.
  Do not call a pedagogical regression merely a wording pin without inspecting
  the full operation it exercises.

## Audit and validation

Inspect every scoped test body, including retained files, with its relevant
owner. Work in small tranches, run affected tests, then conduct a fresh review
of the diff against the protected boundaries before expanding. Record the
triggering example and counterexample when refining a rule. This pass uses
self-review because the request forbids delegation; PM arranges independent
review before YJ decides whether to merge. Self-review is not independent review.

Count source test registrations, collected cases/parameter rows, physical lines
and elapsed runtime separately. Loops inside tests are not fewer behaviours.
Keep an exact ledger of deleted rows and assertions as well as whole tests.
Run the scoped API and Node tests and `npm run verify`; missing browser binaries,
skips and collection failures are not passes. Use local doubles/disposable data;
do not execute live provisioning, publication, model or deployment probes as
part of this pruning pass. No production code or runtime settings need changing.
