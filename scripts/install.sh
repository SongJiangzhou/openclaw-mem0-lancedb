#!/bin/bash
set -e

echo "[install] Building memory-mem0-lancedb plugin..."

cd "$(dirname "$0")/.."

# Install dependencies
npm install

# Build TypeScript
npm run build

# Link to OpenClaw plugins directory
OPENCLAW_PLUGINS_DIR="${HOME}/.openclaw/extensions"
PLUGIN_NAME="memory-mem0-lancedb"

echo "[install] Linking to ${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}..."
mkdir -p "${OPENCLAW_PLUGINS_DIR}"

# Remove old link if exists
if [ -L "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}" ]; then
    rm "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}"
fi

# Create symlink
ln -sf "$(pwd)" "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}"

echo "[install] Plugin installed successfully!"
echo "[install] Next steps:"
echo "  1. Configure mem0ApiKey in openclaw.json"
echo "  2. Restart OpenClaw Gateway"
echo "  3. Verify with: openclaw plugins list"
