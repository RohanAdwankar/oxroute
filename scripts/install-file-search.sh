#!/usr/bin/env bash
# Place ripgrep on the daemon's user-service PATH without system package changes.
set -euo pipefail
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cd "$stage"
apt-get download ripgrep
for package in *.deb; do dpkg-deb -x "$package" unpacked; done
install -Dm755 unpacked/usr/bin/rg "${XDG_BIN_HOME:-$HOME/.local/bin}/rg"
