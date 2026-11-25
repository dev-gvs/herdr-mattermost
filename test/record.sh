#!/bin/bash
# Records one of the README's demo videos in a fresh sandbox at twice the usual size, then renders it. See AGENTS.md.
# Usage: test/record.sh demo|demo-jira OUT.mp4   (RENDER_ONLY=1 renders the last recording again)
set -eu
SCENARIO=$1
OUT=$2
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
REC=/var/tmp/mmt-rec/$SCENARIO

if [ -z "${RENDER_ONLY:-}" ]; then
  SCREEN_W=2560 SCREEN_H=1640 ZOOM=2.46 "$HERE/sandbox.sh" start "$SCENARIO"
  python3 -I "$HERE/demo_video.py" prepare
  # A fresh process, so the panel starts from the patched copy and without the "Updated to" toast.
  "$HERE/sandbox.sh" restart "$SCENARIO"
  rm -rf "$REC"
  python3 -I "$HERE/demo_video.py" record "$SCENARIO" "$REC"
fi
python3 -I "$HERE/demo_video.py" render "$REC" "$OUT"
