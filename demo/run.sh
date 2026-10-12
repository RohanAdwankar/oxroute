#!/usr/bin/env bash
# Refresh the README film. The inbox take is retained; new features use
# the current UI and fixture data, without a daemon or inference calls.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${OXROUTE_DEMO_OUT:-$PWD/demo/out}"
mkdir -p "$out"
export OXROUTE_DEMO_OUT="$out"
export OXROUTE_WEB_VERSION="$(git rev-parse --short HEAD)"
web=""
cleanup() { if [[ -n "$web" ]]; then kill "$web" 2>/dev/null || true; wait "$web" 2>/dev/null || true; fi; }
trap cleanup EXIT
trap 'exit 130' INT TERM
if [[ -z "${OXROUTE_DEMO_URL:-}" ]]; then
  export OXROUTE_DIST=.next-demo
  node node_modules/next/dist/bin/next build --webpack > "$out/build.log" 2>&1
  port="${OXROUTE_DEMO_PORT:-3941}"
  export OXROUTE_DEMO_URL="http://127.0.0.1:$port"
  node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port "$port" > "$out/web.log" 2>&1 &
  web=$!
  for _ in $(seq 1 60); do
    kill -0 "$web"
    if curl -sf "$OXROUTE_DEMO_URL" > /dev/null; then break; fi
    sleep 1
  done
fi
node demo/record-features.mjs
ffmpeg="$(uv run --with imageio-ffmpeg python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"
"$ffmpeg" -hide_banner -loglevel error -y -i demo/inbox.mp4 -i "$out/features.webm" \
  -filter_complex '[0:v]fps=30,setsar=1[a];[1:v]scale=1440:900:flags=lanczos,fps=30,setsar=1[b];[b][a]concat=n=2:v=1:a=0[v]' \
  -map '[v]' -c:v libx264 -crf 23 -preset medium -pix_fmt yuv420p -movflags +faststart demo/demo.mp4
"$ffmpeg" -hide_banner -loglevel error -y -i demo/demo.mp4 \
  -vf 'fps=6,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3' \
  -loop 0 demo/demo.gif
echo "Wrote demo/demo.mp4, demo/demo.gif and $out/*.png"
