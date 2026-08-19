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
