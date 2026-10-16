#!/usr/bin/env bash
# Build the FAEZ Windows installer.
#   bash installer/build-installer.sh            -> installer/dist/FAEZ - Windows Setup v<version>.exe
#   bash installer/build-installer.sh --test     -> same, but a NON-ELEVATED build (EXEC_LEVEL=user) used
#                                                   for unattended test installs; never publish that one.
# Run `bash plugin/build.sh` first (both binaries must be fresh).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELEM="$(cd "$HERE/.." && pwd)"
REL="$ELEM/plugin/build/FAEZ_artefacts/Release"
cd "$HERE"          # NSIS gets RELATIVE paths: the project path contains a non-ASCII "·"

# ---- version (single source of truth: CMakeLists project(... VERSION x.y.z)) ----
VERSION="$(grep -oE 'project\(FAEZ VERSION [0-9]+\.[0-9]+\.[0-9]+' "$ELEM/plugin/CMakeLists.txt" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
[ -n "$VERSION" ] || { echo "cannot read VERSION from CMakeLists.txt" >&2; exit 1; }

# ---- makensis: PATH, else the copy electron-builder cached ----
MAKENSIS="$(command -v makensis || true)"
[ -n "$MAKENSIS" ] || MAKENSIS="$(find "${LOCALAPPDATA:-$HOME/AppData/Local}/electron-builder/Cache" -iname makensis.exe 2>/dev/null | head -1)"
[ -n "$MAKENSIS" ] || { echo "makensis not found (install NSIS, or run an electron-builder build once to cache it)" >&2; exit 1; }

# ---- inputs must exist and must NOT be stale ----
BIN="$ELEM/plugin/wavetables.bin"
[ -f "$BIN" ] || { echo "plugin/wavetables.bin missing: run 'npm run build:wavetables'" >&2; exit 1; }
need() { [ -f "$1" ] || { echo "missing build artefact: $1  (run plugin/build.sh)" >&2; exit 1; }; }
need "$REL/Standalone/FAEZ.exe"
need "$REL/VST3/FAEZ.vst3/Contents/x86_64-win/FAEZ.vst3"
for f in "$REL/Standalone/wavetables.bin" "$REL/VST3/FAEZ.vst3/Contents/x86_64-win/wavetables.bin"; do
  cmp -s "$BIN" "$f" || { echo "STALE: $f differs from plugin/wavetables.bin (rebuild with plugin/build.sh)" >&2; exit 1; }
done
# The UI / DSP / manifest are EMBEDDED verbatim in both binaries (juce_add_binary_data), so
# check by CONTENT that each binary holds the current dist/ files (mtimes lie: the assets
# step rewrites identical files). A stale exe would otherwise ship an old UI.
node - "$ELEM" "$REL" "${1:-}" "${ALLOW_STALE:-}" <<'JS' || exit 1
const fs = require('fs');
const [elem, rel, mode, allow] = process.argv.slice(2);
const bins = [rel + '/Standalone/FAEZ.exe', rel + '/VST3/FAEZ.vst3/Contents/x86_64-win/FAEZ.vst3'];
const bad = [];
for (const b of bins) {
  const data = fs.readFileSync(b);
  for (const name of ['index.html', 'dsp.main.js', 'manifest.json']) {
    const src = fs.readFileSync(`${elem}/dist/${name}`);
    if (data.indexOf(src) < 0) bad.push([b, name]);   // the WHOLE file, byte for byte (a slice can be unchanged)
  }
}
if (bad.length && !(mode === '--test' && allow === '1')) {
  for (const [b, n] of bad) console.error(`STALE: ${b} does not contain the current dist/${n} (rebuild with plugin/build.sh)`);
  process.exit(1);
}
JS

# ---- VC++ runtime (bundled so a fresh PC works); signature-checked ----
VC="$HERE/deps/vc_redist.x64.exe"
if [ ! -f "$VC" ]; then
  mkdir -p "$HERE/deps"
  powershell.exe -NoProfile -Command "Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile '$(cygpath -w "$VC")' -UseBasicParsing"
fi
powershell.exe -NoProfile -Command "\$s=Get-AuthenticodeSignature '$(cygpath -w "$VC")'; if(\$s.Status -ne 'Valid' -or \$s.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){ Write-Error 'vc_redist signature invalid'; exit 1 }"

# ---- name per release convention:  <Product> - <Platform> v<version>.<ext> ----
mkdir -p dist
LEVEL=admin; OUT="FAEZ - Windows Setup v${VERSION}.exe"
if [ "${1:-}" = "--test" ]; then LEVEL=user; OUT="TEST-FAEZ-Setup-v${VERSION}-nonelevated.exe"; fi
rm -f "dist/$OUT"

MSYS_NO_PATHCONV=1 "$MAKENSIS" -V2 \
  "-DVERSION=$VERSION" "-DEXEC_LEVEL=$LEVEL" \
  "-DOUTFILE=dist\\$OUT" \
  "-DBUILD_DIR=..\\plugin\\build\\FAEZ_artefacts\\Release" \
  FAEZ.nsi

ls -la "dist/$OUT" | awk '{printf "%.1f MB  %s\n", $5/1048576, $9" "$10" "$11" "$12" "$13}'
echo "INSTALLER_OK dist/$OUT"
