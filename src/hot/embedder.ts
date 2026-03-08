import { embed } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingConfig } from '../types';

export const FAKE_EMBEDDING_DIM = 16;

export async function embedText(text: string, cfg?: EmbeddingConfig): Promise<number[]> {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return new Array<number>(cfg?.dimension || FAKE_EMBEDDING_DIM).fill(0);
  }

  if (!cfg || cfg.provider === 'fake') {
    return fakeEmbedText(normalized);
  }

  const model = resolveModel(cfg);
  try {
    const { embedding } = await embed({ model, value: normalized });
    return embedding;
  } catch (err) {
    console.error(`[embedder] Failed to fetch ${cfg.provider} embedding:`, err);
    throw err;
  }
}

function resolveModel(cfg: EmbeddingConfig) {
  switch (cfg.provider) {
    case 'gemini': {
      const google = createGoogleGenerativeAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1',
      });
      const geminiModelId = (cfg.model || 'text-embedding-004').replace(/^models\//, '');
      return google.embeddingModel(geminiModelId);
    }
    case 'openai': {
      const openai = createOpenAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseUrl || undefined,
      });
      return openai.embeddingModel(cfg.model || 'text-embedding-3-small');
    }
    case 'ollama': {
      if (!cfg.baseUrl) {
        throw new Error('[embedder] ollama provider requires a non-empty baseUrl');
      }
      const ollama = createOpenAI({
        apiKey: 'ollama',
        baseURL: cfg.baseUrl.replace(/\/$/, '') + '/v1',
      });
      return ollama.embeddingModel(cfg.model || 'nomic-embed-text');
    }
    default:
      throw new Error(`Unknown embedding provider: ${(cfg as any).provider}`);
  }
}

function fakeEmbedText(normalized: string): number[] {
  const normLower = normalized.toLowerCase();
  const vector = new Array<number>(FAKE_EMBEDDING_DIM).fill(0);

  for (let index = 0; index < normLower.length; index += 1) {
    const code = normLower.charCodeAt(index);
    vector[index % FAKE_EMBEDDING_DIM] += code;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }

  return vector.map((value) => value / norm);
}
