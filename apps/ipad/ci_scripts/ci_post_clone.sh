#!/bin/bash
set -euo pipefail

# Match the generator pinned in GitHub CI; Xcode Cloud does not permit sudo.
TOOLS_DIR=$(mktemp -d)
trap 'rm -rf "$TOOLS_DIR"' EXIT
curl -fsSL --retry 3 \
  https://github.com/yonaskolb/XcodeGen/releases/download/2.44.1/xcodegen.zip \
  -o "$TOOLS_DIR/xcodegen.zip"
echo "a2e905fb68446e9bb4008cdfe2e13e3f176d0cbcca828b71770f8e53fca91b73  $TOOLS_DIR/xcodegen.zip" \
  | shasum -a 256 -c -
unzip -q "$TOOLS_DIR/xcodegen.zip" -d "$TOOLS_DIR"
XCODEGEN="$TOOLS_DIR/xcodegen/bin/xcodegen"
test "$("$XCODEGEN" --version)" = "Version: 2.44.1"

"$XCODEGEN" generate \
  --spec "$CI_PRIMARY_REPOSITORY_PATH/apps/ipad/project.yml" \
  --project "$CI_PRIMARY_REPOSITORY_PATH/apps/ipad"
