#!/usr/bin/env bash
# Targeted unit suites only. Never `bun test` with no args (full-repo Docker hang).
set -euo pipefail
cd "$(dirname "$0")/.."
bun test packages/core
bun test packages/cli
bun test packages/providers
bun test packages/ads
bun test packages/sdk
bun test packages/acp
bun test packages/tui-opentui
