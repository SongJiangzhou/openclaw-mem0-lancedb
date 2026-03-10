import type { AutoRecallConfig, SearchResult } from '../types';
import { summarizeText, type PluginDebugLogger } from '../debug/logger';

export function buildAutoRecallBlock(memories: SearchResult['memories'], config: AutoRecallConfig, source?: string): string {
  if (!memories.length) {
    return '';
  }

  const sourceAttr = source ? ` source="${source}"` : '';
  const header = `<recall${sourceAttr}>\n`;
  const footer = `\n</recall>`;
  const maxChars = Math.max(0, config.maxChars);
  const budget = Math.max(0, maxChars - header.length - footer.length);
  const lines: string[] = [];

  for (const memory of memories.slice(0, config.topK)) {
    const candidateLine = `- [${memory.scope}] ${memory.text}`;
    const separator = lines.length > 0 ? 1 : 0;
    const nextLength = lines.join('\n').length + separator + candidateLine.length;

    if (nextLength <= budget) {
      lines.push(candidateLine);
      continue;
    }

    if (lines.length > 0) {
      break;
    }

    const truncated = truncateRecallLine(candidateLine, budget);
    if (truncated) {
      lines.push(truncated);
    }
    break;
  }

  if (lines.length === 0) {
    return `${header.trimEnd()}</recall>`;
  }

  return `${header}${lines.join('\n')}${footer}`;
}

function truncateRecallLine(line: string, budget: number): string {
  if (budget <= 0) {
    return '';
  }
  if (line.length <= budget) {
    return line;
  }
  if (budget <= 3) {
    return '.'.repeat(budget);
  }
  return `${line.slice(0, budget - 3)}...`;
}

export async function runAutoRecall(params: {
  query: string;
  userId: string;
  config: AutoRecallConfig;
  debug?: PluginDebugLogger;
  search: (input: { query: string; userId: string; topK: number; filters?: { scope?: string } }) => Promise<SearchResult>;
}): Promise<{ block: string; source: string }> {
  if (!params.config.enabled) {
    params.debug?.basic('auto_recall.skipped', { reason: 'disabled' });
    return { block: '', source: 'none' };
  }

  params.debug?.basic('auto_recall.start', {
    userId: params.userId,
    topK: params.config.topK,
    scope: params.config.scope,
    ...summarizeText(params.query),
  });

  const result = await params.search({
    query: params.query,
    userId: params.userId,
    topK: params.config.topK,
    filters: params.config.scope === 'long-term' ? { scope: 'long-term' } : undefined,
  });

  if (!result.memories.length) {
    params.debug?.basic('auto_recall.empty', { source: result.source });
    return { block: '', source: result.source };
  }

  const block = buildAutoRecallBlock(result.memories, params.config, result.source);
  params.debug?.basic('auto_recall.done', {
    source: result.source,
    hits: result.memories.length,
    injectedChars: block.length,
  });
  result.memories.forEach((memory) => {
    params.debug?.verbose('auto_recall.memory', {
      memoryUid: memory.memory_uid,
      scope: memory.scope,
      ...summarizeText(memory.text),
    });
  });
  return { block, source: result.source };
}
