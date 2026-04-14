#!/usr/bin/env bash
# install.sh — build and install the profile-injector hook
#
# Run this once on any machine after cloning claw-machine.
# Also run after pulling changes that touch handler.ts.
#
# Usage:
#   bash install.sh
#
set -euo pipefail

HOOK_NAME="profile-injector"
HOOK_DIR="${HOME}/.openclaw/hooks/${HOOK_NAME}"

echo "🦞 claw-machine: building handler..."
npx esbuild handler.ts --bundle --platform=node --format=esm --outfile=handler.js --external:node:fs --external:node:path

echo "📦 Installing to ${HOOK_DIR}..."
mkdir -p "${HOOK_DIR}"
cp handler.js HOOK.md "${HOOK_DIR}/"

echo ""
echo "✅ Done. Hook files:"
ls -la "${HOOK_DIR}"
echo ""
echo "Next: make sure hooks.internal.enabled=true in openclaw.json"
echo "      and restart the gateway: openclaw gateway restart"
