import type { MemoryDomain, MemorySourceKind, MemoryType } from '../types';

export type QueryIntent = 'preference' | 'profile' | 'credential' | 'recency' | 'generic';

export interface MemoryAnnotations {
  memoryType: MemoryType;
  domains: MemoryDomain[];
  sourceKind: MemorySourceKind;
  confidence: number;
}

export function inferMemoryAnnotations(params: {
  text: string;
  categories?: string[];
  sourceKind?: MemorySourceKind;
  confidence?: number;
}): MemoryAnnotations {
  const text = normalizeText(params.text);
  const categories = normalizeList(params.categories);
  const memoryType = inferMemoryType(text, categories);
  const domains = inferMemoryDomains(text, categories);

  return {
    memoryType,
    domains,
    sourceKind: params.sourceKind || inferSourceKind(memoryType),
    confidence: clampConfidence(params.confidence ?? inferConfidence(memoryType)),
  };
}

export function classifyQueryIntent(query: string): QueryIntent {
  const normalized = normalizeText(query);
  if (looksLikeCredentialQuery(normalized)) {
    return 'credential';
  }
  if (/最近|刚刚|最新|today|yesterday|recent|latest/.test(normalized)) {
    return 'recency';
  }
  if (/喜欢|偏好|爱好|哪类|what kind|which kind|like|prefer|favorite/.test(normalized)) {
    return 'preference';
  }
  if (/我是谁|我在哪|我住哪|我在哪上班|我做什么|who am i|where do i|what do i do/.test(normalized)) {
    return 'profile';
  }
  return 'generic';
}

export function classifyQueryDomain(query: string): MemoryDomain {
  const normalized = normalizeText(query);
  if (/游戏|game|games|nintendo|mario|zelda/.test(normalized)) {
    return 'game';
  }
  if (/吃|食物|餐厅|food|eat|drink|restaurant/.test(normalized)) {
    return 'food';
  }
  if (/工作|上班|公司|职业|work|job|company|office/.test(normalized)) {
    return 'work';
  }
  if (/出差|旅行|旅游|travel|trip/.test(normalized)) {
    return 'travel';
  }
  if (/插件|检索|记忆|mem0|lancedb|plugin|recall|capture|search/.test(normalized)) {
    return 'tooling';
  }
  return 'generic';
}

export function looksLikeCredentialQuery(query: string): boolean {
  return /口令|密码|token|passcode|验证码|code|密钥|secret|api key/.test(normalizeText(query));
}

function inferMemoryType(text: string, categories: string[]): MemoryType {
  if (categories.includes('preference') || /user likes|user prefers|用户.*喜欢|用户.*偏好/.test(text)) {
    return 'preference';
  }
  if (categories.includes('profile') || /user works at|user lives in|用户.*在.*上班|用户.*住在/.test(text)) {
    return 'profile';
  }
  if (categories.includes('token') || categories.includes('credential') || /\b(token|password|passcode|secret|api key)\b/.test(text)) {
    return 'credential';
  }
  if (categories.includes('metadata') || /sender \(untrusted metadata\)|gateway-client|client metadata/.test(text)) {
    return 'metadata';
  }
  if (categories.includes('system') || categories.includes('debug') || /\b(plugin|poller|capture|recall|debug|sync)\b/.test(text)) {
    return 'system';
  }
  if (categories.includes('experience') || /traveled|出差|旅行|visited/.test(text)) {
    return 'experience';
  }
  if (categories.includes('task') || categories.includes('task_context')) {
    return 'task_context';
  }
  return 'generic';
}

function inferMemoryDomains(text: string, categories: string[]): MemoryDomain[] {
  const domains: MemoryDomain[] = [];
  if (categories.includes('game') || /game|games|nintendo|mario|zelda|游戏/.test(text)) {
    domains.push('game');
  }
  if (categories.includes('food') || /food|eat|drink|restaurant|吃|餐厅/.test(text)) {
    domains.push('food');
  }
  if (categories.includes('work') || /work|job|company|office|上班|工作|公司/.test(text)) {
    domains.push('work');
  }
  if (categories.includes('travel') || /travel|trip|出差|旅行/.test(text)) {
    domains.push('travel');
  }
  if (categories.includes('tooling') || /mem0|lancedb|plugin|tool|recall|capture/.test(text)) {
    domains.push('tooling');
  }
  if (domains.length === 0) {
    domains.push('generic');
  }
  return domains;
}

function inferSourceKind(memoryType: MemoryType): MemorySourceKind {
  if (memoryType === 'metadata' || memoryType === 'system') {
    return 'system_generated';
  }
  return 'user_explicit';
}

function inferConfidence(memoryType: MemoryType): number {
  switch (memoryType) {
    case 'preference':
    case 'profile':
      return 0.9;
    case 'credential':
      return 0.95;
    case 'metadata':
    case 'system':
      return 0.4;
    default:
      return 0.7;
  }
}

function normalizeText(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeList(values?: string[]): string[] {
  return Array.isArray(values) ? values.map((item) => normalizeText(item)) : [];
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.7;
  return Math.max(0, Math.min(1, value));
}
