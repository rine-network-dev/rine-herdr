#!/usr/bin/env bash
# seed-tree.sh: install THIS tree's rine-core, rine-ts-sdk, rine-mcp, rine-herdr and the staged rine-mls addon
# into the rig's npm prefix, so `rine-herdr` and the rine MCP server the pane shim runs are the build under test.
# Runs INSIDE the rig only (compose.herdr.yml mounts the sources read-only under /work/src).
#
# The tarballs are packed the way a publish packs them: file: deps rewritten to the sibling's version
# (scripts/rewrite-file-deps.py) and `npm pack` applying each package's `files` allowlist. They come from the
# dist directories the host already built; nothing is built here. Only third-party dependencies come from the
# registry, as for any user install.
set -euo pipefail
SRC="${HERDR_TREE_SRC:-/work/src}"
SCRATCH="${HERDR_RIG_SCRATCH:-/work/scratch}"
STAGE="$SCRATCH/tree-src"
TARBALLS="$SCRATCH/tree-tarballs"
PLUGIN_DIR="$SCRATCH/plugin"
CORE=rine-core
SDK=rine-ts-sdk
MCP=rine-mcp
HERDR=rine-herdr
MLS=rine-mls/crates/rine-mls-node
ARCH="$(node -p process.arch)"
ADDON="$MLS/npm/linux-$ARCH-gnu"

for dir in "$CORE" "$SDK" "$MCP" "$HERDR" "$MLS"; do
    [ -f "$SRC/$dir/package.json" ] || { printf 'FAIL  %s/%s is not mounted, run through compose.herdr.yml\n' "$SRC" "$dir"; exit 1; }
done
for bundle in "$CORE/dist/index.js" "$SDK/dist/index.js" "$MCP/dist/server.js" "$HERDR/dist/cli.js"; do
    [ -f "$SRC/$bundle" ] || { printf 'FAIL  %s is not built, run npm run build in its package\n' "$bundle"; exit 1; }
done
BUILT="$SRC/$MLS/rine-mls.linux-$ARCH-gnu.node"
cmp -s "$BUILT" "$SRC/$ADDON/rine-mls.linux-$ARCH-gnu.node" \
    || { printf 'FAIL  the staged rine-mls addon in %s is missing or differs from %s, rebuild it with scripts/build-mls-artifacts.sh\n' "$ADDON" "${BUILT#"$SRC"/}"; exit 1; }

rm -rf "$STAGE" "$TARBALLS" "$PLUGIN_DIR"
mkdir -p "$STAGE" "$TARBALLS"
for dir in "$CORE" "$SDK" "$MCP" "$HERDR" "$MLS"; do
    mkdir -p "$STAGE/$dir"
    tar -C "$SRC/$dir" --exclude=node_modules --exclude=target -cf - . | tar -C "$STAGE/$dir" -xf -
done
for dir in "$CORE" "$SDK" "$MCP" "$HERDR" "$MLS"; do
    python3 "$SRC/rewrite-file-deps.py" "$STAGE/$dir/package.json" >/dev/null
done
for dir in "$CORE" "$SDK" "$MCP" "$HERDR" "$MLS" "$ADDON"; do
    (cd "$STAGE/$dir" && npm pack --silent --pack-destination "$TARBALLS" >/dev/null)
done

version() { node -p "require('$STAGE/$1/package.json').version"; }
npm install -g --no-audit --no-fund --loglevel=error \
    "$TARBALLS/rine-network-mls-$(version "$MLS").tgz" \
    "$TARBALLS/rine-network-mls-linux-$ARCH-gnu-$(version "$MLS").tgz" \
    "$TARBALLS/rine-network-core-$(version "$CORE").tgz" \
    "$TARBALLS/rine-network-sdk-$(version "$SDK").tgz" \
    "$TARBALLS/rine-network-mcp-$(version "$MCP").tgz" \
    "$TARBALLS/rine-network-herdr-$(version "$HERDR").tgz"

GLOBAL="$(npm root -g)/@rine-network"
cmp "$SRC/$HERDR/dist/cli.js" "$GLOBAL/herdr/dist/cli.js" \
    && cmp "$SRC/$MCP/dist/server.js" "$GLOBAL/mcp/dist/server.js" \
    && cmp "$SRC/$CORE/dist/index.js" "$GLOBAL/core/dist/index.js" \
    || { printf 'FAIL  the installed bundles differ from the mounted tree\n'; exit 1; }
[ "$(command -v rine-herdr)" = "$SCRATCH/npm-global/bin/rine-herdr" ] \
    || { printf 'FAIL  rine-herdr resolves to %s, not the seeded install\n' "$(command -v rine-herdr || echo nothing)"; exit 1; }

# The plugin dir the way `rine-herdr link` leaves it, with the seeded install standing in for the registry's.
mkdir -p "$PLUGIN_DIR/node_modules/@rine-network"
cp "$GLOBAL/herdr/plugin/herdr-plugin.toml" "$GLOBAL/herdr/plugin/package.json" "$PLUGIN_DIR/"
ln -s "$GLOBAL/herdr" "$PLUGIN_DIR/node_modules/@rine-network/herdr"
printf 'PASS  rine-herdr, rine-mcp, rine-core, rine-sdk and the rine-mls addon (%s) resolve to this tree\n' "$ARCH"
