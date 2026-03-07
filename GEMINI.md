# Project Overview

**Name:** openclaw-mem0-lancedb
**Type:** OpenClaw Memory Plugin

This project is an OpenClaw memory plugin that leverages **Mem0** as the control plane and **LanceDB** as the retrieval layer (hot plane). It provides a structured, multi-tiered architecture for agent memory management.

## Architecture
The system is built on a three-plane architecture:
1.  **Audit Plane:** A file-first append-only audit log (JSONL) representing the ultimate source of truth for humans.
2.  **Control Plane:** Manages Mem0 client state and synchronization.
3.  **Hot Plane:** Uses LanceDB for high-performance Full-Text Search (FTS), vector search, and hybrid Reciprocal Rank Fusion (RRF) retrieval.

### Data Flow
-   **Write Path:** Agent -> `memoryStore` tool -> Audit Plane -> Outbox / Sync-Engine -> Mem0 (Control Plane) + LanceDB (Hot Plane). Write statuses include `synced`, `partial`, and `failed`.
-   **Read Path:** Agent -> `memory_search` / `memorySearch` tools -> LanceDB (FTS + vector + hybrid RRF) -> Mem0 (fallback).
-   **Auto Recall:** Can be enabled to inject relevant memories before a turn, utilizing the host's hook API.

### Core Tools
-   `memory_search` / `memorySearch`: Primary search APIs against LanceDB (with Mem0 fallback).
-   `memory_get`: Reads specific snippets from memory source paths.
-   `memoryStore`: Stores new memory records and handles synchronization.

## Building and Running

The project is built with **TypeScript** and uses the native **Node.js test runner**.

-   **Install Dependencies:**
    ***REMOVED***bash
    npm install
    ***REMOVED***
-   **Build the Plugin:**
    ***REMOVED***bash
    npm run build
    ***REMOVED***
-   **Development Mode (Watch):**
    ***REMOVED***bash
    npm run dev
    ***REMOVED***
-   **Run Tests:**
    ***REMOVED***bash
    npm test
    ***REMOVED***
-   **Install Plugin Locally:**
    ***REMOVED***bash
    npm run install-plugin
    # Or directly: bash scripts/install.sh
    ***REMOVED***

## Development Conventions

-   **Language:** The codebase is strongly typed using **TypeScript**.
-   **Testing:** Uses the native Node.js test runner (`node --test`). Test files are co-located alongside source files (e.g., `*.test.ts`). Ensure all new features or bug fixes include corresponding tests.
-   **Schema:** The canonical schema for memory records is defined in `src/schema/memory_record.schema.json`.
-   **Integration:** Designed to be consumed by OpenClaw. Configuration is handled via the host's `openclaw.json` (specifying Mem0 API keys, LanceDB paths, outbox paths, etc.).
