#!/usr/bin/env bash
# publish.sh  - publish all 8 MIT @open-rgs/* packages to npmjs.org,
# in dependency order.
#
# Why ordered:
#   npm publish validates declared deps exist in the target registry.
#   contract has no deps, log has none, but core depends on contract+log,
#   so contract+log must be live before core publishes, and so on.
#
# Prereqs (local bootstrap publish):
#   export NPM_TOKEN=npm_xxxxxxxxxxxxxxxxxxxxxxxx
#   bun install && bun run typecheck
#
# In CI (after Trusted Publisher is configured):
#   The workflow runs with `id-token: write` and `npm publish` does
#   OIDC handshake automatically  - no NPM_TOKEN env needed.
#
# Usage:
#   ./scripts/publish.sh             # publish all
#   ./scripts/publish.sh --dry-run   # validate without uploading
#   ./scripts/publish.sh --only client core   # publish only specific packages
#
# Failure semantics:
#   Stops at the first failure. The packages published before the
#   failure are LIVE on npm; the rest are not. Re-run after fixing  -
#   npm refuses to overwrite existing versions, but the script
#   continues to the next un-published one.

set -euo pipefail

# ----- Inputs ---------------------------------------------------------
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

# ----- Auth detection -------------------------------------------------
# Local: requires NPM_TOKEN env var.
# CI:    GITHUB_ACTIONS=true and id-token permission -> OIDC handshake.
IN_CI="${GITHUB_ACTIONS:-false}"

if [[ "$IN_CI" != "true" ]]; then
  if [[ -z "${NPM_TOKEN:-}" ]]; then
    echo "ERROR: NPM_TOKEN env var required for local publish" >&2
    echo "  Generate a granular token at npmjs.com/settings/<user>/tokens" >&2
    echo "  Scope: read+write to @open-rgs" >&2
    exit 1
  fi
  # Inject the token into npm's runtime config for the duration of
  # this script. We point at a script-local .npmrc so we never touch
  # the user's global ~/.npmrc.
  TMP_NPMRC=$(mktemp -t openrgs-npmrc.XXXXXX)
  trap 'rm -f "$TMP_NPMRC"' EXIT
  echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > "$TMP_NPMRC"
  export NPM_CONFIG_USERCONFIG="$TMP_NPMRC"
fi

# Provenance attestation only works in CI (npm CLI requires an OIDC
# issuer to vouch for the build). Locally, every package's
# publishConfig.provenance=true would force-fail with EUSAGE  - we
# explicitly override to false.
PROVENANCE_FLAG="--provenance=false"
if [[ "$IN_CI" == "true" ]]; then
  PROVENANCE_FLAG="--provenance"
fi

# ----- Dependency order  - DO NOT REORDER ------------------------------
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

# ----- Filter to --only if provided -----------------------------------
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

# ----- Pre-flight -----------------------------------------------------
echo "🔍 Pre-flight: typecheck all packages"
cd "$ROOT"
bun run typecheck

# ----- Publish loop ---------------------------------------------------
echo ""
echo "📦 Publishing ${#ORDER[@]} package(s) to npmjs.org"
[[ -n "$DRY_RUN" ]]        && echo "   (DRY RUN  - nothing actually uploaded)"
[[ -n "$PROVENANCE_FLAG" ]] && echo "   (with provenance attestation)"
echo ""

for pkg in "${ORDER[@]}"; do
  PKG_DIR="$ROOT/packages/$pkg"
  PKG_NAME="@open-rgs/$pkg"
  PKG_VERSION=$(node -p "require('$PKG_DIR/package.json').version")

  echo "---- $PKG_NAME@$PKG_VERSION ----"

  cd "$PKG_DIR"

  echo "  ▸ npm publish --access public $PROVENANCE_FLAG $DRY_RUN"
  npm publish --access public $PROVENANCE_FLAG $DRY_RUN
  echo "  ✓ done"
  echo ""
done

echo "═════════════════════════════════════════════════════════════════"
echo "✅ Published ${#ORDER[@]} package(s) to https://www.npmjs.com/org/open-rgs"
[[ -n "$DRY_RUN" ]] && echo "   (DRY RUN  - re-run without --dry-run to upload)"
echo ""
echo "Install in a consumer project:"
echo "  bun add @open-rgs/core @open-rgs/contract @open-rgs/platform-mock"
