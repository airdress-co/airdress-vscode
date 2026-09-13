#!/usr/bin/env bash
# vsc.sh <command> [json-args-array] | vsc.sh --info | vsc.sh --diagnostics
set -euo pipefail
DIR="${AIRDRESS_DEV_DRIVER_DIR:-$(cd "$(dirname "$0")/../.." && pwd)/.dev-host/driver-io}"
id="$(date +%s%N)"
if [ "${1:-}" = "--diagnostics" ]; then printf '{"diagnostics":true}' > "$DIR/cmd-$id.json.tmp"
elif [ "${1:-}" = "--info" ]; then printf '{"info":true}' > "$DIR/cmd-$id.json.tmp"
else
  printf '{"command":%s,"args":%s}' "$(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" "${2:-[]}" > "$DIR/cmd-$id.json.tmp"
fi
mv "$DIR/cmd-$id.json.tmp" "$DIR/cmd-$id.json"
for _ in $(seq 1 260); do
  if [ -f "$DIR/res-$id.json" ]; then cat "$DIR/res-$id.json"; echo; rm -f "$DIR/res-$id.json"; exit 0; fi
  sleep 0.25
done
echo "no reply from driver" >&2; exit 1
