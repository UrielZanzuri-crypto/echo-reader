#!/bin/bash
# Render docs/guide.html (the Hebrew install guide for friends) to
# docs/Echo-Reader-Guide.pdf with headless Chrome, which shapes right-to-left
# text properly where the usual PDF libraries do not.
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Google Chrome is needed to render the guide." >&2; exit 1; }
"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$PWD/docs/Echo-Reader-Guide.pdf" "file://$PWD/docs/guide.html" 2>/dev/null
echo "Wrote docs/Echo-Reader-Guide.pdf"
