# Local Mem0 Server Integration Design (2026-03-09)

## Overview
This document outlines the design for integrating a local Mem0 server into the development workflow of the `openclaw-mem0-lancedb` plugin. This addresses the lack of auto-start capabilities for the Mem0 service when running the plugin in local mode, opting for a clear separation of concerns where the plugin remains a client, and the server is managed externally via npm scripts.

## Context
The plugin acts as a client to the Mem0 API (Control Plane). When configured with `mem0BaseUrl` pointing to `localhost`, the plugin expects the server to be running. Previously, there was no standardized way for developers to spin up this local server, leading to confusion when auto-capture and other features failed due to the server being unreachable.

## Architecture & Approach
We will use a **Native Python (`uv` venv) + NPM Scripts Wrapper** approach.
This provides the best balance of speed, debugging capability (crucial for local development), and seamless integration into the existing Node.js developer workflow.

### 1. Dependency Management (`uv`)
- **Tooling**: We will utilize `uv` for extremely fast Python virtual environment creation and package installation.
- **Environment**: A `.venv` directory will be created at the project root (and gitignored).
- **Packages**: We will install `mem0ai[local]`, `fastapi`, and `uvicorn`.

### 2. The Local Server Wrapper
- **File**: `scripts/mem0_server.py`
- **Responsibility**: Since `mem0ai` is a library, we will create a minimal FastAPI wrapper application that exposes the necessary endpoints (e.g., `/v1/memories/`) to mimic the hosted Mem0 API locally. This allows the plugin's `HttpMem0Client` to communicate with it on `http://127.0.0.1:8000`.

### 3. NPM Script Integration
We will update `package.json` with the following scripts:
- `"mem0:setup"`: Runs `uv venv` and `uv pip install mem0ai[local] fastapi uvicorn`.
- `"mem0:start"`: Runs `uv run uvicorn scripts.mem0_server:app --reload --port 8000`.

### 4. Developer Workflow
1.  **Initial Setup**: Run `npm run mem0:setup`.
2.  **Daily Development**: In a separate terminal, run `npm run mem0:start` to bring up the control plane.
3.  **Debugging**: Developers can attach a Python debugger to the running `uvicorn` process or run the script directly through their IDE using the created `.venv`.

## Error Handling & Edge Cases
- **Missing `uv`**: The npm scripts or a prerequisite check should inform the user if `uv` is not installed on their system.
- **Port Conflicts**: The default port is 8000. We will keep it hardcoded for simplicity in the npm script, but developers can manually run the `uvicorn` command if they need to change it.

## Testing Strategy
- Manual verification that `npm run mem0:setup` correctly creates the environment.
- Manual verification that `npm run mem0:start` brings up the server and it responds to basic HTTP requests.
- Verify that the OpenClaw plugin (in local mode) successfully communicates with this locally running server for auto-capture and search operations.

## Documentation
- Update `README.md` and `README.zh-CN.md` to document the new `npm run mem0:*` commands for local development.
- Update `.gitignore` to ensure `.venv/` is excluded.