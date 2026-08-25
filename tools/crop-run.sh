#!/usr/bin/env bash
# Draw a crop, cut it into six stages, and fit it to the box the game expects.
#
# The generator ignores the layout it is asked for often enough that the cutter
# refuses roughly one sheet in three — it wants exactly six drawings and says so
# rather than handing the game a leaf. So a failed cut is a reason to draw again,
# not to press on, and that is what this does.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/tools/.venv/bin/python"
name="$1"; shift
subject="$*"

for attempt in 1 2 3; do
  echo "  $name (attempt $attempt)"
  node "$ROOT/tools/generate-art.mjs" --sheet "$name" "$subject" >/dev/null 2>&1 || { echo "    the drawing failed"; continue; }
  if "$PY" "$ROOT/tools/split-sheet.py" "$name" >/dev/null 2>&1; then
    "$PY" "$ROOT/tools/prep-crops.py" "$name" 2>&1 | tail -1
    exit 0
  fi
  echo "    the sheet did not come back as six drawings, asking again"
done
echo "  $name: gave up after three sheets"
exit 1
