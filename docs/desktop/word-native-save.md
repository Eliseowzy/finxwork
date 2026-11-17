# Word 原生保存（Yrs → .docx 在 Rust 里完成）

状态：已实现 · 2026-11-07 · 分支 `feat/word-native-save`；fork 分支 `finx/native-save`
关系：[word-design.md](word-design.md) §2"写回 .docx"

## 1. 现在怎么保存

内核的 deck-worker 自己写 .docx：`finx_word::Word::save()` 调 fork 的新 crate `docx-native-save`，
它是 NimbleOffice TypeScript 写回（`saveYrsDocx` + `yrsToDocument` 及其依赖，约 9 千行 TS）逐模块的 Rust 移植。

```
docx/save ──▶ WordStore::stage ──▶ deck-worker: Request::WordWrite ──▶ Word::save（原生）
                                 └─ 失败时 ──▶ 桌面端序列化进程（TS saveYrsDocx，旧路径）
          ──▶ WordCheck 校验 ──▶ 基准哈希检查 ──▶ 原子替换原文件
```

- `FINX_WORD_SAVE` 选写出方：`native`（默认，失败退回桌面端）、`desktop`（只用桌面端，即以前的行为）、
  `compare`（两边都写，保留桌面端结果，原生不一致时记日志，比对忽略 `dcterms:modified`）。
- 没有桌面端（纯命令行）时 `docx_save`、`docx_view` 照常可用。
- 保存只读会话：原生保存不回写"已保存的段落 ID"（TS 的 `recordSavedParagraphIds`），字节不受影响，
  与桌面端在一次性会话里保存的效果相同；保存不产生 Yrs 变更、不改修订号。

## 2. 移植方式

- 不重新设计：TS 写回本质是在 JSON 文档模型上做拼装，两头（解析、写包）本来就是 Rust（经 WASM）。
  移植在 Rust 里复刻 JS 的值语义（`js::Js`：对象按引用共享、按身份比较、键保持插入顺序、
  `undefined` 与 `null` 区分、数字一律 f64、字符串按 UTF-16 计长），逐个函数照抄 TS，
  每个 Rust 文件开头注明对应的 TS 文件。
- 会话方法（`story_segments`、`paragraph_save_plan` 等）在 TS 里本就是 `EditSessionCore` 的薄封装，
  Rust 直接调；写包调同一个 `docx_parse::write_docx_s13_with_warnings_json`。
- 结果是：同一会话下，Rust 交给写包器的请求 JSON 与 TS 逐字节相同，输出的 .docx 也逐字节相同。

## 3. 验证

| 测试 | 规模 | 结果 |
|---|---|---|
| 差分探针：fork 全部 TS 保存测试里每次 `saveYrsDocx`，同一状态再用 Rust 存一遍，比对每个部件与请求 JSON | 67 个测试文件、2433 次保存 | 2431 次逐字节一致；2 次是测试工具重建会话失败（该用例替换了 `crypto` 并预置包摘要，`bootstrap_peer` 校验不过），与保存无关 |
| 场景矩阵：24 份真实文档 × 26 种编辑（插入/删除文字、加粗/斜体/字号、拆分/合并段落、修订插入/删除、接受/拒绝修订、批注增/回复/解决/删除、插入表格、增删行、合并单元格、页眉页脚、脚注、页边距、方向、列表、超链接、分页符） | 624 格 | 504 一致，120 跳过（文档里没有对应结构），0 不一致 |
| 内核保存场景（`finx-word/tests/save.rs`）：每种编辑后保存→重开→内容正确；未改动部件与源文件逐字节相同；内核实时会话保存 = 按桌面端方式重建会话保存 | 9 个 | 全部通过 |
| WordStore（`finx-docs/tests/word_store.rs`）：原生保存、无桌面端、compare 模式、桌面端模式、冲突与另存 | 8 个 | 全部通过 |
| 工具（`finx-core` word）：无桌面端时编辑、查看页面、保存、重开 | 4 个 | 全部通过 |

复现：fork 里 `bun scripts/native-save-diff.ts`、`bun scripts/native-save-scenarios.ts`、`bun scripts/native-save-bench.ts`。

## 4. 性能

同一台机器、同一负载，毫秒（中位数）：

| 文档 | 桌面端（node，开会话 + 灌状态 + 保存） | 原生，每次新建会话（同口径） | 原生，内核实时会话的后续保存 |
|---|---|---|---|
| 50 段 | 45 | 22 | 12 |
| 500 段 | 189 | 195 | 112 |
| 5000 段 | 2091 | 2244 | ~1200 |

- 内核实际走的是最后一列：会话一直开着，引擎的段落标识、保存计划缓存在第一次保存后保留；桌面端每次都要
  重建会话，还要加进程间往返与临时文件。端到端原生快约 1.7–3.7 倍；打开后第一次保存与桌面端持平。
- 同口径（都新建会话）时原生小文档快约一倍，500 段以上慢 10–25%：时间分散在用 `Js` 值模型复刻 JS
  语义的开销上（5000 段：拼装模型 ~500ms、写包器 ~300ms、重新解析源包 ~180ms），没有单一热点。
- 已知：5000 段文档一次保存峰值内存约 700MB（同口径 node 进程约 700MB）；同一进程反复保存时 RSS
  高水位缓慢上升，`leaks` 检查无泄漏，是分配器碎片或会话缓存。

## 5. 以后

- 提速的下一步：像 TS 那样跨次保存保留投影缓存（`sessionProjectionMemo`），只重算改动过的 story。
- fork 的 TS 改动时，移植要跟着改；差分探针是守门测试，应进 fork 的 CI。
- 若确认长期一致，可去掉桌面端序列化进程（`docx/host`、`docx/serialize`）；现在保留作退路与对照。
