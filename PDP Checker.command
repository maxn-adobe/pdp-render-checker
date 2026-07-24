#!/bin/bash
# Double-click launcher (macOS). Starts the local PDP checker web app and opens
# it in your browser — no terminal input required. Closing this window quits.
#
# The distributable bundle ships a portable Node in ./runtime and a vendored
# ./node_modules, so this "just works" with no install. Rendering uses your
# installed Google Chrome. The server listens on 127.0.0.1 only (local machine).

cd "$(cd "$(dirname "$0")" && pwd)" || exit 1

# Prefer a bundled Node; fall back to a system Node if one is installed.
if [ -x "./runtime/bin/node" ]; then
  NODE="./runtime/bin/node"
else
  NODE="$(command -v node || true)"
fi

if [ -z "$NODE" ]; then
  osascript -e 'display dialog "Node.js was not found. Please use the bundled runtime or install Node 20+ from nodejs.org, then try again." buttons {"OK"} default button "OK" with icon caution' >/dev/null 2>&1
  echo "Node.js not found. See the dialog for details."
  read -r -p "Press return to close." _
  exit 1
fi

# First-run fallback: if dependencies weren't vendored, install them (needs npm).
if [ ! -d "./node_modules" ] && command -v npm >/dev/null 2>&1; then
  echo "Installing dependencies (first run only)…"
  npm install --omit=dev
fi

echo "Starting the PDP checker… (close this window to quit)"

# Run the server; when it prints its URL, open the browser. The pipe keeps this
# window attached to the server process so closing the window stops the server.
"$NODE" server.mjs 2>&1 | while IFS= read -r line; do
  echo "$line"
  case "$line" in
    PDP_CHECKER_URL=*) open "${line#PDP_CHECKER_URL=}" ;;
  esac
done
