# Vercel AI SDK Embedder Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace hand-written `fetch*Embedding` functions in `src/hot/embedder.ts` with Vercel AI SDK provider adapters, eliminating URL construction bugs like the `v1beta` Gemini issue.

**Architecture:** Add `ai`, `@ai-sdk/google`, `@ai-sdk/openai` as dependencies. Rewrite only `src/hot/embedder.ts` — `fake` path stays untouched, the three live providers delegate to `embed()` from the SDK. Public interface (`embedText` signature, `EmbeddingConfig` type) does not change.

**Tech Stack:** Node.js, TypeScript, `ai` (Vercel AI SDK), `@ai-sdk/google`, `@ai-sdk/openai`

---

### Task 1: Install dependencies

**Files:**
- Modify: `package.json` (via npm)

**Step 1: Install the three packages**

***REMOVED***bash
npm install ai @ai-sdk/google @ai-sdk/openai
***REMOVED***

**Step 2: Verify they appear in package.json**

***REMOVED***bash
node -e "const p = require('./package.json'); console.log(Object.keys(p.dependencies).join('\n'))"
***REMOVED***

Expected output includes: `ai`, `@ai-sdk/google`, `@ai-sdk/openai`, `@lancedb/lancedb`

**Step 3: Verify TypeScript types are available**

***REMOVED***bash
node -e "require('@ai-sdk/google'); require('@ai-sdk/openai'); require('ai'); console.log('ok')"
***REMOVED***

Expected: `ok`

---

### Task 2: Add failing test for unknown provider

**Files:**
- Modify: `tests/hot/embedder.test.ts`

**Step 1: Add test at the end of the file**

Append to `tests/hot/embedder.test.ts`:

***REMOVED***typescript
test('embedText throws for unknown provider', async () => {
  const cfg = {
    provider: 'unknown' as any,
    baseUrl: '',
    apiKey: '',
    model: '',
    dimension: 16,
  };

  await assert.rejects(
    () => embedText('hello', cfg),
    /Unknown embedding provider/,
  );
});
***REMOVED***

**Step 2: Build and run this test to confirm it fails**

***REMOVED***bash
npm run build 2>&1 | tail -3 && node --test dist/src/tests/hot/embedder.test.js 2>&1 | tail -10
***REMOVED***

Expected: test `embedText throws for unknown provider` fails (current code falls through to `fakeEmbedText` instead of throwing).

---

### Task 3: Rewrite embedder.ts

**Files:**
- Modify: `src/hot/embedder.ts`

**Step 1: Replace the entire file contents**

***REMOVED***typescript
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
        baseURL: cfg.baseUrl || undefined,
      });
      return google.textEmbeddingModel(cfg.model || 'text-embedding-004');
    }
    case 'openai': {
      const openai = createOpenAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseUrl || undefined,
      });
      return openai.textEmbeddingModel(cfg.model || 'text-embedding-3-small');
    }
    case 'ollama': {
      const ollama = createOpenAI({
        apiKey: 'ollama',
        baseURL: cfg.baseUrl.replace(/\/$/, '') + '/v1',
      });
      return ollama.textEmbeddingModel(cfg.model || 'nomic-embed-text');
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
***REMOVED***

**Step 2: Build**

***REMOVED***bash
npm run build 2>&1
***REMOVED***

Expected: no errors.

---

### Task 4: Run all tests

**Step 1: Run full test suite**

***REMOVED***bash
npm test 2>&1
***REMOVED***

Expected: all 56 tests pass (55 existing + 1 new unknown-provider test). Specifically check:

***REMOVED***
✔ embedText is stable for identical input
✔ embedText returns fixed-dimension vectors
✔ embedText does not collapse all inputs to the same vector
✔ embedText throws for unknown provider
***REMOVED***

**Step 2: If any test fails, stop and diagnose before continuing**

---

### Task 5: Commit

**Step 1: Stage changed files**

***REMOVED***bash
git add src/hot/embedder.ts tests/hot/embedder.test.ts package.json package-lock.json
***REMOVED***

**Step 2: Commit**

***REMOVED***bash
git commit -m "$(cat <<'EOF'
feat: replace hand-written embedder with Vercel AI SDK adapters

Eliminates URL construction bugs (e.g. v1beta vs v1) by delegating
to ai/sdk for Gemini, OpenAI, and Ollama (via openai-compat).
Public embedText interface and EmbeddingConfig type unchanged.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
***REMOVED***

**Step 3: Verify**

***REMOVED***bash
git log --oneline -3
***REMOVED***
