# Tapplet

**Create tiny interactive applets for any lesson.**

Tapplet is a teacher-facing iPad app for generating, adapting, previewing and
sharing self-contained interactive classroom activities. It is an open-source
project by [Tinkercademy](https://tinkercademy.com).

Born from the Tinkercademy co-founders' experience as physics
teachers searching for kinematics Java applets, Tapplet lets
teachers create the exact tool a lesson needs. The name combines "tapping" with
"applet". Amazing!

The app uses the Tapplet API for generation, keeps projects available for
offline preview and publishes unlisted links that students can open in a
browser.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/ipad` | SwiftUI teacher app |
| `services/studio-api` | Cloudflare Worker API, D1 migrations and tests |
| `examples/studio-html` | Canonical reviewed activity corpus |
| `evals` | Artifact and model evaluation harnesses |
| `scripts` | Seed, verification and workshop-provisioning tools |
| `docs` | Product contract and pilot operations |

Some paths and deployed identifiers retain the internal name `Studio` to avoid
an infrastructure migration.

## Setup

Use Node.js 22.12 or newer on the Node 22 release line.

```bash
npm ci
npm run verify
```

`npm run verify` runs the offline tests, type checks, seed validation, artifact
evaluation and iPad resource checks. It does not call the configured model or
production services.

## Build and test the iPad app

Install [XcodeGen](https://github.com/yonaskolb/XcodeGen), then run:

```bash
npm run ipad:prepare
```

This copies the reviewed HTML examples into the app and generates
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

The Debug configuration uses `http://127.0.0.1:8787`; Release uses the
production API. Set `STUDIO_API_BASE_URL` in the process environment to
override either value, and remove the override before validating a Release
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

## Documentation

- [`docs/TAPPLET_V1.md`](docs/TAPPLET_V1.md) — product, artifact and system
  contracts
- [`docs/TAPPLET_PILOT_RUNBOOK.md`](docs/TAPPLET_PILOT_RUNBOOK.md) — deployment,
  physical-device acceptance, safety response and rollback
- [`services/studio-api/wrangler.jsonc`](services/studio-api/wrangler.jsonc) —
  non-secret production model, quota and binding configuration

## Licence

Tapplet is available under the [MIT Licence](LICENSE).
