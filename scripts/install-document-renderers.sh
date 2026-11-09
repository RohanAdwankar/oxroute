#!/usr/bin/env bash
# Install Ubuntu rendering tools without changing system packages.
set -euo pipefail
root="${XDG_DATA_HOME:-$HOME/.local/share}/oxroute/document-renderers"
bin="${XDG_BIN_HOME:-$HOME/.local/bin}"
mkdir -p "$root/packages" "$bin"
cd "$root/packages"
mapfile -t packages < <(apt-get -s install --no-install-recommends libreoffice-impress poppler-utils | awk '$1 == "Inst" { print $2 }')
apt-get download "${packages[@]}"
for package in *.deb; do dpkg-deb -x "$package" "$root"; done
rm -- *.deb
# Ubuntu configuration contains system paths; relocate this private installation.
for config in "$root"/usr/lib/libreoffice/program/*rc; do
  sed -i "s|file:///usr/lib/libreoffice|file://$root/usr/lib/libreoffice|g; s|file:///etc/libreoffice|file://$root/etc/libreoffice|g" "$config"
done
sed -i 's|etc/libreoffice/registry|usr/lib/libreoffice/share/.registry|g' "$root/usr/lib/libreoffice/program/fundamentalrc"
while IFS= read -r -d '' link; do
  target=$(readlink "$link")
  if [[ "$target" == /* ]]; then ln -sfn "$root$target" "$link"; fi
done < <(find "$root/usr/lib/libreoffice" -type l -print0)
for program in libreoffice pdftoppm pdfinfo; do
  target="usr/bin/$program"
  if [[ "$program" == libreoffice ]]; then target="usr/lib/libreoffice/program/soffice"; fi
  cat > "$bin/$program" <<WRAPPER
#!/usr/bin/env bash
root="\${XDG_DATA_HOME:-\$HOME/.local/share}/oxroute/document-renderers"
export LD_LIBRARY_PATH="\$root/usr/lib/x86_64-linux-gnu:\$root/usr/lib/libreoffice/program\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "\$root/$target" "\$@"
WRAPPER
  chmod +x "$bin/$program"
done
"$bin/libreoffice" --headless --version
"$bin/pdfinfo" -v
