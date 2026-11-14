# 工作说明：接续会话（2026-11-09 下午）

接手 Claude 第一轮（已完成发版）与 Codex 续作（配额耗尽中断）之后的推进记录。
方法与环境见 [word-parity-handoff.md](word-parity-handoff.md)，指标与已知问题见
[word-parity-progress.md](word-parity-progress.md)。本文只记录本次会话做了什么、
发现了什么、留下了什么。

## 一、接手时的现场

- **代码**：`finx/word-parity`（工作分支）停在 `0ea01fa7`；Codex 的集成工作区
  `~/betteroffice-parity-integration` cherry-pick 了 r1 表格行距修复
  （`7822619f`）；Codex 的 float-wrap 工作区有 **2 个未提交文件**——跨页文字
  挤窄的修复写到一半（12:08 配额耗尽）。
- **数据**：`~/word-parity-data/runs/` 有 15+ 个历史 run；exp 目录有 Codex 的
  `float3600/float7000` 实验（带 Word 实测 word.json）。
- **未提交现场**：wp-r2 工作区 13 个文件、wp-r4 工作区 9 个文件（两个 claude
  会话"5 小时上限"中断遗留）；progress/handoff 文档本身也从未提交。

## 二、完成的工作

### 1. 收尾 Codex 的跨页挤窄修复（`82f49665`）

- 在 Codex 自己的工作区验证（stash 对照实验）：float7000 第 2 页"文字永久
  挤窄"消失；float3600 保持与 Word 一致。
- 打补丁到 `finx/word-parity`，补齐交付物：回归测试 `floating_table_split.rs`
  （3 个 active 断言 + 1 个记录开放问题的 ignored 测试）、Word 实测 fixtures
  （`fixtures/floating-table-split/`，含 generate.py 与 word.json）。
- 金标准验证：stash 掉修复，恰好 2 个挤窄断言变红。
- 全量：**页数一致 93.40% → 93.61%，2 份变好（1 份 100% 完全一致），0 份变差**。
- 遗留（Word 实测确认）：窄列塞不下的行 Word 推到下一页，引擎放在本页全宽
  ——记为 ignored 测试与 word.json `knownOpen`。

### 2. 合并与验证 v3 候选

- `finx/word-parity` = `finx/0.5`（v2 发版）+ r1 + r5 + 挤窄修复 + 测试资产
  + 工具，共 8 个提交（至 `8808fd24`），**已推上 fork**。
- 单进程干净全量（此前一次双进程竞争污染过数据，已作废重跑）：

| 对比 v2 | 页数一致 | 逐行一致 | 变好 | 变差 |
| --- | --- | --- | --- | --- |
| v3 候选 | 92.58% → **93.61%** | 40.49% → **41.80%** | 18 份 | 2 份（见下） |

- 三个 crate 测试全过（仅既有无关的 `chart_snapshots` 失败）。
- 新工具 `tools/word-parity/compare_runs.py`（`c1cdadd2`）：逐文档对比两个
  run，非零退出码标记退化——0 退化门槛的检查器。

### 3. 两份"退化"的深度诊断（结论反转）

受控实验（自建 `zone-sz4/zone-none.docx` + Word 16.114 导出量测）+ v2/v3/Word
三方逐行对齐，结论：**两份退化不是 v3 的损伤，是既有亚磅级误差被正确修复暴露**。

- 两份文档的 v3−v2 差值均为均匀 **+0.45pt = tblpY**；而 tblpY 应用**修对了**
  表格起点（negative-height 表头行 dy −0.38 → +0.07；avoid-last-manip 的
  **35.66pt 大偏差 → 0.14pt**，几何上好 250 倍）。
- 真正的残差是 v2 时代就有的：negative-height 表头行（多行单元格）高
  0.87pt 过高；avoid-last-manip 片段底部缺 0.5pt 下边框。原来被起点误差
  抵消、恰好压在 0.5pt 对比容差内；正确修复移走掩盖项后指标翻过容差线
  （"容差悬崖"）。
- 放大因素：**Word 的 PDF 导出把 y 量化到 0.24pt 网格**（"交替行距
  12.72/12.96"实为 12.84 真值的舍入伪影），引擎用 0.75px 网格，亚 0.5pt
  一致性有运气成分。

### 4. 新实测的引擎规则缺口（`0c3f72ed`，均有 Word 数据）

`fixtures/floating-table-zone/` + ignored 测试逐条记录：

1. **重叠 bug**：拆分浮动表格的末片段页上，段落不溢出本页时引擎不设环绕区
   ——文字全宽压在表格上渲染；Word 是挤在旁边窄列；
2. 窄列塞不下且与环绕区相交的行应推到**下一页**（引擎放到本页全宽）；
3. 片段底部 = 末行下边框**外缘**（引擎差 ~0.5pt）。

正确实现需要**按页环绕区模型**（当前 zone 是文档流相对坐标，Codex 的多阶段
循环是近似方案）——即 Codex 中断前"正在评估"的问题，量级为架构改动。

### 5. 发布（非 v3 部分）

- fork：`finx/word-parity` 推送（`0ea01fa7..8808fd24`）。
- FinxWork：`feat/document-editor` 推送 3 个文档提交，建 **PR #18**
  （发现 PR #17 实际已合并，交接文档信息过时）。
- **未发版**：无新 tag、`finx/0.5` 未动（仍在 `0ea01fa7`）、FinxWork 三处
  依赖指针未动（仍指 `v0.5.1-finx.g0ea01fa7`）。非 v3 改动全部不触碰运行时
  产物，正式发版等 v3 门槛裁决。

### 6. 工作区清理与 WIP 备份

- 删除 7 个已收录的 worktree（float-wrap/grid/r1/r3/r5/sad-mendeleev/
  integration，价值逐一验证后删），清 /tmp 残留与 exp*；r4 会话的源码备份
  归档到 `~/word-parity-data/backups/r4-session/`。**共回收 ~150G**。
- wp-r2 / wp-r4 的未提交改动各自提交为 WIP 快照并推上 fork：
  `43dff53d`（r2：文本框/合成粗体/东亚提示/探针）、`13fa0d8c`（r4：无
  sectPr 页面默认值 + 新测试和 fixtures）。两个 worktree `cargo clean`
  后各余 1.3G。
- 本机不再有"只存在于一台机器"的代码；数据（corpus/cache/runs）按设计留本地。

## 三、当前状态

| 项 | 状态 |
| --- | --- |
| fork `finx/word-parity` | `8808fd24`（v3 候选 + 测试 + 工具），已推送 |
| fork `finx/0.5` / release | `0ea01fa7` = `v0.5.1-finx.g0ea01fa7`，**未动** |
| FinxWork 依赖 | 三处指针均指 `v0.5.1-finx.g0ea01fa7`（最新已发版，一致） |
| FinxWork 文档 | PR #18 待合并 |
| worktree | 主检出 + `nimbleoffice-parity`（活跃）+ wp-r2/wp-r4（WIP，已备份） |
| v3 指标 | 93.61% / 41.80%，18 好 2 差（差为既有误差暴露，见进展文档） |

## 四、留下的待办

1. **v3 门槛裁决**（阻塞发版）：按几何正确性放行（本次会话的建议，证据
   在进展文档），或继续修底层亚磅级算术（多行单元格行高 + 片段底边框，
   fixture 矩阵研磨），或部分修。
2. **按页环绕区模型**：3 条新实测规则的实现（`floating_table_zone.rs` 的
   ignored 测试即验收标准）。
3. **r2 / r4 续作**：WIP 已备份可续；完工后各自单独跑全量验证再逐个合入
   （注意 `engine.rs`/`layout_chars.rs` 冲突与"探针不可混比"警告）。
4. 发版流程照 handoff 五步（打包 → 快进 `finx/0.5` → tag → FinxWork 升级
   → 构建 + e2e 截图）。

## 五、经验教训（本次会话踩的坑）

- **不要并行跑全量对比**：run.py 逐文档阶段无互斥，双进程写同一目录会互相
  覆盖（本次污染过一轮数据后重跑）。跑前 `ps` 确认干净，`WORD_PARITY_NO_EXPORT=1`
  只用缓存 PDF，15 分钟一轮。
- **删数据前先验证**：误删过 v3 run 目录（PDF 缓存随目录丢失）；好在 PDF
  只依赖文档内容与 Word 版本，可从任意完整 run 复用。
- **`python3 -I` 不清 PATH，但 cargo 必须显式给**：`PATH="$HOME/.cargo/bin:$PATH"`。
- **行数指标会惩罚正确的修复**：亚磅级精度 + PDF 网格量化的场景下，
  lineParity 的涨跌要配合几何偏差（首个分歧点 dy）一起读。
