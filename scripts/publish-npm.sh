#!/usr/bin/env bash
# Publish public workspace packages the CLI needs. bun publish is reserved.
# Expected (from repo root, after bun install):
#   bash scripts/publish-npm.sh              # bun pack + npm publish --provenance
#   bash scripts/publish-npm.sh --dry-run    # pack only; print rewritten deps
# Order: core, ads, then dependents, then @ravenclaw/cli.
# bun pm pack rewrites workspace:* to the package.json version.
# npm pack / npm publish --workspace does not (no npm lockfile).
# Root and @ravenclaw/sdk stay private and are not published.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
if [ "${1:-}" = '--dry-run' ]; then
  DRY=1
fi

if [ "$DRY" -eq 0 ] && [ -z "${NODE_AUTH_TOKEN:-}${NPM_TOKEN:-}" ]; then
  echo "NODE_AUTH_TOKEN or NPM_TOKEN is required to publish" >&2
  exit 1
fi

PACKAGES=(
  packages/core
  packages/ads
  packages/providers
  packages/acp
  packages/tui-opentui
  packages/cli
)

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

for dir in "${PACKAGES[@]}"; do
  name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$dir/package.json")
  echo "Packing ${name} from ${dir}"
  (
    cd "$dir"
    bun pm pack --destination "$OUT"
  )
  tgz=$(python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); print("%s-%s.tgz" % (p["name"].lstrip("@").replace("/","-"), p["version"]))' "$dir/package.json")
  packed="$OUT/$tgz"
  if [ ! -f "$packed" ]; then
    echo "missing tarball $packed" >&2
    ls -la "$OUT" >&2
    exit 1
  fi
  python3 -c 'import json,tarfile,sys
with tarfile.open(sys.argv[1]) as t:
    pkg=json.load(t.extractfile("package/package.json"))
print("  rewritten deps:", {k:v for k,v in pkg.get("dependencies",{}).items() if k.startswith("@ravenclaw/")})
if any(str(v).startswith("workspace:") for v in pkg.get("dependencies",{}).values()):
    raise SystemExit("workspace:* leaked into tarball")' "$packed"
  if [ "$DRY" -eq 1 ]; then
    echo "  dry-run: skip npm publish $tgz"
    continue
  fi
  echo "Publishing ${name} from $tgz"
  npm publish "$packed" --access public --provenance
done
