#!/usr/bin/env bash
# Configure + build the spike VST3 with the portable MSVC toolchain on Z:.
# No Visual Studio, no admin. Run from spike/elementary/plugin/.
set -e

MSVC_SETUP='Z:\msvc\msvc\setup_x64.bat'
PIP_SCRIPTS='C:\Users\Serge\AppData\Roaming\Python\Python311\Scripts'   # pip --user cmake + ninja
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_TYPE="${1:-Release}"
DEV_FLAG=""
[ "${2:-}" = "dev" ] && DEV_FLAG="-DELEM_DEV_LOCALHOST=1"

# Refresh the embedded UI+DSP bundle (spike/elementary/dist/).
( cd "$HERE/.." && npm run build:plugin-assets )

# cmd.exe can't take our bash quoting; drive it through a temp .bat.
BAT="$(mktemp --suffix=.bat)"
cat > "$BAT" <<EOF
@echo off
call "${MSVC_SETUP}"
set PATH=${PIP_SCRIPTS};%PATH%
cmake -S "$(cygpath -w "$HERE")" -B "$(cygpath -w "$HERE")\\build" -G Ninja ^
  -DCMAKE_BUILD_TYPE=${BUILD_TYPE} -DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl ^
  -DCMAKE_MAKE_PROGRAM=ninja -DCMAKE_POLICY_VERSION_MINIMUM=3.5 ${DEV_FLAG}
if errorlevel 1 exit /b 1
cmake --build "$(cygpath -w "$HERE")\\build" --config ${BUILD_TYPE} -j 6
if errorlevel 1 exit /b 1
echo NITESESH_BUILD_OK
EOF

# CRLF, and this is not cosmetic. cmd.exe mis-parses an LF-only batch file: it
# consumes the CR it expects and swallows the first TWO characters of every
# line instead ("call" -> "all", "set" -> "et", "cmake" -> "make"), so the
# whole toolchain step dies with a screenful of "'cho' is not recognized" while
# cmd.exe still exits 0. This is the "nitesesh run could not build" trap, and
# it is invisible from the artefact list because `npm run build:plugin-assets`
# above has already refreshed dist/ - only the binary is stale.
awk '{ printf "%s\r\n", $0 }' "$BAT" > "$BAT.crlf" && mv "$BAT.crlf" "$BAT"

# `/c` with MSYS_NO_PATHCONV=1 -- deliberately, and it is the only form that
# works in both path-conversion modes. With conversion ON, a bare `/c` is
# rewritten to `C:/` and cmd.exe ignores it; with conversion OFF (the agent /
# Hermes shell) `//c` is passed through verbatim, cmd.exe calls it an unknown
# switch, starts an INTERACTIVE shell and exits 0 at EOF.
# A running FAEZ.exe can't be overwritten but CAN be renamed. If a previous run was
# set aside as FAEZ.running-*.old and that process has since exited, clear it away.
rm -f "$HERE/build/FAEZ_artefacts/Release/Standalone/"*.old 2>/dev/null || true
LOG="$(mktemp --suffix=.log)"
rc=0
MSYS_NO_PATHCONV=1 cmd.exe /c "$(cygpath -w "$BAT")" 2>&1 | tee "$LOG" || rc=$?
rm -f "$BAT"

# cmd.exe exits 0 whether or not the batch actually did anything, so success is
# asserted on the token the batch prints as its LAST statement (and the `exit
# /b 1`s above guarantee a failing cmake never reaches it), not on the exit
# code and not on a stale artefact timestamp.
if [ "$rc" -eq 0 ] && ! grep -q NITESESH_BUILD_OK "$LOG"; then
  echo "BUILD FAILED: the toolchain step did not run to completion (no success token in its output)." >&2
  rc=1
fi
# ninja prints this when ANY target failed (the batch still reaches its final
# `echo`, so the token alone is not enough). The usual cause is a running
# FAEZ.exe locking the standalone's output (LNK1104) while the VST3 --
# built and installed first -- is fine.
if grep -q "ninja: build stopped" "$LOG"; then
  echo "BUILD FAILED: a target did not build (see ninja output above; LNK1104 = close the running FAEZ.exe)." >&2
  rc=1
fi
rm -f "$LOG"

echo
echo "artefacts:"
find "$HERE/build/FAEZ_artefacts" \( -name "*.vst3" -o -name "FAEZ.exe" \) -type f 2>/dev/null || true
exit $rc
