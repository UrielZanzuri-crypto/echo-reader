#!/bin/bash
#
# Package Echo Reader for another Mac.
#
#   npm run package                  -> Echo Reader.zip (needs Node on the other Mac)
#   npm run package -- --with-node   -> also bundles Node, so nothing needs installing
#   npm run package -- --with-node --arch x64   (for an Intel Mac; default: this Mac's)
#
# The zip holds the launcher app, the built site, the tiny server, and a short
# read-me. No sources, no node_modules, no build step on the other side.
# --with-node downloads the official Node binary for the target architecture
# from nodejs.org (the one network step, done here, not there).

set -euo pipefail

PROJECT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
NAME="Echo Reader"
WITH_NODE=0
ARCH="$(uname -m)"
NODE_VERSION="v22.12.0"

for arg in "$@"; do
  case "$arg" in
    --with-node) WITH_NODE=1 ;;
    --arch) ;;
    arm64|x64|x86_64) ARCH="$arg" ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
[ "$ARCH" = "x86_64" ] && ARCH="x64"

cd "$PROJECT"
[ -f dist/index.html ] || npm run build
[ -d "$NAME.app" ] || npm run make-app

STAGE="$(mktemp -d)/$NAME"
mkdir -p "$STAGE/scripts"
trap 'rm -rf "$(dirname "$STAGE")"' EXIT

cp -R "$NAME.app" "$STAGE/"
cp -R dist "$STAGE/dist"
cp scripts/launcher.sh scripts/serve.mjs scripts/stop.mjs "$STAGE/scripts/"
cp package.json "$STAGE/"
cp LICENSE "$STAGE/" 2>/dev/null || true

if [ "$WITH_NODE" = 1 ]; then
  TARBALL="node-$NODE_VERSION-darwin-$ARCH.tar.gz"
  CACHE="$PROJECT/build/$TARBALL"
  if [ ! -f "$CACHE" ]; then
    echo "Downloading Node $NODE_VERSION for darwin-$ARCH..."
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL" -o "$CACHE"
  fi
  mkdir -p "$STAGE/vendor/node/bin"
  tar -xzf "$CACHE" -C "$STAGE/vendor/node/bin" --strip-components=2 "node-$NODE_VERSION-darwin-$ARCH/bin/node"
  chmod +x "$STAGE/vendor/node/bin/node"
fi

cat > "$STAGE/READ ME FIRST.txt" <<TXT
Echo Reader -- read along while your Mac reads aloud

1. Keep this whole folder together (Desktop or Documents is fine).
2. Double-click "Echo Reader.app".
   The first time, macOS will say it cannot verify the app:
     macOS 15 or newer: System Settings > Privacy & Security, scroll down,
                        click "Open Anyway", then double-click again.
     older macOS:       right-click the app > Open > Open.
   Then allow it to access the folder when asked.
3. Your browser opens with the reader. Paste text, or open a .txt / .pdf.

$( [ "$WITH_NODE" = 1 ] && echo "Everything needed is inside this folder; nothing to install." || echo "Needs Node.js: install it once from https://nodejs.org (the macOS installer)." )
Better voices: System Settings > Accessibility > Spoken Content > System Voice >
Manage Voices, download the Enhanced or Premium ones, restart the browser.
TXT

# Strip quarantine flags and this machine's server state before zipping.
xattr -cr "$STAGE" 2>/dev/null || true
rm -f "$STAGE/.echo-reader.json" "$STAGE/.echo-reader.log"

OUT="$PROJECT/$NAME.zip"
rm -f "$OUT"
(cd "$(dirname "$STAGE")" && ditto -c -k --keepParent "$NAME" "$OUT")
echo "Packaged: $OUT ($(du -h "$OUT" | cut -f1))"
[ "$WITH_NODE" = 1 ] && echo "Bundled Node $NODE_VERSION for darwin-$ARCH." || echo "Recipient needs Node.js installed."
