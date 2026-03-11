#!/usr/bin/env node

import { confirm, intro, isCancel, outro, select, text } from '@clack/prompts';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { styleText } from 'node:util';

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
    mem0LlmProvider: 'Local Mem0 LLM provider',
    mem0LlmBaseUrl: 'Local Mem0 LLM base URL',
    mem0LlmApiKey: 'Local Mem0 LLM API key',
    mem0LlmModel: 'Local Mem0 LLM model',
    autoRecall: 'Enable auto recall?',
    autoRecallTopK: 'Max memories to inject (topK)',
    autoRecallMaxChars: 'Max chars for injected context',
    autoRecallScope: 'Recall scope',
    autoRecallRerankerProvider: 'Recall reranker',
    autoRecallRerankerBaseUrl: 'Voyage reranker base URL',
    autoRecallRerankerApiKey: 'Voyage reranker API key',
    autoRecallRerankerModel: 'Voyage reranker model',
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
      mem0LlmDeepseek: 'deepseek (recommended)',
      mem0LlmGemini: 'gemini',
      mem0LlmOpenAI: 'openai',
      mem0LlmOllama: 'ollama',
      recallAll: 'all (long-term + session)',
      recallLongTerm: 'long-term only',
      rerankerLocal: 'local (built-in lightweight reranker)',
      rerankerVoyage: 'voyage (VoyageAI API)',
      rerankerNone: 'none (keep merged recall order)',
      captureLongTerm: 'long-term (persistent)',
      captureSession: 'session (ephemeral)',
      debug: 'debug (recommended)',
      debugOff: 'off',
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
    mem0LlmProvider: '本地 Mem0 LLM 提供商',
    mem0LlmBaseUrl: '本地 Mem0 LLM Base URL',
    mem0LlmApiKey: '本地 Mem0 LLM API Key',
    mem0LlmModel: '本地 Mem0 LLM 模型',
    autoRecall: '是否启用自动召回？',
    autoRecallTopK: '最大注入记忆条数 (topK)',
    autoRecallMaxChars: '注入上下文的最大字符限制',
    autoRecallScope: '召回范围',
    autoRecallRerankerProvider: '召回精排器',
    autoRecallRerankerBaseUrl: 'Voyage 精排 Base URL',
    autoRecallRerankerApiKey: 'Voyage 精排 API Key',
    autoRecallRerankerModel: 'Voyage 精排模型',
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
      mem0LlmDeepseek: 'deepseek（推荐）',
      mem0LlmGemini: 'gemini',
      mem0LlmOpenAI: 'openai',
      mem0LlmOllama: 'ollama',
      recallAll: 'all (全局：包含长短期记忆)',
      recallLongTerm: 'long-term only (仅长期记忆)',
      rerankerLocal: 'local (内置轻量精排)',
      rerankerVoyage: 'voyage (VoyageAI API)',
      rerankerNone: 'none (保持召回合并顺序)',
      captureLongTerm: 'long-term (持久化的长期记忆)',
      captureSession: 'session (临时会话记忆)',
      debug: 'debug（推荐）',
      debugOff: 'off',
    },
  },
};

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

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
      const existingPluginConfig = getExistingPluginConfig(openclawConfig);
      const pluginConfig = args.yes
        ? buildDefaultPluginConfig(existingPluginConfig)
        : await promptForConfig(strings, existingPluginConfig);
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

export function buildDefaultPluginConfig(existingConfig = {}) {
  const existingMem0 = existingConfig?.mem0 || {};
  const existingMem0Llm = existingMem0?.llm || {};
  const existingAutoRecall = existingConfig?.autoRecall || {};
  const existingAutoCapture = existingConfig?.autoCapture || {};
  const existingDebug = existingConfig?.debug || {};
  const existingReranker = existingConfig?.autoRecall?.reranker || {};
  const memoryRoot = path.join(os.homedir(), '.openclaw', 'workspace', 'data', 'memory');
  const autoCaptureEnabled = existingAutoCapture.enabled ?? true;
  const mem0Mode = existingMem0.mode || (autoCaptureEnabled ? 'local' : 'disabled');
  const mem0BaseUrl = mem0Mode === 'remote'
    ? (existingMem0.baseUrl || 'https://api.mem0.ai')
    : mem0Mode === 'local'
      ? (existingMem0.baseUrl || 'http://127.0.0.1:8000')
      : '';

  return {
    lancedbPath: path.join(memoryRoot, 'lancedb'),
    mem0: {
      mode: mem0Mode,
      baseUrl: mem0BaseUrl,
      apiKey: mem0Mode === 'remote' ? existingMem0.apiKey || '' : '',
      llm: {
        provider: existingMem0Llm.provider || 'deepseek',
        baseUrl: existingMem0Llm.baseUrl || 'https://api.deepseek.com',
        apiKey: existingMem0Llm.apiKey || '',
        model: existingMem0Llm.model || 'deepseek-chat',
      },
    },
    outboxDbPath: path.join(memoryRoot, 'outbox.json'),
    auditStorePath: path.join(memoryRoot, 'audit', 'memory_records.jsonl'),
    debug: {
      mode: 'debug',
    },
    autoRecall: {
      enabled: true,
      topK: existingAutoRecall.topK || 8,
      maxChars: existingAutoRecall.maxChars || 1400,
      scope: existingAutoRecall.scope || 'all',
      reranker: {
        provider: existingReranker.provider || 'local',
        baseUrl: existingReranker.baseUrl || 'https://api.voyageai.com/v1',
        apiKey: existingReranker.apiKey || '',
        model: existingReranker.model || 'rerank-2.5-lite',
      },
    },
    autoCapture: {
      enabled: autoCaptureEnabled,
      scope: existingAutoCapture.scope || 'long-term',
      requireAssistantReply: existingAutoCapture.requireAssistantReply ?? true,
      maxCharsPerMessage: existingAutoCapture.maxCharsPerMessage || 2000,
    },
    ...(existingDebug.mode || existingDebug.logDir ? { debug: { mode: existingDebug.mode || 'debug', ...(existingDebug.logDir ? { logDir: existingDebug.logDir } : {}) } } : {}),
  };
}

export async function promptForConfig(strings, existingConfig = {}) {
  const existingMem0 = existingConfig?.mem0 || {};
  const existingMem0Llm = existingMem0?.llm || {};
  const existingAutoRecall = existingConfig?.autoRecall || {};
  const existingAutoCapture = existingConfig?.autoCapture || {};
  const existingDebug = existingConfig?.debug || {};
  const existingReranker = existingConfig?.autoRecall?.reranker || {};
  const memoryRoot = path.join(os.homedir(), '.openclaw', 'workspace', 'data', 'memory');
  let mem0Mode = existingMem0.mode || (existingAutoCapture.enabled ?? true ? 'local' : 'disabled');
  let mem0BaseUrl = mem0Mode === 'remote' ? 'https://api.mem0.ai' : '';
  let mem0ApiKey = '';
  let mem0LlmProvider = existingMem0Llm.provider || 'deepseek';
  let mem0LlmBaseUrl = existingMem0Llm.baseUrl || 'https://api.deepseek.com';
  let mem0LlmApiKey = existingMem0Llm.apiKey || '';
  let mem0LlmModel = existingMem0Llm.model || 'deepseek-chat';

  const autoRecallEnabled = await confirm({
    message: withDefaultHint(strings.autoRecall, 'true', strings),
    initialValue: existingAutoRecall.enabled ?? true,
  });
  if (isCancel(autoRecallEnabled)) process.exit(1);
  const currentTopK = String(existingAutoRecall.topK ?? 8);
  const autoRecallTopK = autoRecallEnabled
    ? await text({
      message: withDefaultHint(strings.autoRecallTopK, '8', strings),
      defaultValue: currentTopK,
      placeholder: '8',
    })
    : currentTopK;
  const resolvedAutoRecallTopK = autoRecallEnabled ? resolveNumericPromptValue(autoRecallTopK, currentTopK) : Number(currentTopK);
  const currentMaxChars = String(existingAutoRecall.maxChars ?? 1400);
  const autoRecallMaxChars = autoRecallEnabled
    ? await text({
      message: withDefaultHint(strings.autoRecallMaxChars, '1400', strings),
      defaultValue: currentMaxChars,
      placeholder: '1400',
    })
    : currentMaxChars;
  const resolvedAutoRecallMaxChars = autoRecallEnabled ? resolveNumericPromptValue(autoRecallMaxChars, currentMaxChars) : Number(currentMaxChars);
  let autoRecallScope = existingAutoRecall.scope || 'all';
  let autoRecallRerankerProvider = existingReranker.provider || 'local';
  let autoRecallRerankerBaseUrl = existingReranker.baseUrl || 'https://api.voyageai.com/v1';
  let autoRecallRerankerApiKey = existingReranker.apiKey || '';
  let autoRecallRerankerModel = existingReranker.model || 'rerank-2.5-lite';
  if (autoRecallEnabled) {
    autoRecallScope = await select({
      message: withDefaultHint(strings.autoRecallScope, strings.choices.recallAll, strings),
      options: [
        { value: 'all', label: strings.choices.recallAll },
        { value: 'long-term', label: strings.choices.recallLongTerm },
      ],
      initialValue: autoRecallScope,
    });
    if (isCancel(autoRecallScope)) process.exit(1);

    autoRecallRerankerProvider = await select({
      message: withDefaultHint(strings.autoRecallRerankerProvider, strings.choices.rerankerLocal, strings),
      options: [
        { value: 'local', label: strings.choices.rerankerLocal },
        { value: 'voyage', label: strings.choices.rerankerVoyage },
        { value: 'none', label: strings.choices.rerankerNone },
      ],
      initialValue: autoRecallRerankerProvider,
    });
    if (isCancel(autoRecallRerankerProvider)) process.exit(1);

    if (autoRecallRerankerProvider === 'voyage') {
      const currentRerankerBaseUrl = autoRecallRerankerBaseUrl;
      const baseUrl = await text({
        message: withDefaultHint(strings.autoRecallRerankerBaseUrl, 'https://api.voyageai.com/v1', strings),
        defaultValue: currentRerankerBaseUrl,
        placeholder: currentRerankerBaseUrl,
      });
      if (isCancel(baseUrl)) process.exit(1);
      autoRecallRerankerBaseUrl = resolveTextPromptValue(baseUrl, currentRerankerBaseUrl);

      const currentRerankerApiKey = autoRecallRerankerApiKey;
      const apiKey = await text({
        message: withDefaultHint(strings.autoRecallRerankerApiKey, '', strings),
        defaultValue: currentRerankerApiKey,
        placeholder: currentRerankerApiKey,
      });
      if (isCancel(apiKey)) process.exit(1);
      autoRecallRerankerApiKey = resolveTextPromptValue(apiKey, currentRerankerApiKey);

      const currentRerankerModel = autoRecallRerankerModel;
      const model = await text({
        message: withDefaultHint(strings.autoRecallRerankerModel, 'rerank-2.5-lite', strings),
        defaultValue: currentRerankerModel,
        placeholder: 'rerank-2.5-lite',
      });
      if (isCancel(model)) process.exit(1);
      autoRecallRerankerModel = resolveTextPromptValue(model, currentRerankerModel);
    }
  }

  const autoCaptureEnabled = await confirm({
    message: withDefaultHint(strings.autoCapture, 'true', strings),
    initialValue: existingAutoCapture.enabled ?? true,
  });
  if (isCancel(autoCaptureEnabled)) process.exit(1);
  let autoCaptureScope = existingAutoCapture.scope || 'long-term';
  let autoCaptureRequireReply = existingAutoCapture.requireAssistantReply ?? true;
  let autoCaptureMaxChars = Number(existingAutoCapture.maxCharsPerMessage ?? 2000);
  if (autoCaptureEnabled) {
    mem0Mode = await select({
      message: withDefaultHint(strings.mem0Mode, strings.choices.mem0Local, strings),
      options: [
        { value: 'local', label: strings.choices.mem0Local },
        { value: 'remote', label: strings.choices.mem0Remote },
        { value: 'disabled', label: strings.choices.mem0Disabled },
      ],
      initialValue: existingMem0.mode && existingMem0.mode !== 'disabled' ? existingMem0.mode : 'local',
    });
    if (isCancel(mem0Mode)) process.exit(1);

    if (mem0Mode === 'local') {
      const currentLocalUrl = existingMem0.mode === 'local' ? existingMem0.baseUrl || 'http://127.0.0.1:8000' : 'http://127.0.0.1:8000';
      const value = await text({
        message: withDefaultHint(strings.mem0LocalUrl, 'http://127.0.0.1:8000', strings),
        defaultValue: currentLocalUrl,
        placeholder: currentLocalUrl,
      });
      if (isCancel(value)) process.exit(1);
      mem0BaseUrl = resolveTextPromptValue(value, currentLocalUrl);
      mem0ApiKey = '';

      mem0LlmProvider = await select({
        message: withDefaultHint(strings.mem0LlmProvider, strings.choices.mem0LlmDeepseek, strings),
        options: [
          { value: 'deepseek', label: strings.choices.mem0LlmDeepseek },
          { value: 'gemini', label: strings.choices.mem0LlmGemini },
          { value: 'openai', label: strings.choices.mem0LlmOpenAI },
          { value: 'ollama', label: strings.choices.mem0LlmOllama },
        ],
        initialValue: mem0LlmProvider,
      });
      if (isCancel(mem0LlmProvider)) process.exit(1);

      const llmBaseUrlDefault = mem0LlmProvider === 'deepseek'
        ? 'https://api.deepseek.com'
        : mem0LlmProvider === 'gemini'
          ? ''
          : mem0LlmProvider === 'ollama'
            ? 'http://127.0.0.1:11434'
            : 'https://api.openai.com/v1';
      const llmModelDefault = mem0LlmProvider === 'deepseek'
        ? 'deepseek-chat'
        : mem0LlmProvider === 'gemini'
          ? 'gemini-2.0-flash'
          : mem0LlmProvider === 'ollama'
            ? 'llama3.1:70b'
            : 'gpt-4.1-nano-2025-04-14';

      const llmBaseUrl = await text({
        message: withDefaultHint(strings.mem0LlmBaseUrl, llmBaseUrlDefault, strings),
        defaultValue: mem0LlmBaseUrl || llmBaseUrlDefault,
        placeholder: mem0LlmBaseUrl || llmBaseUrlDefault,
      });
      if (isCancel(llmBaseUrl)) process.exit(1);
      mem0LlmBaseUrl = resolveTextPromptValue(llmBaseUrl, mem0LlmBaseUrl || llmBaseUrlDefault);

      const llmApiKey = await text({
        message: withDefaultHint(strings.mem0LlmApiKey, '', strings),
        defaultValue: mem0LlmApiKey,
        placeholder: mem0LlmApiKey,
      });
      if (isCancel(llmApiKey)) process.exit(1);
      mem0LlmApiKey = resolveTextPromptValue(llmApiKey, mem0LlmApiKey);

      const llmModel = await text({
        message: withDefaultHint(strings.mem0LlmModel, llmModelDefault, strings),
        defaultValue: mem0LlmModel || llmModelDefault,
        placeholder: llmModelDefault,
      });
      if (isCancel(llmModel)) process.exit(1);
      mem0LlmModel = resolveTextPromptValue(llmModel, mem0LlmModel || llmModelDefault);
    } else if (mem0Mode === 'remote') {
      const currentRemoteUrl = existingMem0.mode === 'remote' ? existingMem0.baseUrl || 'https://api.mem0.ai' : 'https://api.mem0.ai';
      mem0BaseUrl = currentRemoteUrl;

      const currentApiKey = existingMem0.mode === 'remote' ? existingMem0.apiKey || '' : '';
      const value = await text({
        message: withDefaultHint(strings.mem0ApiKey, '', strings),
        defaultValue: currentApiKey,
        placeholder: currentApiKey,
      });
      if (isCancel(value)) process.exit(1);
      mem0ApiKey = resolveTextPromptValue(value, currentApiKey);
    } else {
      mem0BaseUrl = '';
      mem0ApiKey = '';
    }

    autoCaptureScope = await select({
      message: withDefaultHint(strings.autoCaptureScope, strings.choices.captureLongTerm, strings),
      options: [
        { value: 'long-term', label: strings.choices.captureLongTerm },
        { value: 'session', label: strings.choices.captureSession },
      ],
      initialValue: autoCaptureScope,
    });
    if (isCancel(autoCaptureScope)) process.exit(1);
    autoCaptureRequireReply = await confirm({
      message: withDefaultHint(strings.autoCaptureRequireReply, 'true', strings),
      initialValue: autoCaptureRequireReply,
    });
    if (isCancel(autoCaptureRequireReply)) process.exit(1);
    const currentAutoCaptureMaxChars = String(autoCaptureMaxChars);
    autoCaptureMaxChars = resolveNumericPromptValue(await text({
      message: withDefaultHint(strings.autoCaptureMaxChars, '2000', strings),
      defaultValue: currentAutoCaptureMaxChars,
      placeholder: '2000',
    }), currentAutoCaptureMaxChars);
  } else {
    mem0Mode = 'disabled';
    mem0BaseUrl = '';
    mem0ApiKey = '';
  }

  const debugChoice = await select({
    message: withDefaultHint(strings.debugMode, strings.choices.debug, strings),
    options: [
      { value: 'debug', label: strings.choices.debug },
      { value: 'off', label: strings.choices.debugOff },
    ],
    initialValue: existingDebug.mode || 'debug',
  });
  if (isCancel(debugChoice)) process.exit(1);
  let debugLogDir = existingDebug.logDir;

  return {
    lancedbPath: path.join(memoryRoot, 'lancedb'),
    mem0: {
      mode: mem0Mode,
      baseUrl: mem0BaseUrl,
      apiKey: mem0ApiKey,
      llm: {
        provider: mem0LlmProvider,
        baseUrl: mem0LlmBaseUrl,
        apiKey: mem0LlmApiKey,
        model: mem0LlmModel,
      },
    },
    outboxDbPath: path.join(memoryRoot, 'outbox.json'),
    auditStorePath: path.join(memoryRoot, 'audit', 'memory_records.jsonl'),
    debug: {
      mode: debugChoice,
      ...(debugLogDir ? { logDir: debugLogDir } : {}),
    },
    autoRecall: {
      enabled: autoRecallEnabled,
      topK: resolvedAutoRecallTopK,
      maxChars: resolvedAutoRecallMaxChars,
      scope: autoRecallScope,
      reranker: {
        provider: autoRecallRerankerProvider,
        baseUrl: autoRecallRerankerBaseUrl,
        apiKey: autoRecallRerankerProvider === 'voyage' ? autoRecallRerankerApiKey : '',
        model: autoRecallRerankerModel,
      },
    },
    autoCapture: {
      enabled: autoCaptureEnabled,
      scope: autoCaptureScope,
      requireAssistantReply: autoCaptureRequireReply,
      maxCharsPerMessage: autoCaptureMaxChars,
    },
  };
}

export function getExistingPluginConfig(openclawConfig) {
  return openclawConfig?.plugins?.entries?.[PLUGIN_NAME]?.config || {};
}

export function withDefaultHint(message, defaultValue, strings) {
  const prefix = isChineseStrings(strings) ? '默认' : 'default';
  return `${message} ${styleText('dim', `(${prefix}: ${defaultValue})`)}`;
}

export function resolveTextPromptValue(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function resolveNumericPromptValue(value, fallback) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return Number(fallback);
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number(fallback);
}

function isChineseStrings(strings) {
  return typeof strings?.intro === 'string' && /安装器/.test(strings.intro);
}

function isDirectRun() {
  const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return scriptPath === path.resolve(new URL(import.meta.url).pathname);
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
