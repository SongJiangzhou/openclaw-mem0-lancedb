# Hot Plane Vector Hybrid Search Design

**Date:** 2026-03-07

**Goal:** 在当前嵌入式三平面架构上，把 `hot plane` 从 FTS-only 检索升级为 `FTS + vector + hybrid + RRF`，同时保持离线可运行和测试稳定。

## Scope

本阶段只覆盖 `hot plane` 的 phase 2 能力：

- deterministic embedder
- LanceDB `vector` 列
- FTS + vector 双路检索
- 显式 RRF 融合

本阶段不做：

- 真实外部 embedding provider
- cross-encoder reranker
- MMR / 时间衰减策略
- auto recall / auto capture
- 大规模索引参数调优

## Architectural Decision

采用“伪向量 + 真实 hybrid + 显式 RRF”的实现路线。

原因：

- 当前仓库没有稳定的 embedding provider 配置与依赖
- 但可以先把检索架构做实
- 未来接入真实 provider 时，只替换 embedder，不重写 hot-plane API

## Module Changes

新增或扩展以下模块：

- `src/hot/embedder.ts`
  - `embedText(text): number[]`
  - deterministic
  - 固定维度
- `src/db/schema.ts`
  - `MemoryRow` 增加 `vector`
- `src/db/table.ts`
  - 表 schema 增加 `vector` 列
- `src/bridge/adapter.ts`
  - 写入 LanceDB 时附带 embedding
- `src/hot/search.ts`
  - 拆分为：
    - `searchFts()`
    - `searchVector()`
    - `mergeRrf()`

## Write Path Impact

写入流程保持现有 file-first + sync engine 不变。

唯一新增的是：

- 在写入 LanceDB 之前，对 `text` 做 deterministic embedding
- 将结果写入 `vector` 列
- 将 `lancedb.vector_dim` 与 embedder 维度保持一致

## Query Flow

`HotMemorySearch.search()` 的 phase 2 行为：

1. 解析 query 和过滤条件
2. 执行 FTS 路检索
3. 对 query 生成 embedding
4. 执行 vector 路检索
5. 两路结果都转换为 `memory_uid + rank`
6. 用 RRF 融合排序
7. 返回 canonical `MemoryRecord` 结构

回退策略：

- vector 不可用 -> FTS only
- FTS 不可用 -> vector only
- 两路都不可用 -> 退回文本包含过滤

## Embedder Design

第一版 embedder 的要求：

- 同一输入始终输出相同向量
- 不同输入通常输出不同向量
- 固定维度，例如 16 或 32
- 不依赖网络和外部模型

推荐实现方式：

- 用归一化文本
- 基于 hash / 字符桶统计构造固定长度向量
- 再做简单归一化

目标不是高质量语义向量，而是保证：

- 写入和查询路径都有一致向量
- hybrid / RRF 能被真实验证

## RRF Design

采用最小标准 RRF：

`score = 1 / (k + rank)`

建议：

- `k` 固定常量，如 `60`
- FTS 和 vector 两路分数求和
- 按 fused score 降序排序

这样可以：

- 避免依赖 LanceDB SDK 的内部融合细节
- 在测试中更稳定地验证排序行为

## Testing Strategy

### Embedder tests

- 同文本 embedding 稳定
- 不同文本 embedding 不完全相同
- 向量维度固定

### Hot search tests

- 一条记录通过关键词命中
- 一条记录通过向量近似命中
- hybrid 融合后两者都能召回
- RRF 排序稳定

### Regression tests

- `store_lancedb.test.ts`
- `local_fallback.test.ts`
- 现有 build / test 全绿

## Acceptance Criteria

- LanceDB 行 schema 带 `vector`
- 新写入记录拥有 deterministic vector
- `HotMemorySearch` 同时支持 FTS 和 vector 路
- hybrid 使用显式 RRF 融合
- 无外部 embedding 服务时仍然可构建、可测试、可离线运行
