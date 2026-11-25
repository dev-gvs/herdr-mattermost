#!/bin/bash
# Records a demo video of the sandbox: grabs screenshots while the steps run, then encodes them. See AGENTS.md.
# Usage: test/record.sh OUT.mp4 STEPS...   (steps as for `sandbox.sh in`; the sandbox must already be running)
set -eu
OUT=$1
shift
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
F=/var/tmp/mmt/rec
rm -rf "$F" && mkdir -p "$F"

start=$(date +%s.%N)
(
  i=0
  while :; do
    "$HERE/sandbox.sh" run herdr-app shot "$F/$(printf %05d $i).png" >/dev/null 2>&1 || true
    i=$((i + 1))
  done
) &
grabber=$!
trap 'kill $grabber 2>/dev/null || true' EXIT

sleep 1
"$HERE/sandbox.sh" in "$@"
sleep 1.5
kill $grabber
trap - EXIT
wait $grabber 2>/dev/null || true
end=$(date +%s.%N)

n=$(ls "$F" | wc -l)
# Grabs take as long as they take, so the real rate is frames over time.
fps=$(python3 -c "print(round($n / ($end - $start), 3))")
echo "frames: $n, fps: $fps"
ffmpeg -y -loglevel error -framerate "$fps" -i "$F/%05d.png" -vf "fps=30,scale=1280:-2,format=yuv420p" \
  -c:v libx264 -crf 24 -preset slow -movflags +faststart "$OUT"
ls -la "$OUT"
