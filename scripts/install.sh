#!/bin/bash
set -e

ASSUME_YES=0

for arg in "$@"; do
    case "$arg" in
        --yes|-y)
            ASSUME_YES=1
            ;;
        *)
            echo "[install] Unknown argument: $arg" >&2
            exit 1
            ;;
    esac
done

confirm() {
    local prompt="$1"

    if [ "$ASSUME_YES" -eq 1 ]; then
        return 0
    fi

    while true; do
        read -r -p "$prompt [y/N] " reply
        case "$reply" in
            [Yy]|[Yy][Ee][Ss])
                return 0
                ;;
            ""|[Nn]|[Nn][Oo])
                echo "[install] Aborted."
                exit 1
                ;;
            *)
                echo "[install] Please answer y or n."
                ;;
        esac
    done
}

echo "[install] Building openclaw-mem0-lancedb plugin..."

cd "$(dirname "$0")/.."

# Install dependencies
confirm "[install] Continue with plugin installation?"
confirm "[install] Run npm install?"
npm install

# Build TypeScript
confirm "[install] Run npm run build?"
npm run build

# Link to OpenClaw plugins directory
OPENCLAW_PLUGINS_DIR="${HOME}/.openclaw/extensions"
PLUGIN_NAME="openclaw-mem0-lancedb"

echo "[install] Linking to ${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}..."
confirm "[install] Create or update the OpenClaw plugin symlink?"
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
