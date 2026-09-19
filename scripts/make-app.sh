#!/bin/bash
#
# Build "Echo Reader.app" -- the double-clickable launcher -- and its icon.
#
#   ./scripts/make-app.sh          (or: npm run make-app)
#
# The icon is rendered from build/icon.svg with headless Chrome, because macOS
# has no SVG rasteriser on the command line. If Chrome is not installed, an
# existing build/EchoReader.icns is reused and the bundle still works.

set -euo pipefail

PROJECT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
APP="$PROJECT/Echo Reader.app"
ICNS="$PROJECT/build/EchoReader.icns"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

cd "$PROJECT"

# --- Icon -------------------------------------------------------------------
if [ -x "$CHROME" ]; then
  echo "Rendering the icon..."
  "$CHROME" --headless=new --disable-gpu --default-background-color=00000000 \
    --hide-scrollbars --window-size=1024,1024 \
    --screenshot="$PROJECT/build/icon-1024.png" \
    "file://$PROJECT/build/icon.html" >/dev/null 2>&1

  ICONSET="$PROJECT/build/EchoReader.iconset"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
              "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
              "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
    size="${spec%% *}"
    name="${spec#* }"
    sips -z "$size" "$size" "$PROJECT/build/icon-1024.png" --out "$ICONSET/$name.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$ICNS"
elif [ ! -f "$ICNS" ]; then
  echo "warning: no Chrome to render the icon and no prebuilt icns; the app will use a generic icon." >&2
fi

# --- Bundle -----------------------------------------------------------------
# An AppleScript applet, so macOS will ask for (and remember) access to the
# project folder when it lives under Desktop, Documents or Downloads.
echo "Assembling $(basename "$APP")..."
rm -rf "$APP"
osacompile -o "$APP" "$PROJECT/build/launcher.applescript"

PLIST="$APP/Contents/Info.plist"
plutil -replace CFBundleName -string "Echo Reader" "$PLIST"
plutil -replace CFBundleDisplayName -string "Echo Reader" "$PLIST"
plutil -replace CFBundleIdentifier -string "local.echoreader.launcher" "$PLIST"
plutil -replace CFBundleShortVersionString -string "1.0.0" "$PLIST"
plutil -replace LSMinimumSystemVersion -string "11.0" "$PLIST"
# Applets look for applet.icns; drop ours in under that name.
[ -f "$ICNS" ] && cp "$ICNS" "$APP/Contents/Resources/applet.icns"

# Re-sign after touching the bundle so it is not flagged as tampered with.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 ||
  echo "note: could not ad-hoc sign the bundle; it will still run." >&2

# Nudge Finder so the new icon shows immediately.
touch "$APP"

echo "Done: $APP"
