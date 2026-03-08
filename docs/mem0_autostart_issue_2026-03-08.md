# Mem0 自动拉起问题定位记录（2026-03-08）

## 问题描述

用户反馈：
- 插件启动后，`mem0BaseUrl` 已配置为本地地址（如 `http://127.0.0.1:8000`）
- 但插件不会自动把 Mem0 服务拉起
- 导致自动捕获链路无法真正生效

---

## 定位结论

### 结论一：当前插件是“Mem0 客户端模式”，不是“Mem0 服务管理器”

插件当前职责是：
- 注册 tools/hooks
- 启动内部 poller/migration worker
- 通过 `HttpMem0Client` 调用已存在的 Mem0 API

插件当前**不包含**启动 Mem0 进程/容器的逻辑。

### 结论二：代码中没有自动拉起服务的实现

在 `src/index.ts` 和相关模块中未发现：
- `child_process.spawn/exec`
- `docker run` 调用
- systemd/service 管理逻辑

因此即使配置了本地 `mem0BaseUrl`，若本地服务未启动，插件也不会代为启动。

### 结论三：当前配置表现符合代码行为

当前日志可见：
- 插件加载成功（`Status: loaded`）
- hooks 注册成功（auto-recall / auto-capture）
- 但本地 `:8000` 服务未运行时，Mem0 调用不可达

所以“没有自动拉起 Mem0”是**预期外部依赖未满足**，不是加载失败。

---

## 影响范围

1. 自动召回（autoRecall）
   - 可走 LanceDB 本地检索
   - Mem0 fallback 不可用（服务未起）

2. 自动捕获（autoCapture）
   - hook 会触发
   - 但提交到 Mem0 失败/不可用，链路不完整

3. 手动工具
   - `memoryStore` / `memorySearch` 的 LanceDB 路径可用
   - Mem0 控制面能力受限

---

## 根因归类

- 架构层面根因：插件设计为“客户端调用”而非“服务编排/守护”
- 运维层面根因：本地 Mem0 服务未提前启动

---

## 修复方向（供 Codex 实施）

### 方案 A（推荐，职责清晰）

保持插件仅做客户端，不自动拉起服务：
- 在部署脚本/启动脚本中先启动 Mem0（Docker 或 Python）
- 插件启动时仅做健康检查，若不可达给出明确告警

优点：
- 边界清晰
- 风险低
- 易排障

### 方案 B（可选，提升体验）

增加可选自动拉起能力（默认关闭）：
- 配置项：`mem0.autoStart: boolean`（默认 false）
- 启动前探活 `mem0BaseUrl`
- 若不可达且 `autoStart=true`：尝试启动本地 Mem0（docker/python）
- 增加启动超时、重试、失败回退和日志

风险：
- 插件权限/安全面扩大
- 进程管理复杂度上升
- 跨平台兼容成本增加

---

## 最小化验收清单

1. 插件启动时输出明确状态：
   - Mem0 reachable / unreachable
2. `autoCapture=true` 时，确认 `agent_end` 后有成功提交日志
3. `autoRecall=true` 时，确认 `agent_start` 能注入相关记忆
4. 服务未启动时，报错信息可定位（包含 baseUrl/状态码/重试信息）

---

## 一句话总结

> 当前“启动不自动拉起 Mem0”不是偶发 bug，而是当前插件职责边界决定的行为；要么在外部先起服务（推荐），要么显式实现可选 `autoStart` 能力。