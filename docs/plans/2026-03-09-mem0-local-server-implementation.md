# Mem0 Local Server Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate a local Mem0 server via Python virtual environment (uv) and NPM scripts to support local development and debugging.

**Architecture:** Create a minimal FastAPI wrapper (`scripts/mem0_server.py`) around the `mem0ai` library to expose the necessary API endpoints. Manage the Python virtual environment and dependencies using `uv` wrapped in `npm run` scripts.

**Tech Stack:** Python, `uv`, FastAPI, Uvicorn, `mem0ai[local]`, Node.js (npm scripts)

---

### Task 1: Create the FastAPI Wrapper for Mem0

**Files:**
- Create: `scripts/mem0_server.py`
- Modify: `.gitignore`

**Step 1: Write the implementation**

***REMOVED***python
import os
from typing import Any, Dict

from fastapi import FastAPI, HTTPException
from mem0 import Memory
from pydantic import BaseModel

app = FastAPI(title="Mem0 Local Server")

# Initialize Mem0 with local configuration
try:
    memory = Memory.from_config({
        "vector_store": {"provider": "lancedb", "config": {"db_uri": "./.mem0_local_db"}},
    })
except Exception as e:
    print(f"Warning: Failed to initialize Mem0. Error: {e}")
    memory = None

class MemoryStoreRequest(BaseModel):
    messages: list[Dict[str, Any]]
    user_id: str | None = None
    agent_id: str | None = None
    run_id: str | None = None
    metadata: Dict[str, Any] | None = None
    filters: Dict[str, Any] | None = None

class MemorySearchRequest(BaseModel):
    query: str
    user_id: str | None = None
    agent_id: str | None = None
    run_id: str | None = None
    limit: int = 100
    filters: Dict[str, Any] | None = None

@app.get("/v1/health")
def health_check():
    if memory is None:
        raise HTTPException(status_code=500, detail="Mem0 initialization failed")
    return {"status": "ok"}

@app.post("/v1/memories/")
def store_memory(request: MemoryStoreRequest):
    if memory is None:
        raise HTTPException(status_code=500, detail="Mem0 initialization failed")
    try:
        result = memory.add(
            messages=request.messages,
            user_id=request.user_id,
            agent_id=request.agent_id,
            run_id=request.run_id,
            metadata=request.metadata,
            filters=request.filters,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/v1/memories/search/")
def search_memories(request: MemorySearchRequest):
    if memory is None:
        raise HTTPException(status_code=500, detail="Mem0 initialization failed")
    try:
        result = memory.search(
            query=request.query,
            user_id=request.user_id,
            agent_id=request.agent_id,
            run_id=request.run_id,
            limit=request.limit,
            filters=request.filters,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
***REMOVED***

**Step 2: Update `.gitignore`**

Ensure `.venv` and `.mem0_local_db` are ignored.

***REMOVED***bash
echo -e "\n# Mem0 Local Server" >> .gitignore
echo ".venv/" >> .gitignore
echo ".mem0_local_db/" >> .gitignore
***REMOVED***

**Step 3: Commit**

***REMOVED***bash
git add scripts/mem0_server.py .gitignore
git commit -m "feat(scripts): add fastAPI wrapper for local mem0 server"
***REMOVED***

---

### Task 2: Add NPM Scripts

**Files:**
- Modify: `package.json`

**Step 1: Write the implementation**

Update `package.json` to include the following scripts within the `"scripts"` object:

***REMOVED***
    "mem0:setup": "uv venv && uv pip install mem0ai[local] fastapi uvicorn pydantic",
    "mem0:start": "uv run uvicorn scripts.mem0_server:app --reload --port 8000"
***REMOVED***

**Step 2: Commit**

***REMOVED***bash
git add package.json
git commit -m "feat(package): add mem0 setup and start scripts"
***REMOVED***

---

### Task 3: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Step 1: Write the implementation**

Add the following section to `README.md` (and the translated equivalent to `README.zh-CN.md`) under a new "Local Mem0 Server Development" heading:

***REMOVED***markdown
## Local Mem0 Server Development

For local development and testing, you can spin up a local instance of the Mem0 API. This is highly recommended to easily debug the interaction between the plugin and the Mem0 control plane.

1.  **Prerequisites**: Ensure you have `uv` installed (`pip install uv` or via your system package manager).
2.  **Setup Environment**: Run `npm run mem0:setup` to create a virtual environment and install dependencies.
3.  **Start Server**: Run `npm run mem0:start` to start the server on `http://127.0.0.1:8000`.

The plugin will automatically communicate with this server if `mem0BaseUrl` is set to `http://127.0.0.1:8000` and `mem0Mode` is `local`.
***REMOVED***

**Step 2: Commit**

***REMOVED***bash
git add README.md README.zh-CN.md
git commit -m "docs: add local mem0 server development guide"
***REMOVED***