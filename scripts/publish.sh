#!/usr/bin/env bash
# publish.sh — publish all 8 MIT @open-rgs/* packages to GitLab project
# 80565772's npm registry, in dependency order.
#
# Why ordered:
#   npm publish validates declared deps exist in the target registry.
#   contract has no deps, log has none, but core depends on contract+log,
#   so contract+log must be live before core publishes, and so on.
#
# Prereqs:
#   export GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxxx
#   (or run in GitLab CI where CI_JOB_TOKEN is set automatically; swap
#    the .npmrc line if so)
#   cp .npmrc.example .npmrc
#   bun install
#   bun run typecheck
#
# Usage:
#   ./scripts/publish.sh             # publish all
#   ./scripts/publish.sh --dry-run   # validate without uploading
#   ./scripts/publish.sh --only client core   # publish only specific packages
#
# Failure semantics:
#   Stops at the first failure. The packages published before the
#   failure are LIVE on the registry; the rest are not. Re-run after
#   fixing — already-published versions will be rejected (npm refuses
#   to overwrite), but the script continues to the next un-published one.

set -euo pipefail

# ───── Inputs ─────────────────────────────────────────────────────────
DRY_RUN=""
ONLY=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN="--dry-run"; shift ;;
    --only)    shift; while [[ $# -gt 0 && "$1" != --* ]]; do ONLY+=("$1"); shift; done ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${GITLAB_TOKEN:-}" && -z "${CI_JOB_TOKEN:-}" ]]; then
  echo "ERROR: GITLAB_TOKEN or CI_JOB_TOKEN must be set" >&2
  echo "  Generate a personal token at https://gitlab.com/-/profile/personal_access_tokens" >&2
  echo "  Scope:  api  (or  write_repository  for read-only registry)" >&2
  exit 1
fi

# ───── Dependency order — DO NOT REORDER ──────────────────────────────
# Each package depends only on the ones above it in the registry.
ORDER=(
  contract           # 0 deps
  log                # 0 deps
  core               # contract + log
  platform-mock      # contract
  simulator          # contract
  adapter-kit        # contract + log
  adapter-test-kit   # contract
  client             # contract
)

# ───── Filter to --only if provided ───────────────────────────────────
if [[ ${#ONLY[@]} -gt 0 ]]; then
  filtered=()
  for o in "${ONLY[@]}"; do
    found=0
    for p in "${ORDER[@]}"; do
      if [[ "$p" == "$o" ]]; then filtered+=("$p"); found=1; break; fi
    done
    if [[ $found -eq 0 ]]; then echo "unknown package: $o" >&2; exit 2; fi
  done
  ORDER=("${filtered[@]}")
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)

# ───── Pre-flight ─────────────────────────────────────────────────────
echo "🔍 Pre-flight: typecheck all packages"
cd "$ROOT"
bun run typecheck

if [[ ! -f "$ROOT/.npmrc" ]]; then
  echo "ERROR: $ROOT/.npmrc missing — copy from .npmrc.example" >&2
  exit 1
fi

# ───── Publish loop ───────────────────────────────────────────────────
echo ""
echo "📦 Publishing ${#ORDER[@]} packages to GitLab project 80565772"
[[ -n "$DRY_RUN" ]] && echo "   (DRY RUN — nothing actually uploaded)"
echo ""

for pkg in "${ORDER[@]}"; do
  PKG_DIR="$ROOT/packages/$pkg"
  PKG_NAME="@open-rgs/$pkg"
  PKG_VERSION=$(node -p "require('$PKG_DIR/package.json').version")

  echo "──── $PKG_NAME@$PKG_VERSION ────"

  cd "$PKG_DIR"

  # Run tests if a test script + tests exist
  if [[ -d test ]] && grep -q '"test"' package.json; then
    echo "  ▸ bun test"
    bun test 2>&1 | tail -1
  fi

  echo "  ▸ npm publish $DRY_RUN"
  npm publish $DRY_RUN
  echo "  ✓ done"
  echo ""
done

echo "═════════════════════════════════════════════════════════════════"
echo "✅ Published ${#ORDER[@]} package(s)"
[[ -n "$DRY_RUN" ]] && echo "   (DRY RUN — re-run without --dry-run to upload)"
echo ""
echo "Install in a consumer project with:"
echo "  echo '@open-rgs:registry=https://gitlab.com/api/v4/projects/80565772/packages/npm/' >> .npmrc"
echo "  echo '//gitlab.com/api/v4/projects/80565772/packages/npm/:_authToken=\${GITLAB_TOKEN}' >> .npmrc"
echo "  bun add @open-rgs/contract @open-rgs/core @open-rgs/client"
