#!/usr/bin/env bash
#
# Install oxroute for the current user, without disturbing anything that is
# already running.
#
# It builds the binaries, installs the systemd units, and imports the Slack
# bot's state -- but it does not start or enable anything, and it does not
# stop the Slack bot. Both can run side by side until you decide to switch,
# because the import only reads the old database.
#
#   deploy/install.sh              binaries, units, import
#   deploy/install.sh --with-web   also build and install the web UI
#
set -euo pipefail

source_dir=$(cd "$(dirname "$0")/.." && pwd)
bin_dir="$HOME/.local/bin"
unit_dir="$HOME/.config/systemd/user"
config_dir="$HOME/.config/oxroute"
share_dir="$HOME/.local/share/oxroute"
with_web=false

for argument in "$@"; do
  case "$argument" in
    --with-web) with_web=true ;;
    *) echo "unknown option $argument" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$1"; }

say "building"
cargo build --release --manifest-path "$source_dir/Cargo.toml"

say "installing binaries into $bin_dir"
mkdir -p "$bin_dir"
install -m 0755 "$source_dir/target/release/oxrouted" "$bin_dir/oxrouted"
install -m 0755 "$source_dir/target/release/oxroute" "$bin_dir/oxroute"

mkdir -p "$config_dir" "$unit_dir" "$share_dir"
install -d -m 0700 "$share_dir/tmp" "$HOME/.local/state/oxroute"

if [ ! -f "$config_dir/env" ]; then
  say "writing a starter $config_dir/env"
  install -m 0600 "$source_dir/deploy/oxroute.env.example" "$config_dir/env"
  echo "   edit it before starting: OXROUTE_OWNER and the two Slack tokens"
fi
if [ ! -f "$config_dir/codex.env" ]; then
  install -m 0600 "$source_dir/deploy/oxroute-codex.env.example" "$config_dir/codex.env"
fi

say "installing systemd units"
install -m 0644 "$source_dir/deploy/oxroute-codex.service" "$unit_dir/oxroute-codex.service"
install -m 0644 "$source_dir/deploy/oxroute.service" "$unit_dir/oxroute.service"
if [ "$with_web" = true ]; then
  say "building the web UI"
  ( cd "$source_dir" && npm ci && npm run build )
  # `next start` needs the build output, the manifest, the config and the
  # runtime deps -- and nothing else. Replace the directory wholesale rather
  # than syncing into it, so a file dropped from one release does not linger.
  rm -rf "$share_dir/web"
  mkdir -p "$share_dir/web"
  for item in .next package.json package-lock.json next.config.ts node_modules; do
    cp -R "$source_dir/$item" "$share_dir/web/$item"
  done
  [ -d "$source_dir/public" ] && cp -R "$source_dir/public" "$share_dir/web/public"
  install -m 0644 "$source_dir/deploy/oxroute-web.service" "$unit_dir/oxroute-web.service"
fi
systemctl --user daemon-reload

say "importing the Slack bot's state"
# Reads the old database, writes only oxroute's. Safe to run again.
set +e
"$bin_dir/oxrouted" migrate
set -e

cat <<'NEXT'

== next
  1. edit ~/.config/oxroute/env
  2. oxrouted doctor                      # check what it found
  3. systemctl --user stop codex-slack    # when you are ready to switch
  4. systemctl --user enable --now oxroute
  5. point the Slack app at oxroute, or use a second app -- see MIGRATING.md

  The TUI is `oxroute`. The web UI, if installed, is on 127.0.0.1:3939.
NEXT
