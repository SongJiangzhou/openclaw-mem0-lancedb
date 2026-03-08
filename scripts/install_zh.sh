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
            echo "用法: install_zh.sh [选项]"
            echo ""
            echo "选项:"
            echo "  --yes, -y        跳过所有的确认提示（全自动安装）"
            echo "  --skip-config    跳过交互式配置步骤（保留现有配置）"
            echo "  --help, -h       查看帮助"
            exit 0
            ;;
        *)
            echo "[install] 未知参数: $arg" >&2
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
            ""|[Nn]|[Nn][Oo])  echo "[install] 已取消."; exit 1 ;;
            *)                 echo "[install] 请输入 y 或 n." ;;
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
        read -r -p "请输入选项 [1-${count}]: " reply
        if [[ "$reply" =~ ^[0-9]+$ ]] && [ "$reply" -ge 1 ] && [ "$reply" -le "$count" ]; then
            return $((reply - 1))
        fi
        echo "[install] 请输入一个介于 1 到 ${count} 之间的数字."
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
            *) echo "[install] 请输入 y 或 n." ;;
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
    echo "║  openclaw-mem0-lancedb — 检测到已有版本                  ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""
    echo "  发现已存在的插件安装。"
    echo "  本次操作将在原位置平滑升级该插件。"
else
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  openclaw-mem0-lancedb — 全新安装                        ║"
    echo "╚══════════════════════════════════════════════════════════╝"
fi

echo ""

# ─── Step 1: Install dependencies ───────────────────────────────────
echo "[1/4] 正在安装依赖..."
confirm "     执行 npm install 吗?"
cd "$PLUGIN_DIR"
npm install

# ─── Step 2: Clean build ────────────────────────────────────────────
echo ""
echo "[2/4] 正在编译插件代码..."
confirm "     执行清理和编译 (rm -rf dist && tsc) 吗?"
rm -rf dist
npm run build

# ─── Step 3: Symlink ────────────────────────────────────────────────
echo ""
echo "[3/4] 正在链接插件..."
mkdir -p "${OPENCLAW_PLUGINS_DIR}"

if [ -L "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}" ]; then
    rm "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}"
elif [ -d "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}" ]; then
    echo "     ⚠ 在目标位置发现了一个常规目录 (非符号链接)。"
    echo "     这可能是之前手动复制的文件。"
    confirm "     是否删除它并替换为符号链接?"
    rm -rf "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}"
fi

ln -sf "${PLUGIN_DIR}" "${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}"
echo "     ✓ 已链接: ${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME} → ${PLUGIN_DIR}"

# ─── Step 4: Interactive configuration ──────────────────────────────
echo ""
echo "[4/4] 插件配置向导"

if [ "$SKIP_CONFIG" -eq 1 ]; then
    echo "     已跳过配置 (--skip-config)."
elif [ "$ASSUME_YES" -eq 1 ]; then
    echo "     已跳过配置 (--yes 模式，将使用默认配置)."
else
    if [ ! -f "$OPENCLAW_CONFIG" ]; then
        echo "     ⚠ 未能在 ${OPENCLAW_CONFIG} 找到 openclaw.json"
        echo "     将跳过交互配置，请稍后手动进行配置。"
    else
        echo ""
        echo "─── Embedding 模型配置 ─────────────────────────────────────"
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
            echo -e "  \033[1;33m⚠ 警告: 在 OpenClaw 配置中未检测到外部 Embedding 模型提供商。\033[0m"
            echo "    插件将退化使用轻量级的 \"fake\" 假向量 (基于字符编码)。"
            echo -e "    \033[1;31m这将严重降低长期记忆的语义检索质量！\033[0m"
            echo "    若要启用真正的语义检索，请在 openclaw.json 中配置:"
            echo "    agents.defaults.memorySearch.provider"
        else
            echo "  ✓ 找到 OpenClaw 全局 Embedding 提供商: ${EMBED_PROVIDER}"
            echo "    插件将自动复用该配置 (无需在此额外配置)"
        fi

        echo ""
        echo "─── Mem0 后端配置 ──────────────────────────────────────────"
        echo ""
        echo "请选择如何连接 Mem0 记忆引擎:"
        ask_choice "  Mem0 后端模式:" \
            "本地 Mem0 (自托管运行，不需要 API Key)" \
            "云端 Mem0 (api.mem0.ai，需要提供 API Key)" \
            "禁用 Mem0 (仅使用 LanceDB，不进行外部同步)"
        MEM0_CHOICE=$?

        MEM0_BASE_URL=""
        MEM0_API_KEY=""
        MEM0_MODE="remote"

        case $MEM0_CHOICE in
            0)
                MEM0_MODE="local"
                MEM0_BASE_URL=$(ask_input "  本地 Mem0 URL" "http://127.0.0.1:8000")
                MEM0_API_KEY=""
                echo "  ✓ 将使用本地 Mem0: ${MEM0_BASE_URL}"
                ;;
            1)
                MEM0_MODE="remote"
                MEM0_BASE_URL="https://api.mem0.ai"
                MEM0_API_KEY=$(ask_input "  请输入 Mem0 API Key" "")
                if [ -z "$MEM0_API_KEY" ]; then
                    echo "  ⚠ 未提供 API Key。Mem0 同步功能将被禁用，直到重新配置。"
                else
                    echo "  ✓ 将使用云端 Mem0 (已配置 API Key)"
                fi
                ;;
            2)
                MEM0_MODE="disabled"
                MEM0_BASE_URL="https://api.mem0.ai"
                MEM0_API_KEY=""
                echo "  ✓ Mem0 已禁用。将仅使用本地 LanceDB 模式。"
                ;;
        esac

        echo ""
        echo "─── 自动召回 (Auto Recall) ─────────────────────────────────"
        echo ""
        echo "自动召回会在每一轮对话前，主动搜索并向模型注入相关的上下文记忆。"

        AUTO_RECALL_ENABLED="false"
        AUTO_RECALL_TOPK=5
        AUTO_RECALL_MAXCHARS=800
        AUTO_RECALL_SCOPE="all"

        if ask_yes_no "  是否启用自动召回?" "y"; then
            AUTO_RECALL_ENABLED="true"
            AUTO_RECALL_TOPK=$(ask_input "  最大注入记忆条数 (topK)" "5")
            AUTO_RECALL_MAXCHARS=$(ask_input "  注入上下文的最大字符限制" "800")
            ask_choice "  召回范围 (Scope):" "all (全局：包含长短期记忆)" "long-term only (仅长期记忆)"
            case $? in
                0) AUTO_RECALL_SCOPE="all" ;;
                1) AUTO_RECALL_SCOPE="long-term" ;;
            esac
            echo "  ✓ 自动召回已启用 (topK=${AUTO_RECALL_TOPK}, maxChars=${AUTO_RECALL_MAXCHARS}, scope=${AUTO_RECALL_SCOPE})"
        else
            echo "  ✓ 自动召回已禁用"
        fi

        echo ""
        echo "─── 自动提取 (Auto Capture) ────────────────────────────────"
        echo ""
        echo "自动提取会在后台将你们的对话内容，自动提炼并存储为记忆片段。"

        AUTO_CAPTURE_ENABLED="false"
        AUTO_CAPTURE_SCOPE="long-term"
        AUTO_CAPTURE_REQUIRE_REPLY="true"
        AUTO_CAPTURE_MAX_CHARS=2000

        if ask_yes_no "  是否启用自动提取?" "n"; then
            AUTO_CAPTURE_ENABLED="true"
            ask_choice "  保存范围 (Scope):" "long-term (持久化的长期记忆)" "session (临时会话记忆)"
            case $? in
                0) AUTO_CAPTURE_SCOPE="long-term" ;;
                1) AUTO_CAPTURE_SCOPE="session" ;;
            esac
            if ask_yes_no "  是否要求必须在模型回复后才触发提取?" "y"; then
                AUTO_CAPTURE_REQUIRE_REPLY="true"
            else
                AUTO_CAPTURE_REQUIRE_REPLY="false"
            fi
            AUTO_CAPTURE_MAX_CHARS=$(ask_input "  提取单条消息的截断限制(字符)" "2000")
            echo "  ✓ 自动提取已启用 (scope=${AUTO_CAPTURE_SCOPE})"
        else
            echo "  ✓ 自动提取已禁用"
        fi

        # ─── Write configuration ────────────────────────────────────
        echo ""
        echo "─── 正在保存配置 ─────────────────────────────────────────"

        # Build the plugin config JSON
        PLUGIN_CONFIG=$(cat <<EOF
{
  "lancedbPath": "${HOME}/.openclaw/workspace/data/memory_lancedb",
  "mem0": {
    "mode": "${MEM0_MODE}",
    "baseUrl": "${MEM0_BASE_URL}",
    "apiKey": "${MEM0_API_KEY}"
  },
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
        echo "即将写入以下配置项:"
        echo ""
        echo "$PLUGIN_CONFIG"
        echo ""

        if confirm "     应用上述配置到 openclaw.json 吗?"; then
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
console.log('     ✓ 配置已成功写入 ' + cfgPath);
" "$PLUGIN_CONFIG"
        fi
    fi
fi

# ─── Done ────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  安装与配置完成!                                         ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  已安装插件: ${PLUGIN_NAME}"
echo "  源码路径:   ${PLUGIN_DIR}"
echo "  框架链接:   ${OPENCLAW_PLUGINS_DIR}/${PLUGIN_NAME}"
echo ""
echo "  后续步骤:"
echo "    1. 重启 OpenClaw Gateway 服务以加载插件"
echo "    2. 运行 'openclaw plugins list' 验证插件状态"
echo ""

if [ "$IS_UPGRADE" -eq 1 ]; then
    echo "  ℹ 本次操作为升级。你原有的 LanceDB 数据与本地审计日志已被完全保留，"
    echo "    仅更新了插件的底层代码。"
fi
