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
workflow (`0E83B0DB-ABBE-4BDF-A3E9-93619342ABAC`) automatically starts on changes
to `master`: clean iOS Archive, shared `Tapplet` scheme, Release configuration,
and **TestFlight Internal Only** distribution (`INTERNAL_ONLY`). It does not
start for pull requests, tags, schedules, or other branches. New qualifying
changes cancel or skip superseded builds.

The Branch Changes condition uses **Files and Folders → Custom Conditions →
Start a Build** (`START_IF_ANY_FILE_MATCHES`) for these paths:

- Any file recursively under `apps/ipad/Sources`, `apps/ipad/Resources`,
  `apps/ipad/Tests`, `apps/ipad/UITests`, or `apps/ipad/ci_scripts`.
- Files named `project.yml`, `Info.plist`, or `ExportOptions.plist` under
  `apps/ipad`.

`Resources/Examples` is the canonical bundled corpus, so example changes qualify
without watching generated API fixtures. API-only changes, `docs/**`, and
`apps/ipad/README.md` do not qualify. Update the workflow's path list when adding
app inputs outside these locations. These settings live in App Store Connect;
editing this README does not change them.

`ci_scripts/ci_post_clone.sh` downloads checksum-verified XcodeGen 2.44.1 and
generates `Tapplet.xcodeproj` before the build. It needs no Node installation,
`sudo`, signing certificates, or API secrets in Xcode Cloud. Keep `project.yml`
as the source of truth and the generated project out of Git.

Xcode Cloud manages signing and monotonically increasing build numbers. On
6 November 2026, when automation was enabled, both the highest Cloud run and
highest TestFlight upload were `6` (the upload was `VALID`). The subsequent
[PR #55 merge](https://github.com/tinkertanker/tapplet/pull/55) automatically
started Cloud build `7` with `startReason: GIT_REF_CHANGE`; no counter reset or
synthetic trigger commit was needed. Before mixing Cloud and local uploads,
check both histories and keep **Xcode Cloud → Settings → Build Number → Edit
Next Build Number** above every uploaded or reserved build number. The public
API exposes build history, but not this setting; confirm it in App Store Connect
and never reset it to the old initial value of `2`.

**Internal tester delivery still needs one-time setup by the release owner.**
The 6 November API audit found no internal group; the existing external group
was left unchanged. The API can configure start conditions and the archive
audience, but does not expose workflow post-actions. In App Store Connect:

1. Open **Tapplet Studio → TestFlight → Internal Testing → +**, create an
   internal group, and add the intended App Store Connect users as testers.
2. Open **Xcode Cloud → Manage Workflows → TestFlight → Edit → Post-Actions**.
   Add **TestFlight Internal Testing**, select that internal group and the iOS
   archive, then save. Do not add an external-testing post-action.
3. After the next qualifying `master` change, verify the run's commit and
   `startReason: GIT_REF_CHANGE`, its uploaded build's `processingState: VALID`
   and `buildAudienceType: INTERNAL_ONLY`, and availability to the chosen group.

Automatic archive/upload is configured; automatic delivery to testers is not
verified until this setup and a qualifying build succeed. A group's automatic
distribution checkbox alone does not distribute Xcode Cloud builds; use the
workflow post-action, or manually add the exact processed build to the group.

For API management with the `asc` CLI, the Amp environment's existing Apple API
key variables can be mapped without writing a credential file:

```bash
export ASC_KEY_ID="$APPLE_API_KEY_ID"
export ASC_ISSUER_ID="$APPLE_API_KEY_ISSUER_ID"
export ASC_PRIVATE_KEY="$APPLE_API_KEY_P8"
export ASC_APP_ID=6804056340

asc xcode-cloud workflows --app "$ASC_APP_ID"
# Optional manual rebuild; normally wait for a qualifying master change.
asc xcode-cloud run --app "$ASC_APP_ID" --workflow TestFlight --branch master
# Use the exact run ID returned above, not the latest build for the app.
read -r -p 'Run ID returned above: ' RUN_ID
asc xcode-cloud status --run-id "$RUN_ID" --wait
asc xcode-cloud build-runs builds --run-id "$RUN_ID"
read -r -p 'Build ID from that run: ' BUILD_ID
asc builds wait --build-id "$BUILD_ID" --fail-on-invalid
```

A usable upload must finish with `processingState: VALID`.

A successful archive/upload is not approval for external testing. Follow the
[TestFlight release gate](../../docs/TAPPLET_PILOT_RUNBOOK.md#testflight-release-gate)
before assigning external groups or submitting Beta App Review. Internal-only
builds cannot be promoted to external testing or the App Store: an approved
external release needs a separate App Store-eligible archive. Keep this automatic
workflow internal-only. Existing external groups and Beta App Review remain
manually managed.
