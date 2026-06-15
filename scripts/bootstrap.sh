#!/usr/bin/env bash
# bootstrap.sh — set up the four engine repos as siblings of ardur-pipeline.
#
# Usage:
#   ./scripts/bootstrap.sh                    # clone or pull + install all engines
#   ./scripts/bootstrap.sh --ref <sha/tag>    # check out a specific ref in every engine
#
# Idempotent: safe to re-run. Respects ENGINE_* dir-name overrides from .env.
# After this script succeeds, `npm run cycle` (or `node src/cli.ts`) will work.
#
# Requires: git, node >= 22, npm.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---  load .env overrides if present ----------------------------------------
if [[ -f "$REPO_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_DIR/.env"
  set +a
fi

# --- configuration -----------------------------------------------------------
ENGINES_DIR="${ENGINES_DIR:-$(cd "$REPO_DIR/.." && pwd)}"
ENGINE_AGGREGATOR="${ENGINE_AGGREGATOR:-ardur-news-aggregator}"
ENGINE_RANKING="${ENGINE_RANKING:-ardur-ranking-engine}"
ENGINE_TOP10="${ENGINE_TOP10:-ardur-top10-engine}"
ENGINE_SYNTHESIZER="${ENGINE_SYNTHESIZER:-ardur-article-synthesizer}"

declare -A ENGINE_REPOS=(
  ["$ENGINE_AGGREGATOR"]="https://github.com/ArdurAI/ardur-news-aggregator.git"
  ["$ENGINE_RANKING"]="https://github.com/ArdurAI/ardur-ranking-engine.git"
  ["$ENGINE_TOP10"]="https://github.com/ArdurAI/ardur-top10-engine.git"
  ["$ENGINE_SYNTHESIZER"]="https://github.com/ArdurAI/ardur-article-synthesizer.git"
)

# --- parse arguments ---------------------------------------------------------
REF=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      REF="${2:-}"
      shift 2
      ;;
    --ref=*)
      REF="${1#--ref=}"
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "usage: $0 [--ref <sha|tag|branch>]" >&2
      exit 1
      ;;
  esac
done

# --- helpers -----------------------------------------------------------------
info()  { echo "[bootstrap] $*"; }
step()  { echo "[bootstrap] >>> $*"; }
ok()    { echo "[bootstrap] ok: $*"; }

# --- main --------------------------------------------------------------------
step "engines dir: $ENGINES_DIR"
mkdir -p "$ENGINES_DIR"

for dir in "${!ENGINE_REPOS[@]}"; do
  url="${ENGINE_REPOS[$dir]}"
  target="$ENGINES_DIR/$dir"

  if [[ -d "$target/.git" ]]; then
    info "$dir: already cloned — pulling"
    git -C "$target" fetch --quiet origin
    if [[ -n "$REF" ]]; then
      git -C "$target" checkout --quiet "$REF"
    else
      # Follow the default branch (whatever origin points to).
      DEFAULT=$(git -C "$target" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo "main")
      git -C "$target" checkout --quiet "$DEFAULT"
      git -C "$target" pull --quiet --rebase origin "$DEFAULT"
    fi
  else
    info "$dir: cloning from $url"
    # Clone without --branch so commit SHAs work; then checkout the ref if given (#39).
    # git clone --branch rejects commit SHAs on a fresh clone (only tags/branches allowed).
    git clone --quiet "$url" "$target"
    if [[ -n "$REF" ]]; then
      git -C "$target" checkout --quiet "$REF"
    fi
  fi

  step "installing $dir"
  (cd "$target" && (npm ci --quiet 2>/dev/null || npm install --quiet))
  ok "$dir"
done

# --- verify orchestrator itself is installed ---------------------------------
if [[ ! -d "$REPO_DIR/node_modules" ]]; then
  step "installing ardur-pipeline"
  (cd "$REPO_DIR" && npm install --quiet)
fi

cat <<'EOF'

bootstrap complete.

  Run a deterministic test cycle (no API keys needed):
    cd ardur-pipeline
    npm run cycle

  Dry-run (no pointer flip):
    node --experimental-strip-types src/cli.ts --dry-run

  Backfill a past window:
    node --experimental-strip-types src/cli.ts --at 2026-06-11T06:00:00Z

EOF
