#!/bin/bash
#
# Echo Reader launcher -- what "Echo Reader.app" runs when double-clicked.
#
# It finds Node, makes sure the app is built, starts the local server if it is
# not already up, and opens a browser.
# The built app cannot run from a file:// URL, which is why a server is needed.
#
# It is deliberately idempotent: launching again while the server is running just
# opens another tab.

set -uo pipefail

# The applet passes the project folder in; running the script by hand works too.
PROJECT="${1:-$(cd -- "$(dirname -- "$0")/.." && pwd)}"
LOG="$PROJECT/.echo-reader.log"
STATE="$PROJECT/.echo-reader.json"

note() { /usr/bin/osascript -e "display notification \"$1\" with title \"Echo Reader\"" >/dev/null 2>&1 || true; }

fail() {
  /usr/bin/osascript -e "display alert \"Echo Reader could not start\" message \"$1\" as critical" >/dev/null 2>&1
  exit 1
}

read_state() { # read_state <key>
  [ -f "$STATE" ] || return 1
  /usr/bin/sed -n "s/.*\"$1\": *\([0-9]*\).*/\1/p" "$STATE" | head -n 1
}

# --- Find Node -------------------------------------------------------------
# An app launched from Finder gets a bare PATH, so the usual install locations
# have to be searched by hand before falling back to the login shell.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  for dir in "$HOME/.volta/bin" "$HOME/.local/bin" "$HOME/.bun/bin" \
             "$HOME/.nvm/versions/node"/*/bin \
             "$HOME/Library/Application Support/fnm/node-versions"/*/installation/bin; do
    if [ -x "$dir/node" ]; then
      export PATH="$dir:$PATH"
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  found="$("${SHELL:-/bin/zsh}" -lic 'command -v node' 2>/dev/null | tr -d '\r' | tail -n 1)"
  [ -x "$found" ] && export PATH="$(dirname "$found"):$PATH"
fi

command -v node >/dev/null 2>&1 ||
  fail "Node.js was not found. Install it from nodejs.org, then try again."

cd "$PROJECT" || fail "The project folder could not be opened."

{ echo; echo "=== launch $(date) ==="; } >>"$LOG" 2>&1

# --- Make sure it is installed and built -----------------------------------
if [ ! -d node_modules ]; then
  note "Installing dependencies. This happens only once."
  npm install --no-audit --no-fund >>"$LOG" 2>&1 ||
    fail "Installing dependencies failed. See .echo-reader.log in the project folder."
fi

needs_build=0
if [ ! -f dist/index.html ]; then
  needs_build=1
elif [ -n "$(find src index.html vite.config.js package.json -newer dist/index.html -print -quit 2>/dev/null)" ]; then
  needs_build=1 # sources changed since the last build
fi

if [ "$needs_build" = 1 ]; then
  note "Preparing Echo Reader..."
  npm run build >>"$LOG" 2>&1 ||
    fail "The build failed. See .echo-reader.log in the project folder."
fi

# --- Reuse a running server, or start one ----------------------------------
url=""
port="$(read_state port || true)"
pid="$(read_state pid || true)"
if [ -n "${port:-}" ] && [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null &&
   /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:$port/__echo-reader" >/dev/null 2>&1; then
  url="http://localhost:$port/"
fi

if [ -z "$url" ]; then
  rm -f "$STATE"
  nohup node scripts/serve.mjs --quiet >>"$LOG" 2>&1 &
  disown 2>/dev/null || true

  for _ in $(seq 1 80); do          # up to 20 seconds
    port="$(read_state port || true)"
    [ -n "${port:-}" ] && break
    sleep 0.25
  done
  [ -n "${port:-}" ] ||
    fail "The local server did not start. See .echo-reader.log in the project folder."
  url="http://localhost:$port/"
fi

open "$url" || fail "A browser could not be opened at $url"
