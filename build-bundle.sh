#!/bin/bash
# Build a self-contained, double-clickable macOS bundle of the PDP checker.
#
# Output:
#   dist/PDP-Checker/                      the runnable folder (double-click the .command)
#   dist/PDP-Checker-macos-<arch>.zip      the shareable artifact
#
# Re-runnable. Requires network (downloads an official Node runtime from nodejs.org).
# Authors who receive the zip need Google Chrome installed; nothing else.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

NODE_VERSION="${NODE_VERSION:-v20.18.1}"   # Node >=20 required (see package.json "engines")

# Target arch: defaults to this Mac's. Override with NODE_ARCH=x64 (or arm64) to
# cross-build — e.g. an Intel (x64) bundle from an Apple Silicon Mac. An x64
# bundle also runs on Apple Silicon via Rosetta, so it is the safe single choice
# for a mixed fleet.
if [ -z "${NODE_ARCH:-}" ]; then
  case "$(uname -m)" in
    arm64)  NODE_ARCH="arm64" ;;           # Apple Silicon
    x86_64) NODE_ARCH="x64" ;;             # Intel
    *) echo "Unsupported architecture: $(uname -m). Set NODE_ARCH=arm64 or x64."; exit 1 ;;
  esac
fi
case "$NODE_ARCH" in
  arm64|x64) ;;
  *) echo "NODE_ARCH must be 'arm64' or 'x64' (got: $NODE_ARCH)"; exit 1 ;;
esac

STAGE="dist/PDP-Checker"
echo "==> Cleaning dist/"
rm -rf dist
mkdir -p "$STAGE/runtime"

echo "==> Installing production dependencies (skipping Playwright browser download)"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev

echo "==> Downloading Node ${NODE_VERSION} (darwin-${NODE_ARCH}) from nodejs.org"
PKG="node-${NODE_VERSION}-darwin-${NODE_ARCH}"
curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${PKG}.tar.gz" -o "dist/${PKG}.tar.gz"
tar -xzf "dist/${PKG}.tar.gz" -C dist
cp -R "dist/${PKG}/." "$STAGE/runtime/"          # -> runtime/bin/node, runtime/lib, ...
rm -rf "dist/${PKG}" "dist/${PKG}.tar.gz"

echo "==> Staging application files"
cp server.mjs engine.mjs checks.mjs report.mjs config.mjs check.mjs package.json "$STAGE/"
cp -R public "$STAGE/"
cp -R node_modules "$STAGE/"
cp "PDP Checker.command" "$STAGE/"
chmod +x "$STAGE/PDP Checker.command"

echo "==> Zipping"
( cd dist && zip -qry "PDP-Checker-macos-${NODE_ARCH}.zip" "PDP-Checker" )

echo ""
echo "Done:"
echo "  Folder: $ROOT/$STAGE  (double-click 'PDP Checker.command' inside it)"
echo "  Zip:    $ROOT/dist/PDP-Checker-macos-${NODE_ARCH}.zip"
du -sh "$STAGE" "dist/PDP-Checker-macos-${NODE_ARCH}.zip" 2>/dev/null || true
