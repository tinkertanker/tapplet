# Makelet

**Create tiny interactive tools for any lesson.**

Makelet is a teacher-facing iPad app for generating, adapting, previewing and
sharing self-contained interactive classroom activities. It is an open-source
project by [Tinkercademy](https://tinkercademy.com).

The iPad app does not run a model locally. It authenticates to the Makelet API,
keeps projects available for offline preview and publishes unlisted links that
students can open in a browser.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/ipad` | SwiftUI teacher app |
| `services/studio-api` | Cloudflare Worker API, D1 migrations and tests |
| `examples/studio-html` | Canonical reviewed activity corpus |
| `evals` | Artifact and model evaluation harnesses |
| `scripts` | Seed, verification and workshop-provisioning tools |
| `docs` | Product contract and pilot operations |

The repository was extracted with history from
[`tinkertanker/classroom-widgets`](https://github.com/tinkertanker/classroom-widgets)
after the product moved from the old widget runtime to self-contained HTML
activities. Some source paths, API environment variables, Xcode identifiers
and deployed Cloudflare resources retain the internal name `Studio`. They are
intentionally unchanged during the repository cutover so that extraction does
not also become a production infrastructure migration.

Product and operational details live in:

- [`docs/STUDIO_V1.md`](docs/STUDIO_V1.md) — product and artifact contract;
- [`docs/STUDIO_PILOT_RUNBOOK.md`](docs/STUDIO_PILOT_RUNBOOK.md) — production
  provisioning, safety response and rollback;
- [`services/studio-api/wrangler.jsonc`](services/studio-api/wrangler.jsonc) —
  authoritative non-secret production model and quota configuration.

## Install

Use Node.js 22.12 or newer on the Node 22 release line:

```bash
npm ci
```

Run the complete offline verification suite:

```bash
npm run verify
```

This checks the API tests and types, class-code tooling, seed corpus, artifact
evaluation and bundled iPad resources. It does not call the configured model or
production services.

## Build and test the iPad app

Install [XcodeGen](https://github.com/yonaskolb/XcodeGen), then run:

```bash
npm run ipad:prepare
```

`ipad:prepare` copies the 14 reviewed HTML examples into the app and generates
`apps/ipad/ClassroomWidgetsStudio.xcodeproj`.

Build without signing for a simulator:

```bash
xcodebuild \
  -project apps/ipad/ClassroomWidgetsStudio.xcodeproj \
  -scheme ClassroomWidgetsStudio \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Run the unit-test target using an installed simulator:

```bash
xcodebuild \
  -project apps/ipad/ClassroomWidgetsStudio.xcodeproj \
  -scheme ClassroomWidgetsStudio \
  -configuration Debug \
  -destination 'platform=iOS Simulator,id=<simulator-udid>' \
  CODE_SIGNING_ALLOWED=NO \
  -only-testing:ClassroomWidgetsStudioTests \
  test
```

The Debug configuration uses `http://127.0.0.1:8787`. The Release
configuration currently uses the production API at:

```text
https://classroom-widgets-studio-api.tinkertanker.workers.dev
```

`STUDIO_API_BASE_URL` in the process environment overrides the value embedded
in the app. Remove any local override before validating a production Release
build.

## Run the API locally

Create a local development configuration from the safe template:

```bash
cp services/studio-api/.dev.vars.example services/studio-api/.dev.vars
npm run dev
```

Never commit `.dev.vars`, class codes, device tokens or production credentials.

Apply D1 migrations to the local Wrangler database with:

```bash
npm run db:migrate:local
```

## Server-side model

The iPad app is model-agnostic. The API currently configures:

| Setting | Current value |
| --- | --- |
| Provider | OpenAI-compatible API |
| Model | `deepseek-v4-flash` |
| Base URL | `https://api.deepseek.com` |
| Temperature | `0.2` |
| DeepSeek thinking mode | Disabled |
| Generate/revise/repair output limit | 32,000 tokens |
| Moderation output limit | 500 tokens |
| Request timeout | 45 seconds |

Generation, revision, bounded repair and model moderation use this configured
model. Cloudflare Workers AI is used for image-safety inspection, not HTML
generation. Retrieval uses D1 full-text search over curated and eligible
published artifacts; it has no embedding or Vectorize dependency.

The checked-in Wrangler configuration is the source of truth for intended
configuration. Confirm deployed bindings before a pilot because production may
lag behind the repository.

## Teacher-test readiness snapshot — 9 August 2026

The implementation is engineering-ready, but the production release still
needs its final deployment and physical-device acceptance pass.

### Complete

- The HTML artifact rewrite and recovery follow-ups are in this repository.
- Generic iOS Simulator build succeeds.
- `ClassroomWidgetsStudioTests`: 24 passed, 0 failed, 0 skipped.
- API tests: 73 passed.
- All 14 curated examples validate and initialise.
- Production `/health` returns HTTP 200.
- Remote D1 has no pending migrations and contains 14 curated seeds.
- Required Worker secret names are configured: `AI_API_KEY`,
  `DEVICE_TOKEN_SIGNING_SECRET` and `STUDIO_SEED_IMPORT_TOKEN`.
- One active class code exists with aggregate remaining capacity of 99. This
  aggregate check does not establish that it is the intended teacher code.

### Required before handing the app to a teacher

1. **Deploy the current repository head.** Production is still Worker version
   `80f19819-488a-4191-82fe-ffd65f814628`, deployed before the recovery
   follow-ups merged. Do not pilot known older code when the reviewed fixes are
   available.
2. **Run a deliberate live smoke test.** `/health` does not call the model.
   Confirm that the configured DeepSeek key and model can generate, revise,
   publish and revoke one real artifact in production.
3. **Identify or provision the workshop code.** Do not assume the existing
   active code is appropriate for teachers. Follow the pilot runbook and share
   the code only through a secure channel.
4. **Install a Release build on a physical iPad.** No TestFlight/App Store build
   was produced as part of the artifact rewrite.
5. **Complete the physical-device acceptance flow below.** Revoke all test
   publications when finished.

## Physical-device acceptance flow

Use a production Release build on the intended pilot hardware. Across at least
three representative activities, including one simulation:

1. Register the iPad with the intended workshop code.
2. Open and copy a curated example.
3. Complete the guided Make interview and generate a new activity.
4. Interact with the preview, then request a revision. Confirm the previous
   preview remains usable until the replacement succeeds.
5. Restore an earlier revision from History.
6. Add a non-personal image and confirm it renders in the iPad preview.
7. Publish the current revision and open its URL on a separate device in
   Safari.
8. Test portrait and landscape layouts, large text and VoiceOver.
9. Exercise the QR code and share sheet.
10. Revoke the publication and confirm Safari receives the unavailable state.
11. Relaunch the iPad app and confirm local projects and revision history
    recover.

Record failures without including class codes, device tokens, teacher prompts,
student information or unpublished activity source.

## Pilot operating boundaries

- Treat this as a supervised teacher pilot until the physical-device flow has
  passed and a Release build has been distributed.
- Never use real student personal data in briefs, images or generated
  activities.
- Check public content reports according to the response times in the pilot
  runbook.
- A successful `/health` response proves that the Worker starts; it does not
  prove model access, image processing or publication end to end.
- Removing or rotating `AI_API_KEY` stops generation and model moderation but
  leaves existing student publication links available.

Known follow-up work that does not block a supervised teacher test includes a
durable R2 cleanup queue or mark-and-sweep and stronger static understanding of
values assembled dynamically by generated JavaScript. Do not replace either
with unsafe best-effort deletion or execution of model-generated code.

## Licence

Makelet is available under the [MIT Licence](LICENSE).
