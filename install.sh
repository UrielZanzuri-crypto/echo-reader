#!/bin/bash
#
# Echo Reader installer for Macs. One line in Terminal does everything:
#
#   curl -fsSL https://raw.githubusercontent.com/UrielZanzuri-crypto/echo-reader/main/install.sh | bash
#
# It picks the zip for this Mac's chip, downloads it from the latest GitHub
# release, unpacks it into ~/Applications/Echo Reader and launches it. Run the
# same line again later to update, or just to open the reader.
#
# Why a Terminal line rather than "download the zip in the browser": a browser
# download is marked as quarantined, and macOS then refuses to open an app that
# is not notarized with Apple -- the double-click silently does nothing, or shows
# a "could not verify" dialog, until the person finds "Open Anyway" deep in
# System Settings. A download made by curl carries no quarantine mark, and
# ~/Applications is not one of the folders macOS guards with a permission prompt,
# so the app simply opens.

set -euo pipefail

REPO="UrielZanzuri-crypto/echo-reader"
DEST="$HOME/Applications/Echo Reader"

case "$(uname -m)" in
  arm64) ASSET="Echo-Reader-Apple-Silicon.zip" ;;
  x86_64) ASSET="Echo-Reader-Intel.zip" ;;
  *) echo "Echo Reader runs on Macs only (this is $(uname -sm))." >&2; exit 1 ;;
esac

# The latest release's tag, from the redirect GitHub answers with.
LATEST="$(curl -fsSIL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" | sed 's|.*/tag/||')"
[ -n "$LATEST" ] || { echo "Could not reach GitHub. Is the internet connected?" >&2; exit 1; }

if [ -f "$DEST/.version" ] && [ "$(cat "$DEST/.version")" = "$LATEST" ] && [ -d "$DEST/Echo Reader.app" ]; then
  echo "Echo Reader $LATEST is already installed in $DEST. Opening it."
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "Downloading Echo Reader $LATEST for this Mac (about 400 MB)..."
  curl -fL --progress-bar "https://github.com/$REPO/releases/download/$LATEST/$ASSET" -o "$TMP/$ASSET"

  echo "Installing into $DEST..."
  ditto -x -k "$TMP/$ASSET" "$TMP/unpacked"
  [ -d "$TMP/unpacked/Echo Reader/Echo Reader.app" ] || { echo "The download did not unpack as expected." >&2; exit 1; }

  # Stop a server left running by a previous copy, then replace it. Settings
  # and reading positions live in the browser, not in this folder.
  if [ -f "$DEST/.echo-reader.json" ]; then
    pid="$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$DEST/.echo-reader.json" | head -n 1)"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  fi
  mkdir -p "$HOME/Applications"
  rm -rf "$DEST"
  mv "$TMP/unpacked/Echo Reader" "$DEST"
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
  echo "$LATEST" > "$DEST/.version"
  echo "Installed."
fi

open "$DEST/Echo Reader.app"
cat <<TXT

Echo Reader is opening in your browser.
To open it again later: Finder > Go > Home > Applications > Echo Reader > double-click "Echo Reader",
or simply run this same command again.
TXT
