---
id: TASK-regen-protocol-schema
title: 重新生成协议的 schema.json 和 generated.ts（一处注释变了）
created: 2026-11-13T23:20:00+08:00
write-scope: crates/finx-protocol/schema.json、packages/protocol/src/generated.ts
priority: low
---

## 目标
`crates/finx-protocol/src/doc.rs` 里 `SpatialStructure.origin` 字段的文档注释改成了 ``Where it came from: `script:run_<n>`, `user`.``，提交在仓库里的两份生成文件还是旧注释（含 `recipe:<file>`）。请把它们重新生成到一致。

验收标准：
1. `cargo test -p finx-protocol` 通过（其中有一个测试校验 `schema.json` 与类型一致）。
2. `grep -n "recipe:<file>" crates/finx-protocol/schema.json packages/protocol/src/generated.ts` 没有输出。
3. 两份生成文件除这条注释外没有别的差异（用 `git diff --stat` 和 `git diff` 确认；如果出现别的差异，说明还有其他未同步的类型改动，请在执行结果里原样列出，不要手工回退）。

## 背景
- `crates/finx-protocol/src/schema.rs` 末尾的测试说明了更新方法：带环境变量 `FINX_UPDATE_SNAPSHOTS=1` 运行测试会重写 `schema.json`。
- `packages/protocol/src/generated.ts` 是从 schema 生成的 TypeScript 类型。生成命令请在 `packages/protocol/package.json` 的 scripts 和仓库根 `package.json` 里找；找不到就在执行结果里说明，不要手工编辑该文件。
- 不要修改 `doc.rs` 或其他源码。

## 验证
```bash
cargo test -p finx-protocol
git diff --stat -- crates/finx-protocol/schema.json packages/protocol/src/generated.ts
```

## 执行结果
- `FINX_UPDATE_SNAPSHOTS=1 cargo test -p finx-protocol`：22 passed, 0 failed（已重写 `schema.json`）。
- `cd packages/protocol && node scripts/generate.mjs`：重写 `generated.ts`（546 types）。
- `grep "recipe:<file>"` 两份文件均无输出；`cargo test -p finx-protocol` 再次通过。
- **额外差异说明**：除 `origin` 注释外，diff 还包含大量其他同步内容（schema.json +1189 行、generated.ts +230 行）。这是预期的：分支 `feat/document-editor` 上 `doc.rs`/`api.rs` 有未提交的类型改动（新增 `DocOpsParams/DocOpsResult`、`SpatialViewParams`、`SpatialProfile`、`SpatialPlane`、`SpatialCamera`、`SpatialLayer`、`DocOp` 各 spatial 分支、`FindingSource`、`MeshSource`、`SliceRect`、`SpatialMeasureValue` 等），旧生成文件从未同步过这些。未手工回退，全部保留为与当前源码一致。

## 状态
completed
