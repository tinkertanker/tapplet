# Tapplet for iPad

Tapplet is the teacher-facing iPad app for generating, revising, previewing and
publishing self-contained HTML classroom activities. The iPad app does not run
a model locally: it authenticates to the Tapplet API, keeps projects available
for offline preview and publishes unlisted links for students to open in
Safari.

Product and operational details live in:

- [`../../docs/TAPPLET_V1.md`](../../docs/TAPPLET_V1.md) — product and artifact
  contract;
- [`../../docs/TAPPLET_PILOT_RUNBOOK.md`](../../docs/TAPPLET_PILOT_RUNBOOK.md) —
  production provisioning, safety response and rollback;
- [`../../services/studio-api/wrangler.jsonc`](../../services/studio-api/wrangler.jsonc)
  — authoritative non-secret production model and quota configuration.

## Build and test

The Xcode project is generated. From the repository root:

```bash
npm ci
npm run ipad:prepare
```

`ipad:prepare` copies the 14 reviewed HTML examples into the app and generates
`apps/ipad/ClassroomWidgetsStudio.xcodeproj` with XcodeGen. The generated
project, target names and bundle identifier retain their pre-extraction
`ClassroomWidgetsStudio` names for compatibility; the installed app is named
Tapplet.

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
configuration uses the production API at:

```text
https://classroom-widgets-studio-api.tinkertanker.workers.dev
```

`STUDIO_API_BASE_URL` in the process environment overrides the value embedded
in the app. Remove any local override before validating a production Release
build.

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
lag behind `master`.

## Teacher-test readiness snapshot — 9 August 2026

The implementation is engineering-ready, but the production release still
needs its final deployment and physical-device acceptance pass.

### Complete

- Generic iOS Simulator build succeeds.
- `ClassroomWidgetsStudioTests`: 24 passed, 0 failed, 0 skipped.
- API tests: 73 passed.
- All 14 curated examples validate and initialise.
- Production `/health` returns HTTP 200.
- Remote D1 has no pending migrations and contains 14 curated seeds.

### Required before handing the app to a teacher

1. Deploy the current repository head; production predates the reviewed
   recovery fixes.
2. Run a deliberate production generate, revise, publish and revoke smoke test.
3. Identify or provision the workshop code through the pilot runbook.
4. Install a Release build on a physical iPad.
5. Complete the physical-device acceptance flow in the root README and revoke
   all test publications.

Never put class codes, device tokens, teacher prompts, student information or
unpublished activity source into issues, commits, chat logs or screenshots.
