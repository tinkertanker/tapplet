# Tapplet Studio for iPad

Tapplet Studio is a native SwiftUI iPad app. The generated Xcode project is not source controlled.

## Setup and test

Install Xcode and XcodeGen 2.44.1. No Node installation or `npm ci` is required:

```bash
cd apps/ipad
xcodegen generate
xcodebuild -project Tapplet.xcodeproj -scheme Tapplet \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Run `TappletTests` on an available iPad simulator with `-only-testing:TappletTests test`.

## Structure

- `Sources`: app, API client, local store, editor, preview and image workflow
- `Resources/Examples`: canonical rich manifest and bundled HTML examples
- `Tests` / `UITests`: native tests
- `project.yml`: Tapplet project, targets, schemes, bundle IDs and API configuration

Bundled examples and locally saved tapplets preview offline. Generation, server history/recovery and publication require the Tapplet API. Debug uses simulator loopback by default. For a physical iPad, set `TAPPLET_API_BASE_URL` to a host reachable on its network; `127.0.0.1` means the iPad itself. Release uses the deployed API unless overridden.

Automatic signing uses the configured development team. Simulator builds can disable signing with `CODE_SIGNING_ALLOWED=NO`; device and archive builds require an appropriate team/profile. Never commit credentials, class-access codes or device tokens.

## Xcode Cloud and TestFlight

App Store Connect app **Tapplet Studio** (`6804056340`, bundle
`sg.tinkertanker.Tapplet`) is connected to this repository. The **TestFlight**
workflow is manually triggered from `master`: clean iOS Archive, shared `Tapplet`
scheme, Release configuration, and App Store-eligible distribution. It does not
run on pushes or enable public/external testing.

`ci_scripts/ci_post_clone.sh` downloads checksum-verified XcodeGen 2.44.1 and
generates `Tapplet.xcodeproj` before the build. It needs no Node installation,
`sudo`, signing certificates, or API secrets in Xcode Cloud. Keep `project.yml`
as the source of truth and the generated project out of Git.

Xcode Cloud manages signing and build numbers. Before the first Cloud upload,
set **Xcode Cloud → Settings → Build Number → Next Build Number** to at least
`2`: version `0.1.0 (1)` already exists in TestFlight. When mixing Cloud and local
uploads, check both build histories to avoid reusing a version/build pair.

For API management with the `asc` CLI, the Amp environment's existing Apple API
key variables can be mapped without writing a credential file:

```bash
export ASC_KEY_ID="$APPLE_API_KEY_ID"
export ASC_ISSUER_ID="$APPLE_API_KEY_ISSUER_ID"
export ASC_PRIVATE_KEY="$APPLE_API_KEY_P8"
export ASC_APP_ID=6804056340

asc xcode-cloud workflows --app "$ASC_APP_ID"
asc xcode-cloud run --app "$ASC_APP_ID" --workflow TestFlight --branch master
# Use the exact run ID returned above, not the latest build for the app.
asc xcode-cloud status --run-id "$RUN_ID" --wait
asc xcode-cloud build-runs builds --run-id "$RUN_ID"
asc builds wait --build-id "$BUILD_ID"
```

A successful archive/upload is not approval for external testing. Follow the
[TestFlight release gate](../../docs/TAPPLET_PILOT_RUNBOOK.md#testflight-release-gate)
before assigning groups or submitting Beta App Review. No public testing group
or App Store release post-action is configured by this workflow.
