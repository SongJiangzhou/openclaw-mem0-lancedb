# Mem0 + LanceDB OpenClaw Memory Plugin

[中文说明](./README.zh-CN.md)

An OpenClaw memory plugin that uses Mem0 as the control plane and LanceDB as the retrieval layer.

Current embedded architecture:

- `audit plane`: file-first audit log under `auditStorePath`
- `control plane`: Mem0 client and sync state
- `hot plane`: LanceDB search index
- Canonical schema: `src/schema/memory_record.schema.json`

## Installation

***REMOVED***bash
cd plugins/memory-mem0-lancedb
bash scripts/install.sh
***REMOVED***

## Configuration

Add the plugin entry to `openclaw.json`:

***REMOVED***
{
  "plugins": {
    "slots": {
      "memory": "memory-mem0-lancedb"
    },
    "entries": {
      "memory-mem0-lancedb": {
        "enabled": true,
        "config": {
          "mem0ApiKey": "your-mem0-api-key (optional; leave empty for local-only mode)",
          "mem0BaseUrl": "https://api.mem0.ai",
          "lancedbPath": "~/.openclaw/workspace/data/memory_lancedb",
          "outboxDbPath": "~/.openclaw/workspace/data/outbox.json",
          "auditStorePath": "~/.openclaw/workspace/data/memory_audit/memory_records.jsonl"
        }
      }
    }
  }
}
***REMOVED***

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
2. Read path: Agent -> `memory_search` / `memorySearch` -> LanceDB hot plane first -> Mem0 fallback
3. Retrieval source of truth for humans: audit records stored through the file-first plane

## Development

***REMOVED***bash
npm install
npm run dev
npm run build
npm test
***REMOVED***
