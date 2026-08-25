#!/usr/bin/env bash
# ompa launcher — self-extracting oh-my-prime-agent bundle.
#
# The release workflow (`.github/workflows/release.yml`) appends a tar.gz of
# the repo bundle (bin/ompa, plugins/, ompr.toml, README, LICENSE) after the
# last line of this script and rewrites @SKIP@ with the payload's first line
# number (makeself style). First run extracts into
# ~/.prime/oh-my-prime-agent, then hands off to the real CLI.
#
# Linux/macOS native; the windows asset runs under WSL or Git Bash.
set -euo pipefail
ROOT="${OMPA_ROOT:-$HOME/.prime/oh-my-prime-agent}"
if [[ ! -x "$ROOT/bin/ompa" ]]; then
  printf '[ompa] first run: extracting bundle to %s\n' "$ROOT" >&2
  mkdir -p "$ROOT"
  tail -n +@SKIP@ "$0" | tar -xzf - -C "$ROOT"
  chmod +x "$ROOT/bin/ompa"
fi
exec "$ROOT/bin/ompa" "$@"
