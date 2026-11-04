# 电子表格：交接文档

更新日期：2026-11-04。分支 `feat/document-editor`，基线提交 `fc6aabf`。
本文件与本轮代码仍在工作区，**没有提交或推送**。工作区包含上一轮留下的改动，接手时请保留。
方案见 [spreadsheet-design.md](spreadsheet-design.md)，零期验证见 [spreadsheet-validation-2026-11-03.md](spreadsheet-validation-2026-11-03.md)。

## 本轮完成

原交接的第 1–7 项已实现；第 8 项明确留在二期。

| 项目 | 实现与约束 |
|---|---|
| CSV / TSV | `finx-sheet/src/csv.rs`、`finx-docs/src/sheet.rs`：UTF-8、BOM、GB18030，识别引号外的分隔符，保留原编码和换行；拒绝异常引号、公式和不可编码文本，写后读回自检也覆盖新增行。前导零和长编号按文本保留。 |
| XLS | `finx-sheet/src/xls.rs`：calamine 只读；拒绝编辑和保存。不假设用户装了 Excel。 |
| 界面格式能力 | `docs/state.ts` 把 csv/tsv/xls 路由到网格；`SheetView.tsx` 依据能力禁用编辑、撤销重做，CSV 公式输入有中文说明。另存为对话框保留原扩展名，服务端拒绝伪装格式转换。 |
| 跨会话刷新 | DocStore `on_change` → 服务端 `doc/changed` → renderer `store.tsx` / `docs/state.ts`；其他会话改同一文件时刷新网格。切表清除改动提示，忽略旧异步读取的结果，并避免沿用上一张表的行高缓存。 |
| 结构化引用 | `finx-sheet/src/tables.rs` 读取 table 部件，计算时展开 `[@列]`、`Table[@列]`、`Table[列]`、`[[#This Row],[列]]` 和常见区段/连续列范围；计算器、循环探针、依赖图走同一改写。**文件中的公式文本不被改写**。不能可靠展开的形式保留原式，交由可信判断处理；多区段并集不近似成连续范围。 |
| AGGREGATE | 本地 IronCalc 补丁支持 19 种运算、选项 0–7、忽略错误/隐藏行/嵌套汇总、范围与数组。读取工作簿时把隐藏行交给计算器。 |
| TEXTJOIN | 修正忽略空字符串，支持数组，保留 `ignore_empty=false` 下的尾部空格子，检查 32767 字符限制。 |
| 重算入口 | 协议 `doc/recalc`，参数 `circular_only`；工具栏计算器图标“全部重算”、循环图标“重新计算循环”。按方案 §5.6.3 **比较计算结果与工作副本缓存**，报告差异并可跳转；循环从 0 开始迭代。不会改文件、修订号、dirty 状态或提升不可信结果。时钟仍是修订记录。 |
| 列宽 / 行高 | `SheetView.tsx` 按 `doc_id` 存 localStorage，表名包含在键里；关闭文件重开仍恢复。不写回工作簿（写格式属于二期）。 |
| 体验 | 选区浮条反向缩放，屏幕大小固定；切表清除智能体改动提示；审批卡片和影响面只对关键输出显示变化百分比。重算按钮采用图标，给公式栏留出空间。 |

### IronCalc 补丁

根 `Cargo.toml` 用 `[patch.crates-io]` 把 `ironcalc_base` 指向我们的 fork：[Eliseowzy/IronCalc](https://github.com/Eliseowzy/IronCalc/tree/finx/0.9.1) 的 `finx/0.9.1` 分支，锁定到具体提交（`rev`）。
该分支从上游标签 `v0.9.1` 拉出（与 crates.io 0.9.1 源码一致），每个补丁一个提交：固定 `INFO("release")` 的版本号、AGGREGATE、TEXTJOIN。
上游已有同类 PR（AGGREGATE：ironcalc/IronCalc#1434；TEXTJOIN：ironcalc/IronCalc#1441），上游发布包含这些修复后，移除 patch 配置即可。

- **升级**：在 fork 里把 `finx/0.9.1` 的补丁 rebase 到上游新标签（建新分支，如 `finx/0.10.0`），推送后更新 `Cargo.toml` 里的 `rev`，再跑下面的验证。
- **离线构建**：git 依赖首次构建要能访问 GitHub；离线前先 `cargo fetch --locked`。

## 验证

- `FINX_SHEET_CORPUS=/Users/eliseo/ai-excel/corpus/real cargo test -p finx-sheet`：单元、计算、随机写入、影响面往返、回归；真实模型的计算一致性、循环从 0 重算、修改后往返均覆盖。语料不进仓库。
- `cargo test -p finx-cli --test e2e_sheets --test e2e_docs`：4 条，覆盖协议与智能体流程、重算不改修订/文件、CSV 原编码保存、TSV 保存、错误表名和格式转换拒绝、XLS 编辑/保存拒绝。
- `FINX_UPDATE_SNAPSHOTS=1 cargo test -p finx-protocol`，随后 `node packages/protocol/scripts/generate.mjs`：已更新 schema 和 TypeScript 类型。
- `pnpm --filter @finx/desktop typecheck` 与 `node --test apps/desktop/src/shared/locales.test.ts`：通过。
- 在 fork 的 `finx/0.9.1` 分支里 `cargo test -p ironcalc_base textjoin`：上游 TEXTJOIN 的 3 条回归通过。
- `PATH=$HOME/.cargo/bin:$PATH node apps/desktop/e2e/file-panel.mjs`：隔离 HOME / profile 的真实 Electron 测试。新增网格编辑保存、重算、浮条缩放、列宽行高关闭重开恢复、跨会话刷新及切表清理、CSV 公式拒绝与保存、XLS 只读。选择器须限定 `.dcp-viewer:not([hidden])`，后台文件的网格也留在 DOM 中。
- 桌面脚本曾在启动或 tooltip 等待上偶发超时；现在先激活隔离测试窗口，跨会话用例等待初始单元格加载后再发起修改，失败时保存截图和面板状态。**最终串行复跑整套通过**。验证 tooltip 计时行为时避免与重编译并行。

截图可通过 `FINXWORK_E2E_SHOTS=<目录>` 输出。本轮临时截图在 `/tmp/finx-sheet-review`，不进入仓库。

## 后续范围

- 二期：插删行列、改格式、填充、写动态数组 / LET 等；没有在本轮开放。
- 真 Excel / WPS 打开输出核对、国内模板语料等（方案 §13.2）仍待做。本轮是与已有文件缓存和定义参考值比较，**没有在真 Excel 中重新判定**。
- 方案原有 §11 性能优化、保存时跨会话文件锁的专项工作仍待做。

## 接手约定

- 回答用简体中文；外部打开文案用“表格软件（Excel、WPS 等）”或“用系统默认应用打开”。
- 写不了就拒绝。OOXML 修改继续走 `finx_sheet::write` 三层自检；不能把 IronCalc 的 `#ERROR!` / `#CIRC!` 写进工作簿。不自动接受不可信计算值。
- 先看 `git status`，工作区可能有其他会话同时修改。仅用户要求时提交，提交说明末尾加署名行。
- 交互调试使用 `pnpm dev`（apps/desktop）；需要脚本驱动时给开发版加调试端口，避免操作用户当前会话。没有 Excel 安装前提。
