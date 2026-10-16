#!/usr/bin/env bash
#
# scripts/build-loopback-helper.sh
#
# Builds the WASAPI loopback helper for Faze. We use the official
# `dotnet-install.ps1` so users don't need Visual Studio Build Tools.
# Result: framework-dependent .NET 8 self-bearing apphost + NAudio DLL
# in ./loopback-build/ (already in .gitignore; rerun this script if you
# change native/FazeLoopback/Program.cs).
#
# Idempotent: re-running with an installed SDK skips the download.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK_ROOT="$ROOT/.sdk-bootstrap/sdk"
SDK_VERSION="8.0.424"

if [ ! -x "$SDK_ROOT/dotnet.exe" ]; then
  echo "[1/2] installing .NET $SDK_VERSION SDK to .sdk-bootstrap/ ..."
  mkdir -p "$ROOT/.sdk-bootstrap"
  curl -sSL https://dot.net/v1/dotnet-install.ps1 -o "$ROOT/.sdk-bootstrap/dotnet-install.ps1"
  powershell -ExecutionPolicy Bypass -File "$ROOT/.sdk-bootstrap/dotnet-install.ps1" \
    -Channel 8.0 \
    -InstallDir "$SDK_ROOT" \
    -NoPath -SkipNonVersionedFiles
fi

echo "[2/2] publishing faze-loopback helper (Release, win-x64, framework-dep) ..."
cd "$ROOT/native/FazeLoopback"
"$SDK_ROOT/dotnet.exe" publish -c Release -o "$ROOT/loopback-build"
ls -la "$ROOT/loopback-build/faze-loopback.exe"
echo "done."
