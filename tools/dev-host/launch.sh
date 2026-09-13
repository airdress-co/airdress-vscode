#!/usr/bin/env bash
# Launch the isolated Extension Development Host with this extension AND
# the file-drop driver loaded, state under <repo>/.dev-host (gitignored,
# survives reboots — a /tmp scratch dir did not, 2026-09-13).
#
#   tools/dev-host/launch.sh            # start (or focus) the dev host
#   tools/dev-host/vsc.sh --info        # is the driver answering?
#   tools/dev-host/vsc.sh <command> '[json args]'
#
# The sign-in lives in .dev-host/udd (SecretStorage + globalState), so
# it persists across launches. Delete .dev-host to start from nothing.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/.dev-host"
mkdir -p "$STATE/udd/User" "$STATE/ext" "$STATE/driver-io" "$STATE/shots"
chmod 700 "$STATE/driver-io"
if [ ! -f "$STATE/udd/User/settings.json" ]; then
  cat > "$STATE/udd/User/settings.json" <<'JSON'
{
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "airdress.auth.route": "loopback",
  "extensions.autoCheckUpdates": false,
  "chat.commandCenter.enabled": false,
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "chat.setupFromDialog": false
}
JSON
fi
[ -f "$REPO/dist/extension.js" ] || { echo "dist/ missing — run: npm run compile" >&2; exit 1; }
# --flag=value throughout: the snap wrapper mis-parses "--flag value" (CONTRIBUTING.md).
exec code \
  --user-data-dir="$STATE/udd" \
  --extensions-dir="$STATE/ext" \
  --extensionDevelopmentPath="$REPO" \
  --extensionDevelopmentPath="$REPO/tools/dev-host/driver-ext" \
  --new-window "$@" > "$STATE/launch.log" 2>&1 &
