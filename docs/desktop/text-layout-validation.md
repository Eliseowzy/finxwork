# PPTX 文字布局子系统

## 运行与验收

`pnpm --dir apps/desktop e2e:pptx-text` 使用真实字体 RPC、生产编辑器和独立 Electron 窗口。需要 macOS、本机字体、Electron 运行时及已构建的 `target/debug/finx`。通过 `FINXWORK_E2E_SHOTS` 固定输出目录。

可附加用户回归样本：`FINXWORK_E2E_TEXT_LAYOUT_SAMPLE=/path/sample-presentation.pptx pnpm --dir apps/desktop e2e:pptx-text`。该用例在临时副本中把第二页移到首位，并去掉标题中已经错误保存为 18 磅的后续段落，再执行 44 磅标题的回车与输入；原文件不会被修改。

测试使用包含完整母版、主题和关系部件的 `crates/finx-slide/tests/fixtures/text-layout.pptx`。基础模板可用 `tools/ppt-corpus/make-layout-fixture.py` 重建（需要 python-pptx）；日常测试的变体生成只依赖 Python 标准库。

每个场景重置文档。失败后继续收集其他场景，任一断言失败时命令返回非零。输出包括逐项截图、保存后的 PPTX、模型快照及 `text-layout-report.json`。

| 检查 | 证据 |
| --- | --- |
| 中文缺字后备 | 连续 IME 提交后，画布墨迹宽度按字符数量增长，保存文字精确一致 |
| 编辑与重开一致 | 同一机器上，重开前后墨迹宽高误差不超过两个画布像素 |
| 段首、段中、段尾拆分 | 工具栏、新输入的实际保存字号、段落居中及重开结果均正确 |
| 连续空段落 | 快速连续回车产生四段，空段落在保存重开后仍保留 44 磅输入格式 |
| Enter 与 Shift+Enter | 普通回车产生段落；软换行保存为 a:br，保持一个段落 |
| 选区替换、组合输入取消 | 无重复、丢字或意外修改，格式保持 |
| 自动换行 | 视觉上出现多行，文档仍为一个段落，重开布局一致 |
| 项目符号 | 拆分后保留层级、缩进、悬挂及项目符号 |
| 母版与占位符继承 | 验证有效的 44 磅与居中，同时允许原文保持继承而非强制写成显式值 |
| 表格单元格 | 单元格内段落拆分、字号、对齐与重开正确 |
| 混合字号交界 | 拆分前后的插入格式一致，新输入保存为对应字号 |
| 撤销重做 | 等待实际文档变更；撤销必须改变模型，重做恢复文字与格式 |

## 状态与构建

引擎拆分前解析光标处的有效文字样式，复制适用的段落属性并保留原始段落 XML，使缩进、间距、制表位等不因模型未显式承载而丢失。空段落的输入样式保存在编辑模型中，并在保存时写出 endParaRPr。UI、后续输入和保存使用该状态。

桌面保存先排空输入，再比较实际序列化字节与已保存版本。即使 UI 的变更通知稍晚到达，也不会漏掉输入后立即保存的内容；迟到的通知不会导致重复写盘。

引擎的 JS 包和 WASM 都从我们的 fork 一起构建，版本号带 fork 提交号，修复直接提交在 fork 源码里，不再给发行包打补丁。构建、发布和本地迭代见 [betteroffice-fork.md](betteroffice-fork.md)。

## 交叉验证与边界

PowerPoint 已正常打开回归测试保存的完整 PPTX，无修复提示；选中文本框时字号为 44，居中开启。该验证未修改原文件。

另外对文字、文字布局、中文、项目符号、表格和主题六份现有测试稿共 19 页完成渲染，并与 PowerPoint 基准图生成差异图。像素差异仍存在，尤其某些表格样式；这些结果是保真度测量，不能当作像素级兼容通过。中文宽度断言也只证明指定环境中的一致性。

当前验证不等价于支持所有 Office 文字行为。阿拉伯文/双向文字、Emoji、组合字符、竖排和复杂自动缩放尚无专门端到端验收；项目符号空行退出、编号重启等编辑规则也需按具体产品语义增加用例。底层现有解析、保存、并发和表格测试继续保留，不能用放宽断言或跳过失败替代修复。

## 最终回归（2026-11-06 复验）

文字布局修复后，对交付前剩余的标准编辑、矢量图片、生产构建和单元测试做了补充验证。命令均在本机 macOS 执行：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 桌面单元测试 | `pnpm --dir apps/desktop test` | 128 通过，0 失败 |
| 标准编辑回归 | `FINXWORK_E2E_NATIVE=1 pnpm --dir apps/desktop e2e:pptx` | PASS：画布绘制、键盘文字编辑、形状拖动、保存重开、面板重挂载 |
| 矢量图片回归 | `FINXWORK_E2E_NATIVE=1 FINXWORK_E2E_VECTOR=1 pnpm --dir apps/desktop e2e:pptx` | PASS：EMF 图表绘制、保存重开、原 EMF 与 OLE 字节不变 |
| 文字布局端到端 | `pnpm --dir apps/desktop e2e:pptx-text` | 14 项全部通过（场景见上表） |
| 生产构建 | `FINXWORK_DESKTOP_OUT=<out> pnpm --dir apps/desktop build` | 成功，产物约 28 MB |
| 类型检查 | `pnpm --dir apps/desktop typecheck` | 通过，无诊断输出 |
| 引擎底层测试 | `cargo test -p betteroffice-pptx-edit -p betteroffice-pptx-parse --offline` | 697 通过，0 失败 |
| 工作区校验 | `git diff --check` | 无空白错误 |

此前记录的两项失败，本次确认属于运行环境限制，不是产品缺陷：

- 桌面单元测试在受限沙箱中曾因 `listen EPERM: operation not permitted 127.0.0.1` 失败；允许监听本机回环端口后，128 项全部通过，内核服务启动类用例也恢复。
- 端到端测试若在本机 Electron 应用派生的 shell 中运行，会继承 `ELECTRON_RUN_AS_NODE=1`，使 Electron 退化为 Node 并报 `require('electron')` 缺少 `app`；以 `env -u ELECTRON_RUN_AS_NODE` 启动即可。

本轮未改动引擎或产品代码路径，只补充了验证执行与上述文档记录。全部改动仍在工作区、尚未提交。
