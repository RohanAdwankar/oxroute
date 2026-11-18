#!/usr/bin/env bash
# Install the tracked Stable-channel browser release and its scoped host policy.
# This does not start browsers, restart services, or change global kernel policy.
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Administrator authentication is required to install the browser and AppArmor profile.' >&2; exit 1; }
source_dir=$(cd "$(dirname "$0")" && pwd)
root=/opt/oxroute-browser
for command in curl jq unzip flock apparmor_parser; do command -v "$command" >/dev/null; done
test -f /etc/apparmor.d/abi/4.0 || { echo 'This installer requires AppArmor 4.0 support.' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) platform=linux64; archive_dir=chrome-linux64 ;;
  aarch64) platform=linux-arm64; archive_dir=chrome-linux-arm64 ;;
  *) echo 'Unsupported browser architecture' >&2; exit 1 ;;
esac
version=$(jq -er '.version' "$source_dir/browser-release.json")
url=$(jq -er --arg platform "$platform" '.downloads[$platform]' "$source_dir/browser-release.json")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
test "$url" = "https://storage.googleapis.com/chrome-for-testing-public/$version/$platform/$archive_dir.zip"
# Refuse writable/symlinked system parents before installing a security policy.
for directory in /opt "$root" "$root/releases"; do
  if test -e "$directory" || test -L "$directory"; then
    test -d "$directory" && ! test -L "$directory"
    test "$(stat -c %u "$directory")" = 0
    test "$(( 8#$(stat -c %a "$directory") & 022 ))" = 0
  else
    install -d -o root -g root -m 0755 "$directory"
  fi
done
exec 9>"$root/install.lock"
flock 9
destination="$root/releases/$version-$platform"
if ! test -d "$destination"; then
  # Headroom for the downloaded archive and extracted browser; fail before download.
  test "$(df -Pk "$root" | awk 'NR==2 {print $4}')" -ge 1048576 || { echo 'Browser installation requires 1 GiB free on /opt.' >&2; exit 1; }
  stage=$(mktemp -d "$root/.install.XXXXXX")
  trap 'rm -rf -- "$stage"' EXIT
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' "$url" -o "$stage/browser.zip"
  unzip -tq "$stage/browser.zip"
  unzip -q "$stage/browser.zip" -d "$stage/unpacked"
  test -x "$stage/unpacked/$archive_dir/chrome"
  chown -hR root:root "$stage/unpacked/$archive_dir"
  chmod -R u+rwX,go+rX,go-w,a-s "$stage/unpacked/$archive_dir"
  mv "$stage/unpacked/$archive_dir" "$destination"
fi
test ! -L "$destination"
test "$(stat -c %u "$destination")" = 0
test "$(( 8#$(stat -c %a "$destination") & 022 ))" = 0
test "$(stat -c %u "$destination/chrome")" = 0
test "$(( 8#$(stat -c %a "$destination/chrome") & 022 ))" = 0
apparmor_parser --skip-kernel-load --skip-cache "$source_dir/oxroute-browser.apparmor"
install -o root -g root -m 0644 "$source_dir/oxroute-browser.apparmor" /etc/apparmor.d/oxroute-browser
apparmor_parser -r -T /etc/apparmor.d/oxroute-browser
ln -s "releases/$version-$platform" "$root/.current.$$"
mv -Tf "$root/.current.$$" "$root/current"
printf 'Installed browser %s with scoped AppArmor user namespace permission.\nExecutable: %s/current/chrome\n' "$version" "$root"
