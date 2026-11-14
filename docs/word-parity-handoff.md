# 交接：FinxWork 排版追平 Word

日期：2026-11-08

## 目标与方法

目标是 FinxWork 的 Word 编辑器在排版上全面追平 Microsoft Word。排版引擎是 NimbleOffice fork（`~/betteroffice`，GitHub `Eliseowzy/nimbleoffice`，分支 `finx/0.5`）。

方法：以本机 Word 为标准答案，在一批语料上自动逐行对比，按影响面从大到小逐类修复，每修一类都加回归测试并重跑全量。完整计划见 `~/.claude/plans/word-badcase-composed-torvalds.md`。

## 已完成

### 1. 封面日期跳页（已发版，已在 FinxWork 里使用）
- NimbleOffice `ac5be670`，release `v0.5.1-finx.gac5be670`。改了两处：
  - 网格补出的空白改为上下平分；
  - 只写了 `szCs` 而没有复杂文种字符的行，尾部空白允许伸进底边距。
- FinxWork 已升级到这个版本（`114ba37`），之后又升级到 `ee14ba19`（`fcd4924`）。

### 2. 对照流水线（计划第 1 步）
- 位置：`~/betteroffice-parity`（NimbleOffice 的 worktree，分支 `finx/word-parity`，**只在本地，未推送**）。
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
  1. 在 NimbleOffice 跑 `bun scripts/finx-pack.ts --out /tmp/bo-pack`；
  2. 推送 `finx/0.5`，打 tag，`gh release create`；
  3. 在 FinxWork 里改 `Cargo.toml`、`apps/desktop/package.json`、`pnpm-workspace.yaml` 的版本，运行 `pnpm install` 和 `cargo update`；
  4. `pnpm build`；
  5. 用 e2e 截图验证。注意 e2e 脚本不会自己构建应用。
- NimbleOffice 有一个原本就存在的测试失败：`docx-layout --test chart_snapshots`，和这里的改动无关。

## 下一步

1. **合入 `finx/word-parity` 分支**：rebase 到最新的 `finx/0.5`，推送，把网格修复 `7106dd94` 随下一次发版带上。
2. **做表格边框的对照实验**，修复已知差异的第 1 类，然后重跑全量，记录基线变化。
3. **按上面的顺序**继续处理第 2 到第 8 类。
4. **补充真实中文语料**：论文、公文、合同等，按计划第 2 步扩到 2000 份。

## 新团队接手还缺什么（2026-11-09 补充）

最新进展见 [word-parity-progress.md](word-parity-progress.md)。现有资料能说明"做了什么"，但还不够让新团队"自己跑起来、接着做"。按重要程度：

### 1. 环境只在一台机器上，新团队装不起来
- 语料、Word 导出缓存和各次基线都在 `~/word-parity-data`，不在任何仓库里，也没有重建说明。
  - **待定**：共享位置（内网存储，或单独一个不公开的仓库）；
  - **待定**：哪些文档能共享，哪些真实文档只能本地用。
- Python 环境（`~/tools/word-parity-venv`）、Ghidra（`~/tools/ghidra_12.1.4_PUBLIC`，macOS arm64 的反编译器需要用 gradle 自己编译）、LibreOffice 源码（`~/libreoffice-core`，只拉取了 Writer 部分）都是手工装的，缺一键安装脚本。
- Word 沙盒授权需要人工操作，缺图文步骤说明。第一次导出时，必须在 Word 的"授予文件访问权限"对话框里，分别授权 `~/Documents/word-parity/t.docx` 和 `t.pdf` 这两个文件；这个对话框不能授权文件夹。

### 2. 只能在一台 Mac 上手动跑，没有自动化
- 对比依赖本机 Word，没有接进 CI。应该把"用已缓存的 Word 结果做对比"（`WORD_PARITY_NO_EXPORT=1`）接进 NimbleOffice 的 CI，并设置成"基线下降就拦住合并"。
- Word 升级后要整批重新导出，目前没有人负责、也没有固定节奏。
- **待定**：CI 用什么机器跑，由谁负责更新 Word 导出结果。

### 3. 代码状态分散
- 第二轮有 4 个分支还在各自的工作区，未合并：
  - `claude/wp-r1-table-*`：表格间距、固定行高；
  - `claude/wp-r2-cn-pages-*`：东南大学模板已 40 页，和 Word 一致；国科大模板 44 页（Word 47 页），卡在封面的标点挤压；
  - `claude/wp-r4-small-*`：没有分节设置时的页面默认值；
  - `claude/wp-r5-floats-*`：已提交 `aa9259ab`。

  交接前要么合完发版，要么逐个写清做到了哪里。
- FinxWork PR [#17](https://github.com/finxwork/FinxWork/pull/17) 还没合入 `main`。
- 没写下来的两件事：
  - `finx/word-parity` 和 `finx/0.5` 的关系：前者是工作分支，攒够修复后快进合入后者再发版；
  - fork 和上游 BetterOffice（openooxml/betteroffice）的同步策略。

### 4. 方法上的坑（务必遵守）
- **子会话报告"测试通过"不可信**，合并前必须自己重跑：`cargo test -p nimbleoffice-ooxml-text -p nimbleoffice-docx-layout -p nimbleoffice-docx-edit --no-fail-fast`，只允许既有的 `chart_snapshots` 失败。第一轮有两个会话误报。
- **不同版本探针量出的基线不能直接比**。改了 `layout_chars.rs`、`compare.py` 或 `run.py` 之后，必须用新探针把基线重新量一遍，否则会把探针的改动误算成引擎的提升。
- **字体差异和排版差异要分开看**：看 `layout_chars` 输出里的 `fontFallbacks`。Word 自带字体里没有的字体（如方正小标宋_GBK），属于字体问题，不要在引擎里硬凑。
- **几种 Word 弹框**：
  - 只有"确定"的提示、"只读打开"的选项，看门狗会自动处理；
  - 需要选择的对话框（修复、更新域等）超时 60 秒后跳过，不要替 Word 做选择；
  - 不要退出或重启 Word。
- **多个会话共用一个 Word**：靠 `~/word-parity-data/word.lock` 轮流使用，不要改中转文件名。
- **对比时第一个分歧点最重要**：后面的偏差大多是它连带出来的。逐行一致率偏低属于正常。

### 5. 缺规则知识库
已经量清楚的 Word 规则，现在只记在提交说明和代码注释里，例如：
- 网格行距的 auto 和 atLeast 规则；
- 网格空段落的下限；
- 上下标的 0.65 倍字号和取整；
- 表格内边框的计算；
- 奇偶页分节；
- 尾部空白可以伸进底边距，以及 szCs 的例外。

需要一份规则清单，每条写明：规则内容、Word 实测依据（对应的实验样本和 `word.json`）、代码位置、和 LibreOffice 是否一致，并注明适用的 Word 版本和兼容模式。否则新团队可能重复测量，或者误改已经对齐的行为。

### 6. 缺优先级与验收
- 剩下的差异还没有按"影响多少份文档"排序。需要一份由流水线自动生成的待办清单：按第一个分歧点的类别聚类，再按影响文档数排序。
- 阶段目标（页数一致率 ≥ 95%、逐行完全一致超过一半）还没有定由谁验收、怎么验收。

### 7. 语料代表性不够
497 份里大多是 LibreOffice 的测试文件，真实中文文档只有 6 份。新团队一开始就需要一批有使用授权的真实文档：论文、公文、合同、报告，先扩到 1000 份。

### 建议的补齐顺序
1. 先合完第 3 项的分支，PR #17 定下来。
2. 再写第 4、5 项的文档：坑写进 `tools/word-parity/README.md`，规则清单单独一份。
3. 然后解决第 1 项的环境共享。
4. 最后做第 2 项的 CI。

第 1、2 项要先定共享位置和 CI 机器，第 7 项要先拿到文档授权。
