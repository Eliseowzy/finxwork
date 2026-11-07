#!/usr/bin/env bash
# Capture every slide of each deck (default: corpus/*.pptx) from the FinxWork editor canvas.
# Output: tools/ppt-corpus/out/finx/<deck-stem>-<n>.png, 1280px wide.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$here/out/finx"
mkdir -p "$out"
if [ $# -gt 0 ]; then decks=("$@"); else decks=("$here"/corpus/*.pptx); fi
# Native mode (finx kernel) renders EMF/OLE previews; needs target/debug/finx. Override: FINXWORK_E2E_NATIVE=0.
export FINXWORK_E2E_NATIVE="${FINXWORK_E2E_NATIVE:-1}"
fail=0
for deck in "${decks[@]}"; do
  [ -f "$deck" ] || { echo "missing: $deck" >&2; fail=1; continue; }
  start=$(date +%s)
  FINXWORK_E2E_CAPTURE=1 FINXWORK_E2E_PPTX="$(cd "$(dirname "$deck")" && pwd)/$(basename "$deck")" FINXWORK_E2E_SHOTS="$out" \
    pnpm --dir "$repo" --filter @finx/desktop e2e:pptx || { echo "FAILED: $deck" >&2; fail=1; }
  echo "$(basename "$deck"): $(( $(date +%s) - start ))s"
done
exit $fail
