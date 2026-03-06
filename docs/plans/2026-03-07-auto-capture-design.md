# Auto Capture Design

**Date:** 2026-03-07

**Goal:** 在 `memory-mem0-lancedb` 插件中增加“配置开启时生效”的 auto-capture，默认捕获最新一轮 `user + assistant` 消息，并让 `Mem0` 负责事实抽取。

## Scope

本阶段只覆盖 Phase 1：

- 配置开启时自动 capture
- 默认抓取最新一轮 `user + assistant`
- 生成幂等键
- 提交到 Mem0
- 事件确认

本阶段不做：

- 把 Mem0 抽取结果完整回写到本地三平面
- 多轮窗口 capture
- 复杂本地规则抽取
- auto-recall 与 auto-capture 组合调优

## Architectural Decision

采用“插件负责 orchestration，Mem0 负责抽取”。

也就是说：

- 插件不自己做复杂事实抽取
- 插件只负责：
  - 选择何时提交
  - 选择提交哪些消息
  - 生成幂等键
  - 处理事件确认
- 抽取逻辑由 Mem0 完成

## Trigger Model

推荐在回合结束时触发：

- 若宿主暴露兼容的 `agent_end` / `turn_end` hook，则在该 hook 中运行
- 若宿主没有兼容 hook，则静默跳过，不影响插件加载

## Capture Payload

默认只提交最新一轮：

- `user` message
- `assistant` message

请求体建议包含：

- `messages`
- `user_id`
- 可选 `run_id`
- `idempotency_key`
- capture 配置元数据

## Idempotency

幂等键不等于 `memory_uid`。

这里的幂等目标是“同一轮对话不重复提交 capture”，建议：

`sha256(user_id | run_id | latest_user_message | latest_assistant_message)`

这样可以：

- 避免重复 hook 触发
- 避免同一轮反复写入 capture 请求

## Config Shape

推荐新增：

- `autoCapture.enabled: boolean`
- `autoCapture.scope: 'long-term' | 'session'`
- `autoCapture.requireAssistantReply: boolean`
- `autoCapture.maxCharsPerMessage: number`

默认建议：

- `enabled: false`
- `scope: 'long-term'`
- `requireAssistantReply: true`
- `maxCharsPerMessage: 2000`

## Phase Split

### Phase 1

- 回合消息打包
- 提交 Mem0
- 事件确认
- capture 幂等

### Phase 2

- 把 Mem0 抽取出的结果再同步回：
  - audit plane
  - LanceDB

## Testing Strategy

### `src/capture/auto.test.ts`

- 只打包最新一轮 `user + assistant`
- `requireAssistantReply=true` 时，没有 assistant 不提交
- 相同轮次产生相同 `idempotency_key`
- 超长消息按 `maxCharsPerMessage` 截断

### `src/control/mem0.test.ts`

- capture 提交成功 / unavailable / confirmed / timeout

### `src/index` tests

- `autoCapture.enabled=true` 且宿主有 hook -> 注册
- 没有 hook -> 不报错

## Acceptance Criteria

- 配置开启时可自动 capture 最新一轮
- 配置关闭时不影响现有行为
- capture 走 Mem0 抽取路线
- hook 不存在时插件仍正常加载
- 构建和测试离线可通过
