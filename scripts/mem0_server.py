import json
import os
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Mem0 Local Server")

DEFAULT_LOCAL_DB_PATH = "./.mem0_local_db"
DEFAULT_MEM0_RUNTIME_DIR = str(Path("./.mem0_runtime").resolve())
DEFAULT_OPENCLAW_CONFIG_PATH = os.path.join("~", ".openclaw", "openclaw.json")

os.environ.setdefault("MEM0_DIR", DEFAULT_MEM0_RUNTIME_DIR)

from mem0 import Memory


def load_openclaw_config() -> Dict[str, Any]:
    config_path = Path(os.path.expanduser(DEFAULT_OPENCLAW_CONFIG_PATH))
    if not config_path.exists():
        return {}

    try:
        return json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"Warning: Failed to read OpenClaw config at {config_path}. Error: {e}")
        return {}


def get_env_override(name: str, fallback: str = "") -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        return fallback
    return value


def build_mem0_config() -> Dict[str, Any]:
    openclaw_config = load_openclaw_config()
    memory_search = openclaw_config.get("agents", {}).get("defaults", {}).get("memorySearch", {})

    provider = get_env_override("MEM0_EMBEDDING_PROVIDER", memory_search.get("provider") or "openai")
    if provider == "fake":
        raise ValueError("fake embedding is not supported for local mem0 server")
    if provider not in {"openai", "gemini", "ollama"}:
        raise ValueError(f"unsupported local mem0 embedding provider: {provider}")
    remote = memory_search.get("remote", {}) or {}
    api_key = get_env_override("MEM0_EMBEDDING_API_KEY", remote.get("apiKey") or "")
    model = get_env_override("MEM0_EMBEDDING_MODEL", memory_search.get("model") or "")
    dimension = 1536
    local_db_path = get_env_override("MEM0_VECTOR_DB_PATH", DEFAULT_LOCAL_DB_PATH)
    runtime_dir = get_env_override("MEM0_RUNTIME_DIR", DEFAULT_MEM0_RUNTIME_DIR)

    embedder_config: Dict[str, Any] = {
        "api_key": api_key,
    }
    llm_config: Dict[str, Any] = {
        "api_key": api_key,
    }

    if provider == "gemini":
        embedder_config["model"] = model or "models/gemini-embedding-001"
        embedder_config["embedding_dims"] = 3072
        llm_config["model"] = get_env_override("MEM0_LLM_MODEL", "gemini-2.0-flash")
        dimension = 3072
    elif provider == "ollama":
        base_url = get_env_override("MEM0_EMBEDDING_BASE_URL", remote.get("baseUrl") or "http://127.0.0.1:11434")
        embedder_config["model"] = model or "nomic-embed-text"
        embedder_config["ollama_base_url"] = base_url
        llm_config["model"] = get_env_override("MEM0_LLM_MODEL", "llama3.1:70b")
        llm_config["ollama_base_url"] = base_url
        llm_config["api_key"] = api_key or "ollama"
        dimension = 768
    else:
        base_url = get_env_override("MEM0_EMBEDDING_BASE_URL", remote.get("baseUrl") or "https://api.openai.com/v1")
        embedder_config["model"] = model or "text-embedding-3-small"
        embedder_config["openai_base_url"] = base_url
        llm_config["model"] = get_env_override("MEM0_LLM_MODEL", "gpt-4.1-nano-2025-04-14")
        llm_config["openai_base_url"] = base_url
        dimension = 1536

    return {
        "history_db_path": str(Path(runtime_dir) / "history.db"),
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "path": local_db_path,
                "collection_name": "mem0",
                "embedding_model_dims": dimension,
            },
        },
        "embedder": {
            "provider": provider,
            "config": embedder_config,
        },
        "llm": {
            "provider": provider,
            "config": llm_config,
        },
    }


def initialize_memory():
    try:
        return Memory.from_config(build_mem0_config())
    except Exception as e:
        print(f"Warning: Failed to initialize Mem0. Error: {e}")
        return None


memory = initialize_memory()

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
