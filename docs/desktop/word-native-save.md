# 背景：Word 原生保存（Yrs → .docx 移植到 Rust）

状态：背景说明，未立项 · 2026-11-07 · 关系：[word-design.md](word-design.md) §2"写回 .docx 借桌面端的 JS 引擎"

## 1. 现状

FinxWork 的 Word 由内核持有：打开的 .docx 在 deck-worker 里是一份 `finx_word::Word`（BetterOffice `docx-edit` 的
`EditSessionCore`，Yrs 协作状态）。读、改、修订、撤销、与编辑器副本同步都在 Rust 里完成。

唯一不在 Rust 里的一步是**写回**：把编辑后的 Yrs 状态变成 .docx 字节。这一步交给桌面端：

```
内核 docx/save ──▶ 写出 source.docx + state + peer metadata 到临时文件
               ──▶ docx/serialize（经 docx/host 登记的桌面主进程）
               ──▶ Electron utilityProcess：@betteroffice/docx 的 saveYrsDocx
               ──▶ 内核 check_saved 校验 → 基准哈希检查 → 原子替换原文件
```

## 2. 为什么现在这样做

- BetterOffice 的写回分两段，**都只有 TypeScript 实现**：
  - `packages/docx/src/yrs/yrsToDocument.ts`（约 4400 行）：Yrs 状态 → 文档模型；
  - `packages/docx/src/yrs/saveYrsDocx.ts`（约 700 行）+ `writeSessionSave`：文档模型 → zip/XML，以源文件为基线，
    只重写改动过的部件。
- Rust 侧只有后半截的底层：`docx_parse::serializer::write_docx_s13(S13SaveRequest, 源字节)`，它要求调用方先给出
  完整的文档模型。引擎自己的 Rust 用法只在测试里给简单段落手工拼模型（`docx-edit/tests/edit_batches.rs`、
  `src/batch.rs`）。
- 内核是纯 Rust 进程，没有 JS 运行时；Electron 的 RunAsNode 熔丝为安全关闭（`build-app.mjs`），内核不能借它起 Node。
- 借桌面端是改动最小、保真最高的做法：用的就是引擎作者自己维护、有测试的写回代码。

## 3. 代价

- **纯命令行（没有桌面端）**：`docx_save` 不可用；`docx_view` 在有未保存改动时不可用（要先拿到当前字节），
  没有改动时直接渲染磁盘文件。读和改不受影响。
- **两套引擎版本要对齐**：内核用 fork 的 Rust crate（git rev），序列化进程用 JS 包。版本不一致时 peer metadata
  字段会对不上（实际出过 `unknown field seed_identities`）。所以 JS 包必须从 fork 同一提交发布（见 betteroffice-fork.md）。
- 保存多一次进程间往返和临时文件读写；大文档耗时以 JS 引擎为准。

## 4. 移植到 Rust 要做什么

目标：`Word::save() -> Vec<u8>`，内核独立完成写回，`docx/host` 退为可选。

| 工作 | 说明 |
|---|---|
| Yrs → 文档模型 | 移植 `yrsToDocument.ts`：段落、run 属性、样式引用、列表编号、表格（合并单元格、网格）、图片与媒体令牌、批注范围与线程、修订（ins/del/格式修订）、内容控件、书签、超链接、域、页眉页脚与别名、脚注尾注与分隔符、节属性 |
| 模型 → 部件 | 接上 `write_docx_s13`，补齐 `saveYrsDocx` 里 Rust 侧没有的部分：批注部件与 commentsExtended/ids、修订日期与作者、未改部件按基线原样保留 |
| 不变量 | 未改动部件逐字节等于源文件（I2）；改动部件与 JS 写回结果语义一致 |
| 验证 | 用 JS 写回作对照：同一组文档 × 同一组编辑，比较两边输出的部件集合与 XML（规范化后）；BetterOffice 的 fidelity 语料跑一遍 |

规模估计：核心移植约 5 千行 TS 对应的 Rust，加对照测试。风险集中在长尾结构（域、内容控件、复杂表格、
修订嵌套），这些一旦写错就是**静默丢内容**，比"不能保存"更糟。

## 5. 建议

- 移植应在 **fork 里做**，作为 `docx-edit` 的原生保存接口，并争取回馈上游；FinxWork 只换调用点，`docx/save`、
  工具、前端都不变。
- 上线前以 JS 写回为对照、双写比对一段时间，确认一致后再切。
- 在命令行用 Word 成为真实需求前，维持现状；先保证 JS 包与 Rust crate 同一提交发布，消除版本错位。
