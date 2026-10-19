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

# The latest release's tag, from the redirect GitHub answers with. GitHub
# answers the odd 502 or times out now and then, so every request retries.
LATEST="$({ curl -fsSIL --retry 5 --retry-delay 2 -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" || true; } | sed 's|.*/tag/||')"
[ -n "$LATEST" ] || { echo "Could not reach GitHub. Is the internet connected? If it is, GitHub may be having a moment: wait a minute and run this line again." >&2; exit 1; }

if [ -f "$DEST/.version" ] && [ "$(cat "$DEST/.version")" = "$LATEST" ] && [ -d "$DEST/Echo Reader.app" ]; then
  echo "Echo Reader $LATEST is already installed in $DEST. Opening it."
else
  # The zip is kept in the cache folder rather than a temp one so that an
  # interrupted download resumes where it stopped, even on a later run.
  CACHE="$HOME/Library/Caches/EchoReader"
  ZIP="$CACHE/$LATEST-$ASSET"
  mkdir -p "$CACHE"
  echo "Downloading Echo Reader $LATEST for this Mac (about 400 MB)..."
  ok=0
  for attempt in 1 2 3 4 5 6; do
    if curl -fL --progress-bar -C - --retry 3 --retry-delay 3 "https://github.com/$REPO/releases/download/$LATEST/$ASSET" -o "$ZIP"; then
      ok=1; break
    fi
    [ "$attempt" = 6 ] || { echo "The download was interrupted (attempt $attempt of 6). Retrying in 5 seconds..."; sleep 5; }
  done
  [ "$ok" = 1 ] || { echo "The download kept failing. Check the internet connection, wait a minute, and run this line again: it will carry on from where it stopped." >&2; exit 1; }

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "Installing into $DEST..."
  if ! ditto -x -k "$ZIP" "$TMP/unpacked" 2>/dev/null || [ ! -d "$TMP/unpacked/Echo Reader/Echo Reader.app" ]; then
    rm -f "$ZIP"
    echo "The downloaded file was damaged, so it was discarded. Run this line again to download it afresh." >&2
    exit 1
  fi

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
  rm -f "$ZIP"
  echo "Installed."
fi

# A server left behind by a copy whose folder was since deleted keeps its port
# and answers every page with "Not found"; the browser can land on it. It still
# identifies itself as Echo Reader but no longer serves its index, so stop it.
for p in $(seq 4173 4193); do
  if curl -fsS --max-time 1 "http://127.0.0.1:$p/__echo-reader" 2>/dev/null | grep -q echo-reader &&
     ! curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null; then
    for pid in $(lsof -ti "tcp:$p" -sTCP:LISTEN 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
  fi
done

open "$DEST/Echo Reader.app"
url=""
for _ in $(seq 1 40); do
  # (|| true: under set -e, a failing command substitution ends the script.)
  url="$({ sed -n 's/.*"url": *"\([^"]*\)".*/\1/p' "$DEST/.echo-reader.json" 2>/dev/null || true; } | head -n 1)"
  [ -n "$url" ] && curl -fsS --max-time 1 -o /dev/null "$url" 2>/dev/null && break
  url=""; sleep 0.5
done
cat <<TXT

Echo Reader is opening in your browser${url:+ at $url}.
If a tab shows "Not found" or "can't connect", close it: it belongs to an older copy.
To open it again later: Finder > Go > Home > Applications > Echo Reader > double-click "Echo Reader",
or simply run this same command again.
TXT
