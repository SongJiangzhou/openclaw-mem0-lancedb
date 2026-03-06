# Memory Bridge Migration Note

`memory_bridge/` 的 Python 原型已经迁移到 TypeScript 正式实现，运行时代码现在位于：

- `src/bridge/uid.ts`
- `src/bridge/outbox.ts`
- `src/bridge/adapter.ts`
- `src/bridge/sync-engine.ts`

本目录不再保存 canonical schema；统一 schema 已迁移到 `src/schema/memory_record.schema.json`。
