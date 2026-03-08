#!/bin/bash
set -e

# ─── Constants ───────────────────────────────────────────────────────
PLUGIN_NAME="openclaw-mem0-lancedb"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_PLUGINS_DIR="${HOME}/.openclaw/extensions"
OPENCLAW_CONFIG="${HOME}/.openclaw/openclaw.json"

# ─── Argument parsing ───────────────────────────────────────────────
ASSUME_YES=0
SKIP_CONFIG=0

for arg in "$@"; do
    case "$arg" in
        --yes|-y)     ASSUME_YES=1 ;;
        --skip-config) SKIP_CONFIG=1 ;;
        --help|-h)
            echo "Usage: install.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --yes, -y        Skip confirmation prompts"
            echo "  --skip-config    Skip interactive configuration (keep existing config)"
            echo "  --help, -h       Show this help"
            exit 0
            ;;
        *)
            echo "[install] Unknown argument: $arg" >&2
            exit 1
            ;;
    esac
done

# ─── Helpers ─────────────────────────────────────────────────────────
confirm() {
    local prompt="$1"
    if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
    while true; do
        read -r -p "$prompt [y/N] " reply
        case "$reply" in
            [Yy]|[Yy][Ee][Ss]) return 0 ;;
            ""|[Nn]|[Nn][Oo])  echo "[install] Aborted."; exit 1 ;;
            *)                 echo "[install] Please answer y or n." ;;
        esac
    done
}

ask_choice() {
    local prompt="$1"
    shift
    local options=("$@")
    local count=${#options[@]}

    echo ""
    echo "$prompt"
    for i in "${!options[@]}"; do
        echo "  $((i+1)). ${options[$i]}"
    done

    while true; do
        read -r -p "Enter choice [1-${count}]: " reply
        if [[ "$reply" =~ ^[0-9]+$ ]] && [ "$reply" -ge 1 ] && [ "$reply" -le "$count" ]; then
            return $((reply - 1))
        fi
        echo "[install] Please enter a number between 1 and ${count}."
    done
}

ask_yes_no() {
    local prompt="$1"
    local default="${2:-n}"

    local hint="[y/N]"
    [ "$default" = "y" ] && hint="[Y/n]"

    while true; do
        read -r -p "$prompt $hint " reply
        case "$reply" in
            [Yy]|[Yy][Ee][Ss]) return 0 ;;
            [Nn]|[Nn][Oo])     return 1 ;;
            "")
                [ "$default" = "y" ] && return 0
                return 1
                ;;
            *) echo "[install] Please answer y or n." ;;
        esac
    done
}

ask_input() {
    local prompt="$1"
    local default="$2"

    if [ -n "$default" ]; then
        read -r -p "$prompt [${default}]: " reply
        echo "${reply:-$default}"
    else
        read -r -p "$prompt: " reply
        echo "$reply"
    fi
}

# ─── Detect upgrade vs fresh install ────────────────────────────────
IS_UPGRADE=0
if [ -L "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}" ] || [ -d "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}" ]; then
    IS_UPGRADE=1
fi

if [ "$IS_UPGRADE" -eq 1 ]; then
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  openclaw-mem0-lancedb — Upgrade Detected               ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""
    echo "  Existing plugin installation found."
    echo "  This will upgrade the plugin in-place."
else
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  openclaw-mem0-lancedb — Fresh Install                  ║"
    echo "╚══════════════════════════════════════════════════════════╝"
fi

echo ""

# ─── Step 1: Install dependencies ───────────────────────────────────
echo "[1/4] Installing dependencies..."
confirm "     Run npm install?"
cd "$PLUGIN_DIR"
npm install

# ─── Step 2: Clean build ────────────────────────────────────────────
echo ""
echo "[2/4] Building plugin..."
confirm "     Clean and rebuild (rm -rf dist && tsc)?"
rm -rf dist
npm run build

# ─── Step 3: Symlink ────────────────────────────────────────────────
echo ""
echo "[3/4] Linking plugin..."
mkdir -p "${OPENCLAW_PLUGINS_DIR}"

if [ -L "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}" ]; then
    rm "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}"
elif [ -d "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}" ]; then
    echo "     ⚠ Found a directory (not symlink) at the target location."
    echo "     This may be a manually copied installation."
    confirm "     Remove it and replace with symlink?"
    rm -rf "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}"
fi

ln -sf "${PLUGIN_DIR}" "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}"
echo "     ✓ Linked: ${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME} → ${PLUGIN_DIR}"

# ─── Step 4: Interactive configuration ──────────────────────────────
echo ""
echo "[4/4] Plugin configuration"

if [ "$SKIP_CONFIG" -eq 1 ]; then
    echo "     Skipped (--skip-config)."
elif [ "$ASSUME_YES" -eq 1 ]; then
    echo "     Skipped (--yes mode, using defaults)."
else
    if [ ! -f "$OPENCLAW_CONFIG" ]; then
        echo "     ⚠ openclaw.json not found at ${OPENCLAW_CONFIG}"
        echo "     Skipping configuration. Please configure manually."
    else
        echo ""
        echo "─── Embedding Setup ────────────────────────────────────────"
        echo ""
        EMBED_PROVIDER=$(node -e "
try {
  const config = require('${OPENCLAW_CONFIG}');
  const ms = config.agents?.defaults?.memorySearch;
  if (ms && ms.enabled !== false && ms.provider) {
    console.log(ms.provider);
  } else {
    console.log('fake');
  }
} catch (e) {
  console.log('fake');
}
")
        if [ "$EMBED_PROVIDER" = "fake" ]; then
            echo -e "  \033[1;33m⚠ WARNING: No external embedding provider detected in OpenClaw config.\033[0m"
            echo "    The plugin will fall back to using a lightweight \"fake\" char-code embedding."
            echo -e "    \033[1;31mTHIS WILL SEVERELY DEGRADE LONG-TERM MEMORY SEMANTIC SEARCH QUALITY!\033[0m"
            echo "    To use proper semantic search, configure it in openclaw.json under:"
            echo "    agents.defaults.memorySearch.provider"
        else
            echo "  ✓ Found OpenClaw embedding provider: ${EMBED_PROVIDER}"
            echo "    The plugin will automatically reuse this provider (No extra configuration needed)."
        fi

        echo ""
        echo "─── Mem0 Backend ───────────────────────────────────────────"
        echo ""
        echo "Choose how to connect to Mem0:"
        ask_choice "  Mem0 mode:" \
            "Local Mem0 (self-hosted, no API key needed)" \
            "Cloud Mem0 (api.mem0.ai, requires API key)" \
            "Disable Mem0 (LanceDB-only, no sync)"
        MEM0_CHOICE=$?

        MEM0_BASE_URL=""
        MEM0_API_KEY=""
        MEM0_MODE="remote"

        case $MEM0_CHOICE in
            0)
                MEM0_MODE="local"
                MEM0_BASE_URL=$(ask_input "  Local Mem0 URL" "http://127.0.0.1:8000")
                MEM0_API_KEY=""
                echo "  ✓ Using local Mem0 at ${MEM0_BASE_URL}"
                ;;
            1)
                MEM0_MODE="remote"
                MEM0_BASE_URL="https://api.mem0.ai"
                MEM0_API_KEY=$(ask_input "  Mem0 API key" "")
                if [ -z "$MEM0_API_KEY" ]; then
                    echo "  ⚠ No API key provided. Mem0 sync will be disabled until configured."
                else
                    echo "  ✓ Using Mem0 Cloud with API key"
                fi
                ;;
            2)
                MEM0_MODE="disabled"
                MEM0_BASE_URL="https://api.mem0.ai"
                MEM0_API_KEY=""
                echo "  ✓ Mem0 disabled. Using LanceDB-only mode."
                ;;
        esac

        echo ""
        echo "─── Auto Recall ──────────────────────────────────────────"
        echo ""
        echo "Auto Recall injects relevant memories before each turn."

        AUTO_RECALL_ENABLED="false"
        AUTO_RECALL_TOPK=5
        AUTO_RECALL_MAXCHARS=800
        AUTO_RECALL_SCOPE="all"

        if ask_yes_no "  Enable auto recall?" "y"; then
            AUTO_RECALL_ENABLED="true"
            AUTO_RECALL_TOPK=$(ask_input "  Max memories to inject (topK)" "5")
            AUTO_RECALL_MAXCHARS=$(ask_input "  Max chars for injected context" "800")
            ask_choice "  Recall scope:" "all (long-term + session)" "long-term only"
            case $? in
                0) AUTO_RECALL_SCOPE="all" ;;
                1) AUTO_RECALL_SCOPE="long-term" ;;
            esac
            echo "  ✓ Auto recall enabled (topK=${AUTO_RECALL_TOPK}, maxChars=${AUTO_RECALL_MAXCHARS}, scope=${AUTO_RECALL_SCOPE})"
        else
            echo "  ✓ Auto recall disabled"
        fi

        echo ""
        echo "─── Auto Capture ─────────────────────────────────────────"
        echo ""
        echo "Auto Capture extracts memories from conversations automatically."

        AUTO_CAPTURE_ENABLED="false"
        AUTO_CAPTURE_SCOPE="long-term"
        AUTO_CAPTURE_REQUIRE_REPLY="true"
        AUTO_CAPTURE_MAX_CHARS=2000

        if ask_yes_no "  Enable auto capture?" "n"; then
            AUTO_CAPTURE_ENABLED="true"
            ask_choice "  Capture scope:" "long-term (persistent)" "session (ephemeral)"
            case $? in
                0) AUTO_CAPTURE_SCOPE="long-term" ;;
                1) AUTO_CAPTURE_SCOPE="session" ;;
            esac
            if ask_yes_no "  Require assistant reply before capture?" "y"; then
                AUTO_CAPTURE_REQUIRE_REPLY="true"
            else
                AUTO_CAPTURE_REQUIRE_REPLY="false"
            fi
            AUTO_CAPTURE_MAX_CHARS=$(ask_input "  Max chars per captured message" "2000")
            echo "  ✓ Auto capture enabled (scope=${AUTO_CAPTURE_SCOPE})"
        else
            echo "  ✓ Auto capture disabled"
        fi

        # ─── Write configuration ────────────────────────────────────
        echo ""
        echo "─── Writing Configuration ────────────────────────────────"

        # Build the plugin config JSON
        PLUGIN_CONFIG=$(cat <<EOF
{
  "lancedbPath": "${HOME}/.openclaw/workspace/data/memory_lancedb",
  "mem0": {
    "mode": "${MEM0_MODE}",
    "baseUrl": "${MEM0_BASE_URL}",
    "apiKey": "${MEM0_API_KEY}"
  },
  "mem0BaseUrl": "${MEM0_BASE_URL}",
  "mem0ApiKey": "${MEM0_API_KEY}",
  "outboxDbPath": "${HOME}/.openclaw/workspace/data/memory_outbox.db",
  "auditStorePath": "${HOME}/.openclaw/workspace/data/memory_audit/memory_records.jsonl",
  "autoRecall": {
    "enabled": ${AUTO_RECALL_ENABLED},
    "topK": ${AUTO_RECALL_TOPK},
    "maxChars": ${AUTO_RECALL_MAXCHARS},
    "scope": "${AUTO_RECALL_SCOPE}"
  },
  "autoCapture": {
    "enabled": ${AUTO_CAPTURE_ENABLED},
    "scope": "${AUTO_CAPTURE_SCOPE}",
    "requireAssistantReply": ${AUTO_CAPTURE_REQUIRE_REPLY},
    "maxCharsPerMessage": ${AUTO_CAPTURE_MAX_CHARS}
  }
}
EOF
)

        echo ""
        echo "The following configuration will be written:"
        echo ""
        echo "$PLUGIN_CONFIG"
        echo ""

        if confirm "     Apply this configuration to openclaw.json?"; then
            # Use node to safely merge into the existing openclaw.json
            node -e "
const fs = require('fs');
const cfgPath = '${OPENCLAW_CONFIG}';
const pluginConfig = JSON.parse(process.argv[1]);

const oc = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));

// Ensure plugin paths exist
if (!oc.plugins) oc.plugins = {};
if (!oc.plugins.entries) oc.plugins.entries = {};
if (!oc.plugins.entries['${PLUGIN_NAME}']) oc.plugins.entries['${PLUGIN_NAME}'] = {};

oc.plugins.entries['${PLUGIN_NAME}'].enabled = true;
oc.plugins.entries['${PLUGIN_NAME}'].config = pluginConfig;

// Ensure plugin is in allow list
if (!oc.plugins.allow) oc.plugins.allow = [];
if (!oc.plugins.allow.includes('${PLUGIN_NAME}')) {
  oc.plugins.allow.push('${PLUGIN_NAME}');
}

// Ensure plugin load path
if (!oc.plugins.load) oc.plugins.load = {};
if (!oc.plugins.load.paths) oc.plugins.load.paths = [];
if (!oc.plugins.load.paths.includes('${PLUGIN_DIR}')) {
  oc.plugins.load.paths.push('${PLUGIN_DIR}');
}

// Set memory slot
if (!oc.plugins.slots) oc.plugins.slots = {};
oc.plugins.slots.memory = '${PLUGIN_NAME}';

fs.writeFileSync(cfgPath, JSON.stringify(oc, null, 2) + '\n');
console.log('     ✓ Configuration written to ' + cfgPath);
" "$PLUGIN_CONFIG"
        fi
    fi
fi

# ─── Done ────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Installation complete!                                  ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Plugin: ${PLUGIN_NAME}"
echo "  Path:   ${PLUGIN_DIR}"
echo "  Link:   ${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}"
echo ""
echo "  Next steps:"
echo "    1. Restart OpenClaw Gateway to load the updated plugin"
echo "    2. Verify with: openclaw plugins list"
echo ""

if [ "$IS_UPGRADE" -eq 1 ]; then
    echo "  ℹ This was an upgrade. Your data in LanceDB and audit logs"
    echo "    is preserved. Only the plugin code was updated."
fi
