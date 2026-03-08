#!/usr/bin/env node

import { confirm, intro, isCancel, outro, select, text } from '@clack/prompts';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PLUGIN_NAME = 'openclaw-mem0-lancedb';
const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OPENCLAW_PLUGINS_DIR = path.join(os.homedir(), '.openclaw', 'extensions');
const OPENCLAW_CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');

const STRINGS = {
  en: {
    intro: 'openclaw-mem0-lancedb installer',
    confirmInstall: 'Continue with installation?',
    configStep: 'Plugin configuration',
    missingConfig: `openclaw.json not found at ${OPENCLAW_CONFIG}. Skipping configuration.`,
    mem0Mode: 'Mem0 mode',
    mem0LocalUrl: 'Local Mem0 URL',
    mem0ApiKey: 'Mem0 API key',
    autoRecall: 'Enable auto recall?',
    autoRecallTopK: 'Max memories to inject (topK)',
    autoRecallMaxChars: 'Max chars for injected context',
    autoRecallScope: 'Recall scope',
    autoCapture: 'Enable auto capture?',
    autoCaptureScope: 'Capture scope',
    autoCaptureRequireReply: 'Require assistant reply before capture?',
    autoCaptureMaxChars: 'Max chars per captured message',
    debugMode: 'Debug mode',
    debugLogDir: 'Debug log directory',
    applyConfig: 'Write this plugin config to openclaw.json?',
    done: 'Installation complete',
    choices: {
      mem0Local: 'Local Mem0 (self-hosted, no API key needed)',
      mem0Remote: 'Cloud Mem0 (api.mem0.ai, requires API key)',
      mem0Disabled: 'Disable Mem0 (LanceDB-only, no sync)',
      recallAll: 'all (long-term + session)',
      recallLongTerm: 'long-term only',
      captureLongTerm: 'long-term (persistent)',
      captureSession: 'session (ephemeral)',
      debugBasic: 'basic (recommended)',
      debugOff: 'off',
      debugVerbose: 'verbose',
      debugVerboseFile: 'verbose + file',
    },
  },
  zh: {
    intro: 'openclaw-mem0-lancedb 安装器',
    confirmInstall: '继续安装吗？',
    configStep: '插件配置',
    missingConfig: `未能在 ${OPENCLAW_CONFIG} 找到 openclaw.json，已跳过配置。`,
    mem0Mode: 'Mem0 后端模式',
    mem0LocalUrl: '本地 Mem0 URL',
    mem0ApiKey: 'Mem0 API Key',
    autoRecall: '是否启用自动召回？',
    autoRecallTopK: '最大注入记忆条数 (topK)',
    autoRecallMaxChars: '注入上下文的最大字符限制',
    autoRecallScope: '召回范围',
    autoCapture: '是否启用自动提取？',
    autoCaptureScope: '保存范围',
    autoCaptureRequireReply: '是否要求必须在模型回复后才触发提取？',
    autoCaptureMaxChars: '提取单条消息的截断限制(字符)',
    debugMode: '调试模式',
    debugLogDir: '调试日志目录',
    applyConfig: '将上述插件配置写入 openclaw.json 吗？',
    done: '安装完成',
    choices: {
      mem0Local: '本地 Mem0 (自托管运行，不需要 API Key)',
      mem0Remote: '云端 Mem0 (api.mem0.ai，需要提供 API Key)',
      mem0Disabled: '禁用 Mem0 (仅使用 LanceDB，不进行外部同步)',
      recallAll: 'all (全局：包含长短期记忆)',
      recallLongTerm: 'long-term only (仅长期记忆)',
      captureLongTerm: 'long-term (持久化的长期记忆)',
      captureSession: 'session (临时会话记忆)',
      debugBasic: 'basic（推荐）',
      debugOff: 'off',
      debugVerbose: 'verbose',
      debugVerboseFile: 'verbose + file',
    },
  },
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const strings = STRINGS[args.lang];

  intro(strings.intro);

  if (!args.yes) {
    const shouldContinue = await confirm({ message: strings.confirmInstall });
    if (isCancel(shouldContinue) || !shouldContinue) {
      process.exit(1);
    }
  }

  runCommand('npm', ['install']);
  runCommand('npm', ['run', 'build']);
  ensureSymlink();

  if (!args.skipConfig) {
    if (!existsSync(OPENCLAW_CONFIG)) {
      console.warn(strings.missingConfig);
    } else {
      const openclawConfig = loadJson(OPENCLAW_CONFIG);
      const pluginConfig = args.yes
        ? buildDefaultPluginConfig()
        : await promptForConfig(strings);
      const shouldApply = args.yes ? true : await confirm({ message: strings.applyConfig });
      if (isCancel(shouldApply)) {
        process.exit(1);
      }
      if (shouldApply) {
        const merged = mergeOpenClawConfig(openclawConfig, pluginConfig);
        writeFileSync(OPENCLAW_CONFIG, `${JSON.stringify(merged, null, 2)}\n`);
      }
    }
  }

  outro(strings.done);
}

function parseArgs(argv) {
  const args = { yes: false, skipConfig: false, lang: 'en' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--yes' || arg === '-y') {
      args.yes = true;
      continue;
    }
    if (arg === '--skip-config') {
      args.skipConfig = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/install.mjs [--lang en|zh] [--yes] [--skip-config]');
      process.exit(0);
    }
    if (arg === '--lang') {
      const value = argv[index + 1];
      if (!value || !['en', 'zh'].includes(value)) {
        throw new Error('Expected --lang en|zh');
      }
      args.lang = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function runCommand(command, args) {
  execFileSync(command, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
}

function ensureSymlink() {
  mkdirSync(OPENCLAW_PLUGINS_DIR, { recursive: true });
  const linkPath = path.join(OPENCLAW_PLUGINS_DIR, PLUGIN_NAME);
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      rmSync(linkPath, { recursive: true, force: true });
    }
  }
  symlinkSync(ROOT_DIR, linkPath);
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function buildDefaultPluginConfig() {
  return {
    lancedbPath: path.join(os.homedir(), '.openclaw', 'workspace', 'data', 'memory_lancedb'),
    mem0: {
      mode: 'remote',
      baseUrl: 'https://api.mem0.ai',
      apiKey: '',
    },
    outboxDbPath: path.join(os.homedir(), '.openclaw', 'workspace', 'data', 'memory_outbox.db'),
    auditStorePath: path.join(os.homedir(), '.openclaw', 'workspace', 'data', 'memory_audit', 'memory_records.jsonl'),
    debug: {
      mode: 'basic',
    },
    autoRecall: {
      enabled: true,
      topK: 5,
      maxChars: 800,
      scope: 'all',
    },
    autoCapture: {
      enabled: false,
      scope: 'long-term',
      requireAssistantReply: true,
      maxCharsPerMessage: 2000,
    },
  };
}

async function promptForConfig(strings) {
  const mem0Mode = await select({
    message: strings.mem0Mode,
    options: [
      { value: 'local', label: strings.choices.mem0Local },
      { value: 'remote', label: strings.choices.mem0Remote },
      { value: 'disabled', label: strings.choices.mem0Disabled },
    ],
  });
  if (isCancel(mem0Mode)) process.exit(1);

  let mem0BaseUrl = 'https://api.mem0.ai';
  let mem0ApiKey = '';
  if (mem0Mode === 'local') {
    const value = await text({ message: strings.mem0LocalUrl, defaultValue: 'http://127.0.0.1:8000' });
    if (isCancel(value)) process.exit(1);
    mem0BaseUrl = value;
  } else if (mem0Mode === 'remote') {
    const value = await text({ message: strings.mem0ApiKey, defaultValue: '' });
    if (isCancel(value)) process.exit(1);
    mem0ApiKey = value;
  }

  const autoRecallEnabled = await confirm({ message: strings.autoRecall, initialValue: true });
  if (isCancel(autoRecallEnabled)) process.exit(1);
  const autoRecallTopK = autoRecallEnabled ? Number(await text({ message: strings.autoRecallTopK, defaultValue: '5' })) : 5;
  const autoRecallMaxChars = autoRecallEnabled ? Number(await text({ message: strings.autoRecallMaxChars, defaultValue: '800' })) : 800;
  let autoRecallScope = 'all';
  if (autoRecallEnabled) {
    autoRecallScope = await select({
      message: strings.autoRecallScope,
      options: [
        { value: 'all', label: strings.choices.recallAll },
        { value: 'long-term', label: strings.choices.recallLongTerm },
      ],
    });
    if (isCancel(autoRecallScope)) process.exit(1);
  }

  const autoCaptureEnabled = await confirm({ message: strings.autoCapture, initialValue: false });
  if (isCancel(autoCaptureEnabled)) process.exit(1);
  let autoCaptureScope = 'long-term';
  let autoCaptureRequireReply = true;
  let autoCaptureMaxChars = 2000;
  if (autoCaptureEnabled) {
    autoCaptureScope = await select({
      message: strings.autoCaptureScope,
      options: [
        { value: 'long-term', label: strings.choices.captureLongTerm },
        { value: 'session', label: strings.choices.captureSession },
      ],
    });
    if (isCancel(autoCaptureScope)) process.exit(1);
    autoCaptureRequireReply = await confirm({ message: strings.autoCaptureRequireReply, initialValue: true });
    if (isCancel(autoCaptureRequireReply)) process.exit(1);
    autoCaptureMaxChars = Number(await text({ message: strings.autoCaptureMaxChars, defaultValue: '2000' }));
  }

  const debugChoice = await select({
    message: strings.debugMode,
    options: [
      { value: 'basic', label: strings.choices.debugBasic },
      { value: 'off', label: strings.choices.debugOff },
      { value: 'verbose', label: strings.choices.debugVerbose },
      { value: 'verbose-file', label: strings.choices.debugVerboseFile },
    ],
  });
  if (isCancel(debugChoice)) process.exit(1);
  let debugLogDir;
  if (debugChoice === 'verbose-file') {
    const value = await text({ message: strings.debugLogDir, defaultValue: '~/.openclaw/workspace/logs/openclaw-mem0-lancedb' });
    if (isCancel(value)) process.exit(1);
    debugLogDir = value;
  }

  return {
    lancedbPath: path.join(os.homedir(), '.openclaw', 'workspace', 'data', 'memory_lancedb'),
    mem0: {
      mode: mem0Mode,
      baseUrl: mem0BaseUrl,
      apiKey: mem0ApiKey,
    },
    outboxDbPath: path.join(os.homedir(), '.openclaw', 'workspace', 'data', 'memory_outbox.db'),
    auditStorePath: path.join(os.homedir(), '.openclaw', 'workspace', 'data', 'memory_audit', 'memory_records.jsonl'),
    debug: {
      mode: debugChoice === 'verbose-file' ? 'verbose' : debugChoice,
      ...(debugLogDir ? { logDir: debugLogDir } : {}),
    },
    autoRecall: {
      enabled: autoRecallEnabled,
      topK: autoRecallTopK,
      maxChars: autoRecallMaxChars,
      scope: autoRecallScope,
    },
    autoCapture: {
      enabled: autoCaptureEnabled,
      scope: autoCaptureScope,
      requireAssistantReply: autoCaptureRequireReply,
      maxCharsPerMessage: autoCaptureMaxChars,
    },
  };
}

function mergeOpenClawConfig(openclawConfig, pluginConfig) {
  const next = { ...openclawConfig };
  if (!next.plugins) next.plugins = {};
  if (!next.plugins.entries) next.plugins.entries = {};
  if (!next.plugins.entries[PLUGIN_NAME]) next.plugins.entries[PLUGIN_NAME] = {};
  next.plugins.entries[PLUGIN_NAME].enabled = true;
  next.plugins.entries[PLUGIN_NAME].config = pluginConfig;

  if (!Array.isArray(next.plugins.allow)) next.plugins.allow = [];
  if (!next.plugins.allow.includes(PLUGIN_NAME)) next.plugins.allow.push(PLUGIN_NAME);

  if (!next.plugins.load) next.plugins.load = {};
  if (!Array.isArray(next.plugins.load.paths)) next.plugins.load.paths = [];
  if (!next.plugins.load.paths.includes(ROOT_DIR)) next.plugins.load.paths.push(ROOT_DIR);

  if (!next.plugins.slots) next.plugins.slots = {};
  next.plugins.slots.memory = PLUGIN_NAME;

  return next;
}
