# 交接：FinxWork 排版追平 Word

日期：2026-11-08

## 目标与方法

目标是 FinxWork 的 Word 编辑器在排版上全面追平 Microsoft Word。排版引擎是 BetterOffice fork（`~/betteroffice`，GitHub `Eliseowzy/betteroffice`，分支 `finx/0.5`）。

方法：以本机 Word 为标准答案，在一批语料上自动逐行对比，按影响面从大到小逐类修复，每修一类都加回归测试并重跑全量。完整计划见 `~/.claude/plans/word-badcase-composed-torvalds.md`。

## 已完成

### 1. 封面日期跳页（已发版，已在 FinxWork 里使用）
- BetterOffice `ac5be670`，release `v0.5.1-finx.gac5be670`。改了两处：
  - 网格补出的空白改为上下平分；
  - 只写了 `szCs` 而没有复杂文种字符的行，尾部空白允许伸进底边距。
- FinxWork 已升级到这个版本（`114ba37`），之后又升级到 `ee14ba19`（`fcd4924`）。

### 2. 对照流水线（计划第 1 步）
- 位置：`~/betteroffice-parity`（BetterOffice 的 worktree，分支 `finx/word-parity`，**只在本地，未推送**）。
- 提交：
  - `291a1d5c`：流水线本体；
  - `7106dd94`：网格修复，见下一节；
  - `5ff04d89`：流水线的稳健性修复。
- 文件，全部在 `tools/word-parity/`，用法见同目录 `README.md`：
  - `word_export.py`：让本机 Word 批量导出 PDF，按文件内容哈希缓存。
  - `word_lines.py`：从 PDF 里取出每一行的位置。
  - `fonts.py`：给 Word 自带字体建索引，让引擎用和 Word 相同的字体测量。
  - `crates/docx-edit/examples/layout_chars.rs`：引擎侧输出每个字的位置。
  - `compare.py`：按文字把两边的行对齐打分，找出第一个分歧点。
  - `run.py`：一条命令跑完整个语料。
- 运行：

```bash
cd ~/betteroffice-parity && python3 -I tools/word-parity/run.py /tmp/wp-out /tmp/wp-corpus /tmp/wp-corpus2
```

  加上 `WORD_PARITY_NO_EXPORT=1` 则只用已缓存的 PDF 做对比，不需要 Word，十几分钟跑完。

### 3. 第一处用流水线发现并修复的差异
- `7106dd94`：网格上的空段落，先套 1.15 倍字号的下限，再对齐网格。用 Word 真字体排论文封面时，14pt 空段落 Word 算 2 行网格，我们原来算成 16.1pt。
- 带回归测试 `grid_snaps_an_empty_paragraph_after_its_floor`，撤掉修复时测试会失败。
- **未推送、未发版。**

## 当前基线（497 份语料）

| 指标 | 结果 |
| --- | --- |
| 可对比 | 479 份（18 份 Word 无法导出） |
| 页数一致 | 92.1% |
| 逐行完全一致 | 171 份（36%） |
| 平均逐行一致率 | 38.3%（第一个偏差会连带后面所有行，所以偏低） |

汇总在 `/tmp/wp-out/summary.json`，每份文档的明细在 `/tmp/wp-out/<sha256>.cmp.json`。

## 已知差异（按建议的修复顺序）

1. **表格内文字偏 -0.54pt**（约 7 份）：
   - 偏差随边框粗细变化：0.5pt 边框偏 0.54pt，3pt 边框（`tbl-border24`）偏 1.83pt。
   - 疑似单元格边框、上边距推开文字的算法不同。
   - 下一步：做对照实验，变量包括边框粗细、单元格边距、兼容模式 14/15、是否首行。参考 LibreOffice 的表格代码，在 `~/libreoffice-core`（只拉取了 Writer 部分）。
2. **偏 -1.04pt**（约 6 份，多为 11pt 表格）：先确认是不是第 1 类的另一种表现。
3. **脚注 +0.69pt**（3 份）：脚注编号的上标位置不对。
4. **奇偶页分节自动插入的空白页**：引擎在空白页上画了页码，Word 的这一页是全空的。论文模板修完封面后，第一个分歧点就是这里。
5. **默认字体**：没有 `styles.xml` 的文档，中文版 Word 默认用等线 11pt，应用默认用 Calibri 11pt（`packages/docx/src/layout/measure/rustMeasureSource.ts`）。只影响人造文档，优先级低。
6. **大偏差**：浮动表格、文本框、页眉等，几十 pt 的偏差，需要逐个看。
7. **真实中文文档差得最多**：
   - 国科大学位论文模板：Word 47 页，引擎 42 页；
   - 杭州政府信息公开申请表：Word 2 页，引擎 1 页；
   - 东南大学论文模板：Word 40 页，引擎 41 页。
8. **网格行距规则与 LibreOffice 有两处分歧**，待用 Word 实测裁决：
   - 网格上的 atLeast（最小值）行距要不要吸附网格；
   - 小于 1 倍的行距在网格上能不能缩小。

## 环境与注意事项

- **Word 的沙盒**：Word 只能访问已授权的 `~/Documents/word-parity/t.docx` 和 `t.pdf` 两个文件，导出脚本会把每份文档复制成这个名字再导出。不要改文件名，否则会触发需要手动点的授权框。授权对话框只能授权单个文件，不能授权文件夹。
- **Word 的弹框**：
  - 看门狗会自动点掉只有"确定"的提示，以及"只读打开"的选项；
  - 其余需要选择的弹框会在 60 秒后超时跳过。
  - 不要让脚本退出或重启 Word，用户可能开着自己的文档。
- **语料**：
  - `/tmp/wp-corpus`：99 份，仓库里的测试样本加东南大学论文模板；
  - `/tmp/wp-corpus2`：398 份，主要是 LibreOffice 测试数据，另有 `~/Downloads` 里的模板和 OnlyOffice 模板。
  - 语料和缓存都在 `/tmp` 下，重启电脑会丢失，要长期保留需要挪走。真实用户文档只在本地对比，不要提交进仓库。
- **工具**：
  - Python 虚拟环境 `~/tools/word-parity-venv`（pdfplumber、fonttools）；
  - Ghidra 12.1.4 在 `~/tools/ghidra_12.1.4_PUBLIC`；
  - Word 16.114 的分析工程在 `~/tools/ghidra-projects/word`，脚本在 `~/tools/ghidra-scripts`。已知网格行距的内部编号是 sprm 0x9031，存在节属性偏移 0x68。静态逆向效率低，只在实验解释不了时才用。
- **发版流程**（同 `ac5be670`）：
  1. 在 BetterOffice 跑 `bun scripts/finx-pack.ts --out /tmp/bo-pack`；
  2. 推送 `finx/0.5`，打 tag，`gh release create`；
  3. 在 FinxWork 里改 `Cargo.toml`、`apps/desktop/package.json`、`pnpm-workspace.yaml` 的版本，运行 `pnpm install` 和 `cargo update`；
  4. `pnpm build`；
  5. 用 e2e 截图验证。注意 e2e 脚本不会自己构建应用。
- BetterOffice 有一个原本就存在的测试失败：`docx-layout --test chart_snapshots`，和这里的改动无关。

## 下一步

1. **合入 `finx/word-parity` 分支**：rebase 到最新的 `finx/0.5`，推送，把网格修复 `7106dd94` 随下一次发版带上。
2. **做表格边框的对照实验**，修复已知差异的第 1 类，然后重跑全量，记录基线变化。
3. **按上面的顺序**继续处理第 2 到第 8 类。
4. **补充真实中文语料**：论文、公文、合同等，按计划第 2 步扩到 2000 份。
