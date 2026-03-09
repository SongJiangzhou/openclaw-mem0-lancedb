# Mem0 + LanceDB OpenClaw Memory Plugin

[中文说明](./README.zh-CN.md)

An OpenClaw memory plugin that uses Mem0 as the control plane and LanceDB as the retrieval layer.

Current embedded architecture:

- `audit plane`: file-first audit log under `auditStorePath`
- `control plane`: Mem0 client and sync state
- `hot plane`: LanceDB FTS + vector + hybrid RRF retrieval
- Canonical schema: `src/schema/memory_record.schema.json`

## Installation

***REMOVED***bash
cd plugins/openclaw-mem0-lancedb
bash scripts/install.sh
***REMOVED***

## Configuration

Add the plugin entry to `openclaw.json`:

***REMOVED***
{
  "plugins": {
    "slots": {
      "memory": "openclaw-mem0-lancedb"
    },
    "entries": {
      "openclaw-mem0-lancedb": {
        "enabled": true,
        "config": {
          "mem0": {
            "mode": "local",
            "baseUrl": "http://127.0.0.1:8000",
            "apiKey": ""
          },
          "lancedbPath": "~/.openclaw/workspace/data/memory/lancedb",
          "outboxDbPath": "~/.openclaw/workspace/data/memory/outbox.json",
          "auditStorePath": "~/.openclaw/workspace/data/memory/audit/memory_records.jsonl",
          "autoRecall": {
            "enabled": false,
            "topK": 5,
            "maxChars": 800,
            "scope": "all"
          }
        }
      }
    }
  }
}
***REMOVED***

`mem0.mode` is the authoritative switch:

- `local`: no API key required
- `remote`: API key required
- `disabled`: Mem0 requests are disabled

`mem0.baseUrl` only controls the request target. It no longer determines whether the plugin treats Mem0 as local or remote.

## Tools

### `memory_search`

Primary memory-slot search tool backed by LanceDB, with optional Mem0 fallback.

***REMOVED***
{
  "query": "diet preference",
  "userId": "user_123",
  "topK": 5,
  "filters": {
    "scope": "long-term",
    "categories": ["preference"]
  }
}
***REMOVED***

### `memory_get`

Reads a snippet from a workspace-relative memory source path.

***REMOVED***
{
  "path": "MEMORY.md",
  "from": 1,
  "lines": 20
}
***REMOVED***

### `memorySearch`

Custom hybrid search API exposed by the plugin.

***REMOVED***
{
  "query": "diet preference",
  "userId": "user_123",
  "topK": 5,
  "filters": {
    "scope": "long-term",
    "categories": ["preference"]
  }
}
***REMOVED***

### `memoryStore`

Stores a memory record and syncs it to LanceDB, optionally via Mem0.

***REMOVED***
{
  "text": "The user likes science fiction movies.",
  "userId": "user_123",
  "scope": "long-term",
  "categories": ["preference", "entertainment"]
}
***REMOVED***

## Architecture

1. Write path: Agent -> `memoryStore` -> audit plane -> outbox / sync-engine -> Mem0 control plane + LanceDB hot plane
2. Read path: Agent -> `memory_search` / `memorySearch` -> LanceDB hot plane (FTS + vector + hybrid RRF) first -> Mem0 fallback
3. Retrieval source of truth for humans: audit records stored through the file-first plane

Current write status semantics:

- `synced`: Mem0 event confirmed and LanceDB visible
- `partial`: local write succeeded but Mem0 was unavailable or unconfirmed
- `failed`: audit or LanceDB primary path failed

Auto recall:

- disabled by default
- when enabled and the host exposes a compatible hook API, the plugin injects a formatted `<relevant_memories>` block before the turn
- retrieval source is the current hot plane with Mem0 fallback

Auto capture:

- disabled by default
- when enabled and the host exposes a compatible end-of-turn hook, the plugin submits the latest `user + assistant` turn to Mem0
- capture uses a deterministic idempotency key per turn
- after Mem0 confirms the capture event, extracted memories are synced back into the local audit plane and LanceDB hot plane

## Local Mem0 Server Development

For local development and testing, you can spin up a local instance of the Mem0 API. This is highly recommended to easily debug the interaction between the plugin and the Mem0 control plane.

1.  **Prerequisites**: Ensure you have `uv` installed (`pip install uv` or via your system package manager).
2.  **Setup Environment**: Run `npm run mem0:setup` to create a virtual environment and install dependencies, including `google-genai` for Gemini-backed local Mem0.
3.  **Start Server**: Run `npm run mem0:start` to start the server on `http://127.0.0.1:8000`.

The local server reads `~/.openclaw/openclaw.json` and reuses `agents.defaults.memorySearch` for provider, API key, model, and base URL. Environment variables can override this when debugging.

## Development

***REMOVED***bash
npm install
npm run dev
npm run build
npm test
***REMOVED***
