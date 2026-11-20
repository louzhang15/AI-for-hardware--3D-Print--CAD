#!/usr/bin/env bash
# Route Claude Code AND Codex (and with them the ponytail, agent-skills and
# graphify plugins) through OmniRoute, on THIS machine only.
#
#   1. Installs OmniRoute from https://github.com/ChrisCompton/omniroute
#      (pinned commit) into ~/.local/share/omniroute-src and builds it.
#   2. Writes .claude/settings.local.json (git-ignored) so Claude Code in this
#      repo sends its requests to OmniRoute at http://localhost:20128.
#   3. Adds an "omniroute" provider to ~/.codex/config.toml and installs the
#      ponytail and agent-skills plugins into Codex (graphify's Codex skill is
#      already committed under .codex/).
#
# Usage:   OMNIROUTE_API_KEY=sk-... scripts/omniroute-setup.sh
# Start:   scripts/omniroute-setup.sh --start      (runs the server)
# Undo:    scripts/omniroute-setup.sh --off        (back to normal Claude Code)
set -euo pipefail

REPO_URL="https://github.com/ChrisCompton/omniroute.git"
PIN="515674b"   # v3.6.1, reviewed 2026-11-20. Change on purpose, not by accident.
SRC="${OMNIROUTE_SRC:-$HOME/.local/share/omniroute-src}"
PORT="${OMNIROUTE_PORT:-20128}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL="$ROOT/.claude/settings.local.json"

write_settings() {  # $1 = on|off
  MODE="$1" PORT="$PORT" KEY="${OMNIROUTE_API_KEY:-}" LOCAL="$LOCAL" node -e '
    const fs = require("fs"), p = process.env.LOCAL;
    let s = {}; try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    s.env = s.env || {};
    const keys = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "GRAPHIFY_BACKEND"];
    if (process.env.MODE === "off") {
      for (const k of keys) delete s.env[k];
    } else {
      s.env.ANTHROPIC_BASE_URL = `http://localhost:${process.env.PORT}`;
      s.env.ANTHROPIC_API_KEY = process.env.KEY;
      s.env.GRAPHIFY_BACKEND = "claude";  // graphify headless extract -> same endpoint
    }
    if (!Object.keys(s.env).length) delete s.env;
    fs.mkdirSync(require("path").dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
  '
  chmod 600 "$LOCAL"
}

CODEX_CFG="${CODEX_HOME:-$HOME/.codex}/config.toml"
BEGIN="# >>> omniroute (scripts/omniroute-setup.sh) >>>"
END="# <<< omniroute <<<"
codex_config() {  # $1 = on|off ; replaces only our marked block
  mkdir -p "$(dirname "$CODEX_CFG")"; touch "$CODEX_CFG"
  awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$CODEX_CFG" > "$CODEX_CFG.tmp"
  if [ "$1" = on ]; then
    if grep -q '^model_provider' "$CODEX_CFG.tmp"; then
      echo "~/.codex/config.toml already sets model_provider; set it to \"omniroute\" yourself." >&2
      body=""
    else
      body='model_provider = "omniroute"'
    fi
    # model_provider is a top-level key, so it goes first; the table goes last
    # so it can't capture the user's own top-level keys.
    { if [ -n "$body" ]; then echo "$BEGIN"; echo "$body"; echo "$END"; fi
      cat "$CODEX_CFG.tmp"
      echo "$BEGIN"
      echo "[model_providers.omniroute]"
      echo 'name = "OmniRoute"'
      echo "base_url = \"http://localhost:$PORT/v1\""
      echo 'env_key = "OMNIROUTE_API_KEY"'
      echo 'wire_api = "responses"'
      echo "$END"; } > "$CODEX_CFG"
    rm -f "$CODEX_CFG.tmp"
  else
    mv "$CODEX_CFG.tmp" "$CODEX_CFG"
  fi
}

case "${1:-install}" in
  --off)
    write_settings off
    codex_config off
    echo "OmniRoute routing removed from $LOCAL and ~/.codex/config.toml. Restart Claude Code and Codex."
    exit 0 ;;
  --start)
    cd "$SRC" && exec env PORT="$PORT" node bin/omniroute.mjs --port "$PORT" ;;
  install) ;;
  *) echo "usage: $0 [--start|--off]" >&2; exit 2 ;;
esac

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 18 ] || [ "$node_major" -ge 24 ]; then
  echo "OmniRoute $PIN needs Node 18-23 (you have $(node -v))." >&2; exit 1
fi
if [ -z "${OMNIROUTE_API_KEY:-}" ]; then
  echo "Set OMNIROUTE_API_KEY to the key from the OmniRoute dashboard first:" >&2
  echo "  scripts/omniroute-setup.sh --start   # then open http://localhost:$PORT, create a key" >&2
  echo "  OMNIROUTE_API_KEY=sk-... scripts/omniroute-setup.sh" >&2
fi

if [ ! -d "$SRC/.git" ]; then
  git clone "$REPO_URL" "$SRC"
fi
git -C "$SRC" fetch --quiet origin
git -C "$SRC" checkout --quiet "$PIN"
( cd "$SRC" && npm ci && npm run build )

if [ -n "${OMNIROUTE_API_KEY:-}" ]; then
  write_settings on
  codex_config on
  echo "Claude Code in this repo now uses OmniRoute at http://localhost:$PORT"
  echo "Codex uses it too; export OMNIROUTE_API_KEY in your shell profile for Codex."
  echo "Start it with: scripts/omniroute-setup.sh --start   (it must be running)"
else
  echo "OmniRoute built. Start it, create a key, then re-run with OMNIROUTE_API_KEY set."
fi

if command -v codex >/dev/null; then
  codex plugin marketplace add DietrichGebert/ponytail || true
  codex plugin add ponytail@ponytail || true
  codex plugin marketplace add addyosmani/agent-skills || true
  codex plugin add agent-skills@agent-skills || true
  echo "Codex plugins added. Open /hooks in Codex once to trust ponytail's hooks."
else
  echo "Codex not found; install it, then re-run this script to add the plugins."
fi
