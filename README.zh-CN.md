# Mem0 + LanceDB OpenClaw 记忆插件

[English README](./README.md)

这是一个 OpenClaw 记忆插件，使用 Mem0 作为控制面，使用 LanceDB 作为检索层。

当前采用单插件内嵌式三平面架构：

- `audit plane`：基于 `auditStorePath` 的 file-first 审计记录
- `control plane`：Mem0 client 与同步状态
- `hot plane`：LanceDB 检索热面
- 统一 schema：`src/schema/memory_record.schema.json`

## 安装

***REMOVED***bash
cd plugins/memory-mem0-lancedb
bash scripts/install.sh
***REMOVED***

## 配置

在 `openclaw.json` 中添加以下插件配置：

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
          "mem0ApiKey": "your-mem0-api-key（可选，留空则为纯本地模式）",
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

## 提供的工具

### `memory_search`

主记忆槽搜索工具，优先从 LanceDB 检索，必要时回退到 Mem0。

***REMOVED***
{
  "query": "用户的饮食偏好",
  "userId": "user_123",
  "topK": 5,
  "filters": {
    "scope": "long-term",
    "categories": ["preference"]
  }
}
***REMOVED***

### `memory_get`

按工作区相对路径读取记忆源文件片段。

***REMOVED***
{
  "path": "MEMORY.md",
  "from": 1,
  "lines": 20
}
***REMOVED***

### `memorySearch`

插件额外暴露的混合检索接口。

***REMOVED***
{
  "query": "用户的饮食偏好",
  "userId": "user_123",
  "topK": 5,
  "filters": {
    "scope": "long-term",
    "categories": ["preference"]
  }
}
***REMOVED***

### `memoryStore`

写入一条记忆，并将其同步到 LanceDB；如果配置了 Mem0，则会同时走 Mem0 流程。

***REMOVED***
{
  "text": "用户喜欢科幻电影。",
  "userId": "user_123",
  "scope": "long-term",
  "categories": ["preference", "entertainment"]
}
***REMOVED***

## 架构

1. 写入链路：Agent -> `memoryStore` -> audit plane -> outbox / sync-engine -> Mem0 控制面 + LanceDB 检索热面
2. 读取链路：Agent -> `memory_search` / `memorySearch` -> 优先 LanceDB hot plane -> 回退 Mem0
3. 面向人工审计的真相源：通过 file-first 审计面保存的记录

## 开发

***REMOVED***bash
npm install
npm run dev
npm run build
npm test
***REMOVED***
