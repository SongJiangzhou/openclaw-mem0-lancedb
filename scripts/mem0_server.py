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
