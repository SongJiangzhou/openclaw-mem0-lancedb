# OpenClaw Mem0 LanceDB Embedded Design

**Date:** 2026-03-07

**Goal:** 按 `docs/openclaw_use_mem0_and_lanceDB.md` 的方向，在单个 OpenClaw memory 插件内实现 file-first 审计面、Mem0 控制面、LanceDB 检索热面三平面架构，而不拆分外部 Memory Service。

## Scope

本设计只覆盖“单插件内嵌入式版本”：

- 保留单个 OpenClaw memory 插件
- 不新增独立 HTTP 服务
- 在当前仓库内完成数据模型、写入同步、检索与回溯能力
- 为未来服务化保留模块边界

不在本阶段完成：

- 外部 Memory Service
- 多实例共享记忆服务
- 完整 webhook 基础设施
- 大规模分片和复杂在线索引运维

## Architectural Decision

采用三平面单进程架构：

- `audit plane`
  - file-first
  - 作为最终人工可审计真相源
- `control plane`
  - Mem0
  - 负责治理、异步事件、补充召回
- `hot plane`
  - LanceDB
  - 负责主检索路径和低延迟 recall

插件内部按模块拆分，但保持一个对外插件入口。

## Module Layout

建议目录结构：

- `src/bridge/`
  - 统一 `MemoryRecord`
  - `memory_uid`
  - outbox
  - sync engine
- `src/audit/`
  - Markdown / audit log 写入
  - memory 到文件位置的映射
  - file-first 回溯
- `src/control/`
  - Mem0 client
  - event polling / visibility confirmation
  - capture / recall policy
- `src/hot/`
  - LanceDB schema
  - embedder
  - FTS / vector / hybrid search
- `src/tools/`
  - OpenClaw 工具适配层
- `src/index.ts`
  - 插件注册与配置

## Truth Model

真相源定义为 file-first。

也就是说：

- Markdown / audit log 是最终人工可审计基准
- Mem0 不是真相源，只是控制面
- LanceDB 不是真相源，只是检索热面

当三者不一致时，审计面为基准，其他两层由同步机制修复。

## Write Flow

`memoryStore` 的推荐写入流程：

1. 工具层组装统一 `MemoryRecord`
2. 先写 `audit plane`
3. 再写 outbox 并生成 `idempotency_key`
4. sync engine 继续把记录同步到：
   - Mem0
   - LanceDB
5. 分别执行可见性确认
6. 更新 outbox 状态
7. 将结果映射回工具返回值

这样定义写入结果：

- `accepted`
  - 审计面已写入且 outbox 已接收
- `synced`
  - Mem0 和 LanceDB 均完成同步
- `partial`
  - 审计面成功，但 Mem0 或 LanceDB 至少一边失败
- `failed`
  - 审计面未建立，或基础记录无法形成

内部状态机继续保留：

- `pending`
- `processing`
- `done`
- `failed`

## Read Flow

读路径以 LanceDB 为主，Mem0 为补充与兜底。

推荐顺序：

1. `memory_search` / `memorySearch` 接收查询
2. 优先查询 LanceDB hot plane
3. 先做 FTS + 过滤
4. 第二阶段补 vector + hybrid + RRF
5. 对结果做后处理：
   - 去重
   - `status=active`
   - user/run/scope 过滤
   - 简单时序优先
6. LanceDB 结果不足时再查询 Mem0
7. 返回兼容当前工具协议的结构化结果

Markdown 不直接参与 Top-K 检索，但需要提供回溯定位。

## Data Model

以统一 `MemoryRecord` 为中心，约束三平面数据一致性。

需要把现有 `memory_bridge/schema/memory_record.schema.json` 正式并入 `src/`，并作为这些内容的统一来源：

- TypeScript 类型
- LanceDB row 映射
- audit plane 序列化
- 工具层返回结构

第一阶段允许：

- TypeScript 类型为主
- JSON Schema 作为运行时/文档资产保留在 `src/`

## Search Strategy

检索分阶段推进：

### Phase 1

- FTS + metadata filters
- LanceDB 主检索
- Mem0 fallback

### Phase 2

- embedding provider
- vector search
- hybrid search
- RRF 融合

### Phase 3

- recall policy
- 自动注入阈值
- 冗余控制

## Capture / Recall Policy

本阶段先不把自动 capture / auto recall 作为默认强绑定能力。

优先级如下：

1. 显式工具能力正确
2. 数据模型与同步面稳定
3. 然后再增加插件生命周期中的自动 recall/capture 开关

原因：

- 当前仓库首先缺的是稳定数据面
- 自动注入会显著放大策略复杂度
- 先稳定基础数据流更符合 YAGNI

## Migration Strategy

推荐的实现顺序：

1. 统一 `MemoryRecord`，把 schema 并入 `src/`
2. 增加 `audit plane`
3. 扩展 sync engine 为真正的 file -> outbox -> Mem0/LanceDB 双写
4. 重构 `search/get` 到统一 hot plane
5. 增加 Mem0 可见性确认与 `partial/synced` 结果
6. 最后再做 auto capture / auto recall

## Testing Strategy

测试按四层建设：

- schema / type tests
- audit plane tests
- sync engine tests
- LanceDB retrieval tests

回归目标：

- `memoryStore` 可以 file-first 写入
- 审计面成功时至少返回 `accepted`
- LanceDB 成为主 recall 面
- Mem0 失败时不阻塞本地最小可用路径
- `memory_get` 能从审计面或统一记录中稳定回溯

## Acceptance Criteria

- 插件维持单 memory slot 形态
- file-first 成为明确真相源
- Mem0 成为控制面，而不是唯一写入成功判定
- LanceDB 成为主检索热面
- schema 正式并入 `src/`
- 当前基础工具接口保持兼容
- 后续可平滑演进为外部 Memory Service
