# 三维能力与医学影像 skill

| 项 | 内容 |
|---|---|
| 版本 | v0.1 |
| 日期 | 2026-11-13 |
| 状态 | 方案已确认，未实现 |
| 关系 | 取代 feat/voxel-phase1-wip 上 voxel-design.md 的设计；该分支的 dicom.rs、import.rs、brick.rs 可复用（§11） |

## 0. 背景与结论

**为什么做**：普通人拿着自己的 CT 和报告，想知道"在哪、多大、要不要紧"。原型证明"三维模型 + 原片 + 对话讲解"这条路走得通，但原型是一次性网页，结果回不到对话里。同时模型越来越擅长三维，三维不该只为医疗服务。

**讨论后的结论**（本方案按这些来，不沿用 `feat/voxel-phase1-wip` 的设计）：

1. **三维是产品的一个通用子能力**，内置；医疗只是它上面的一个场景。
2. **CT 做成 skill**：流程、医学参数、脚本、话术都在 skill 里；三维模块提供"连接内核"的接口。
3. **三维模块同时管网格和体数据**（原片层面），否则 skill 做不了"看原片"和联动。
4. **一期就做可交互的三维**，用 three.js（打进安装包约 0.7～1 MB，按需加载）。不用 Cornerstone3D。
5. **通用算法在内核（Rust），医疗的参数和组合在 skill**；基础建模不需要 Python。
6. 模型写 three.js 代码生成场景，属于"网页预览"，不在本方案内。

**落地方式**：批准后把本方案写成 `docs/desktop/spatial-design.md`（在 `feat/document-editor` 上，不新开分支），再按 §9 分期实现。

---

## 1. 命名

| 谁看到 | 用什么 |
|---|---|
| 用户（界面） | "三维" |
| 模型（工具组、工具名）、配置、crate、协议方法 | `spatial`（`spatial_*`、`[spatial]`、`finx-spatial`、`spatial/*`） |
| skill 里用的 Python 模块 | `finx_spatial` |
| 医疗 skill | 名字 `medical-imaging`，命令 `/ct`（不带 "3d"，以后含 MRI） |

不用 `3d`（数字开头）、`volume`（和磁盘卷、音量混淆）、`voxel`（只指体数据，装不下网格）。

## 2. 分层

```
医学影像 skill（/ct）        以后：工业 CT、牙科、3D 打印检查……各一个 skill
  流程 · 预设 · 建模脚本 · 话术和免责
────────────── skill 接口（§5）──────────────
三维模块（内置、通用，不含任何行业词）
  界面：三维视图（three.js）＋ 原片层面视图 ＋ 结构列表 ＋ 发现卡片
  工具组 spatial：打开、读事实、切层面、统计、标记、测量、发现、转视角、跑脚本
  内核 finx-spatial：格式读取 · 块缓存 · 掩码的测量和网格
  文档库（沿用 DocStore）：修订、撤销、审批、引用
```

检验标准：把医疗 skill 整个删掉，三维模块照样能打开一个 STL、一个 DICOM 文件夹，能看层面、做标记和测量；任何 skill 的脚本交回一个掩码，它都能量出体积、建出网格并显示。

**内核不做分割。**（2026-11 起）怎么把体数据分成结构是行业知识，全部在 skill 的脚本里；内核只提供三种通用数据（体、掩码、网格）的读入、存储、显示和测量。起因见 §5.2。

| 放在三维模块 | 放在 skill |
|---|---|
| zip 安全解压；读 DICOM / NIfTI / STL / OBJ / GLB / PLY（文件格式，不算行业知识） | 选序列的偏好、建哪些结构 |
| 块缓存和金字塔 | 窗位预设、各结构的数值范围和颜色 |
| 掩码的统计和测量、marching cubes、减面；体数据导出给脚本、掩码从脚本导入 | 建模脚本：分割用什么算法、阈值多少、各结构应有多大 |
| 两个视图及联动、引用进对话 | 找结节候选、报告定位的脚本 |
| 发现卡片的形状；来源不可改、免责文字必须显示（界面强制） | 发现的文案、术语解释、免责文字的内容、指南版本 |
| 脚本的运行和隔离 | 说话边界 |

## 3. 数据模型

**一份三维文档**（`DocFormat::Spatial`，沿用 DocStore 的工作副本、修订、撤销）包含若干图层：

| 图层 | 说明 |
|---|---|
| 体数据（0 或 1 个） | 规则网格，带间距、原点、方向矩阵；数值含义是"有标定（带单位）"或"原始灰度" |
| 网格（多个） | 来自文件，或由结构生成；带名字、颜色、细节级别 |
| 结构 | 和体数据同尺寸的标签体里的一个标签；来源是脚本或人 |
| 标记、测量 | 点、长度；数值由内核算 |
| 发现 | 一张可点的卡片：名字、说明、位置、数值、证据、来源、定位用的视角 |
| 档案 profile | skill 提供的显示配置：方位标识、窗位预设、术语解释、免责文字 |

- 原始数据从不修改，所有修改都落在图层上。
- **发现的来源**：`reference`（用户提供的权威材料，医疗里是医生报告）、`ai`、`user`。创建后不能改。界面上三种样式不同、分组显示，只要有 `ai` 来源的发现就显示档案里的免责文字。这两条由模块强制，不靠 skill 自觉。
- **身份**：体数据用"序列号（DICOM 的 SeriesInstanceUID）+ 各层 UID 的哈希"；zip、文件夹、挪了位置都是同一份文档。网格文件用内容哈希。
- **坐标**：内核统一用 DICOM 的 LPS 物理坐标（毫米）；屏幕上的显示惯例由界面负责。

**锚点**（引用进对话、回答里可点的出处）：点（体素或网格表面）、层面框选、部件（结构或网格）、发现、视角。

**存储**：

| 内容 | 位置 | 能删吗 |
|---|---|---|
| 块缓存、生成的网格 | `$FINX_HOME/cache/spatial/<doc_id>/` | 能，随时重建 |
| 图层（结构、标记、发现、脚本留档） | `$FINX_HOME/docs/<doc_id>/` | 不该删 |
| Python 和依赖 | `$FINX_HOME/cache/uv/` | 能 |

**zip 不落盘解压**：直接从 zip 流里读出 DICOM 建块缓存。原文件里有姓名和病历号，不在我们的目录里留副本；读取器也不读身份字段。

## 4. 三维模块

### 4.1 内核 `finx-spatial`（新 crate）

- **读取器**：按文件内容识别（DICOM 看第 128 字节的 `DICM`，不看扩展名）；DICOM 按序列分组、按空间位置排序、检查层间距、每层各自换算数值、认出视野外填充；zip 的越界路径、符号链接、压缩炸弹、GBK 文件名、加密包都按不可信输入处理。
- **块缓存**：64³ 的块，多级金字塔，每块 zstd 压缩，写完再改名。医疗 CT 只用到小规模，但接口按块按级，以后大数据不用重来。
- **掩码和网格**：掩码的体积、直径、数值统计，长度测量，marching cubes，减面（多个细节级别）。分割算法不在内核里（§5.2）。
- **给模型看的图**：按任意方向切层面出 PNG，带比例尺、方位、层号的文字说明。
- 长任务（建缓存、分割、网格）放在单独的 worker 进程里，有进度、可取消，做法照 `crates/finx-docs/src/worker.rs`。

### 4.2 界面 `SpatialView`

```
┌ 标题 · 换序列                                         更多 ▾ ┐
│ ┌结构┐ ┌───────── 三维（three.js）────────┐ ┌─ 原片 ─────┐ │
│ │☑ … │ │  半透明外层 + 内部结构 + 发现光圈   │ │  当前层面   │ │
│ │☑ … │ │  当前层面的平面（贴着原片）         │ │  窗位 读数  │ │
│ └────┘ │  [正面][侧面]  方位小人             │ └────────────┘ │
│        └──────────────────────────────────┘  发现卡片（分组）│
│ 层面 ━━━━━━━○━━━━（每个发现一个刻度）                          │
│ 免责文字（有 AI 发现时）                                        │
└──────────────────────────────────────────────────────────────┘
```

- 只有网格时（打开 STL）：只显示三维和部件列表。只有体数据、还没建模时：原片占满。
- 一种布局，不分导览 / 对照 / 专业三种模式；原片可以拉宽。布局由面板组成，以后加专业模式是加一份配置。
- three.js 打进安装包，按需加载（和 `docs/pdf.ts` 的做法一样），不走 CDN。
- 块和网格用二进制经 `finxdoc://` 传输，不用 base64。
- 修掉原型的问题：发现按真实大小画，外加不随缩放变化的光圈；层面平面只画在身体范围内并贴上原片；角上有方位标识；滑块上有发现的刻度。
- 用户的操作（标记、测量）先变成文档操作交给内核，内核写进修订后再显示，状态以内核为准。
- 智能体新加的发现只闪一下，不抢用户的视角。

### 4.3 工具组 `spatial`

按需加载的内置工具组，和 `doc`、`browser` 并列（`crates/finx-core/src/deferred.rs` 的 `Deferred::of`），平时在目录里只占一行。

| 工具 | 做什么 |
|---|---|
| `spatial_open` | 打开文件、文件夹或 zip，在对话旁边显示，返回事实 |
| `spatial_info` | 尺寸、间距、层厚、方向、单位、序列表、已有图层 |
| `spatial_slice` | 一层或相邻几层拼成一张图，可围绕一点放大 |
| `spatial_stats` | 一个区域或结构的体积、数值分布、最大径 |
| `spatial_mark` / `spatial_measure` / `spatial_finding` | 标记、测量、发现 |
| `spatial_view` | 让用户的画面转到某个发现、部件或层面 |
| `spatial_snapshot` | 把当前三维画面截一张图给模型看（只在桌面端连着时可用） |
| `spatial_script` | 跑脚本（§5.3） |

原则：**事实由内核给，判断由模型做**；**找东西靠计算，图片只用来核对**。

### 4.4 开关

- 打开三维文件（STL、GLB、DICOM）不需要开关，和 PDF 预览一样。
- 工具组默认开，设置的"三维"里可以关。
- 医疗能力的开关就是 skill 的启用和停用。

## 5. skill 接口：三维模块怎么"连接内核"

skill 通过三样东西使用三维模块，都不需要改内核。

### 5.1 工具

skill 的 `SKILL.md` 教模型按什么顺序调用 §4.3 的工具。

### 5.2 建模：skill 的脚本交回掩码

一期曾用"配方"建模：skill 里一个 JSON 文件列出步骤，内核用 Rust 实现的十来种算子（阈值、连通域、形态学、按左右切分……）逐步执行。2026-11 整个去掉了，原因：

- 算子名义上通用，实际带着行业假设。`split_side`（按左右切分）在两肺前方粘连时把整块算成右肺、把一小块碎片当成左肺，助手据此告诉用户"左肺几乎不含气，建议尽快就医"。修它就得把"两肺会粘连"写进内核。
- 每遇到一种新片子都要改内核、发版；而脚本这条路（§5.3）本来就在，等于维护两套分割。

现在的约定：

- **skill 的脚本做分割**，经 `spatial_script` 运行，用 `finx_spatial.submit.structure(mask, id, name, color, opacity, hidden, expect_ml, notes)` 交回掩码，用 `submit.profile(...)` 交显示配置（方位标注、单位、窗位预设、免责文字）。
- **内核对每个交回的掩码**：量体积和直径、建网格（`hidden` 的只留掩码供后续脚本用）、存进文档，并做三项与行业无关的检查：是否为空、体积是否在脚本给的 `expect_ml` 之内、是否顶到扫描范围的头脚两端。不通过的在返回里标 `UNRELIABLE`。"肺该多大"这类数字由脚本给，内核不内置。
- **防卡死仍由内核兜底**：脚本有时限、无网络、只能写工作目录；网格有面数上限。
- **代价**：没有 Python 环境时看不到三维模型（原片、标记、测量照常）。第一次建模要先装好脚本环境。

### 5.3 脚本（复杂计算才用）

- 用 uv 运行：应用只带 `uv`，skill 带 `pyproject.toml` 和 `uv.lock`，Python 和依赖第一次用时下载（默认国内镜像，失败退回官方源）。
- 脚本通过 `finx_spatial` 读数组（内存映射块缓存，间距和方向用内核的值）、提交结构 / 标记 / 候选；内核把提交换成文档操作，进修订。
- **两类脚本，信任方式不同**：
  - skill 自带的脚本：按 skill 整体信任，启用 skill 时确认一次，之后不逐次询问；
  - 模型临时写的脚本：按权限模式审批，卡片上先给一句大白话说明，再给全文。
- **隔离**：分两步。先 `uv sync` 装依赖（联网，不跑脚本）；再 `uv run --offline` 跑脚本，用 macOS 的 `sandbox-exec` 禁掉网络、只允许写临时目录。这样"数据不出本机"是强制的，不是约定。
- 每次运行的脚本和结果留档，发现上写明来自哪次运行。

## 6. 医学影像 skill

```
medical-imaging/
  SKILL.md            流程、先验知识、说话边界、不能看图时怎么办
  scripts/            chest_structures.py（体表、双肺、气道、肺血管、骨骼）、
                      lung_nodule_candidates.py、locate_report_item.py
  pyproject.toml, uv.lock
  references/         术语解释（中英）、指南（Fleischner 2017、Lung-RADS v2022）
```

**主流程**：

1. 用户 `/ct` 加附上 zip（或只附 zip，模型按描述自己用上 skill）。
2. `spatial_open`：选出层最薄的可用序列，说明理由；原片先显示出来。
3. `spatial_script` 跑 `scripts/chest_structures.py`：建出各结构，内核量好并显示。
4. 问一句有没有诊断报告（文字、照片、PDF）。
5. 有报告：拆成条目让用户确认，逐条用脚本在体数据里找对应位置，再用 `spatial_slice` 核对，生成 `reference` 来源的发现。找不到就照实说，不硬标。
6. 没有报告或要补充：跑候选脚本，核对后生成 `ai` 来源的发现（这一路受 §8 的合规限制）。
7. 用户在模型上点一处或点发现卡片，带进对话接着问。

**说话边界**：报告和 AI 观察分开说；不说确诊、排除，不给治疗建议；引用指南只用列出的版本并注明以医生为准；需要尽快就医的情况明说。

**分发**：先作为内置 skill（`crates/finx-core/src/skills/system/`，默认停用），在拖入 DICOM 的文件卡片上和"自定义"里启用。AI 检出脚本在合规结论出来前不随公开版本分发。

## 7. 入口

- 文件面板：`.stl`、`.obj`、`.glb`、`.ply` 直接打开；含 DICOM 的文件夹或 zip 显示成"影像检查"（`apps/desktop/src/renderer/src/files/kind.ts`）。
- 打开影像检查时，如果医疗 skill 没启用，在页面上提示"启用医学影像"，一点就开。
- 输入 `/ct`。

## 8. 隐私与合规

- 原始数据不出本机；发给模型的只有层面图、数值和用户自己给的报告内容。第一次发层面图时提示一次。
- 报告照片上常有姓名，附上前提示遮挡；图层里只存所见和结论的文字。
- 截屏类序列像素里印着姓名，默认不选、不发给模型。
- **要现在就问法务的三件事**：AI 检出是否算医疗器械；"按指南一般多久复查"这类话能不能说；分发医疗 skill 的方式有没有限制。结论会改变一期范围。
- AI 检出的限制不能靠本地配置项，靠"脚本不随公开版本分发"来实现。

## 9. 分期

| 期 | 内容 | 完成的标志 |
|---|---|---|
| 零：验证 | three.js 在 Electron 里显示 20 万三角形的网格；Rust 的 marching cubes 加减面的时间和质量；胸部配方在两份真实样本上的效果；`sandbox-exec` 加 `uv run --offline` 能否跑通 | 四项有结论，不过关的改方案 |
| 一：三维查看 | 文件面板打开 STL / OBJ / GLB / PLY；旋转、剖切、选部件；部件和视角引用进对话；`spatial_open`、`spatial_info`、`spatial_view`、`spatial_snapshot` | 拖进一个 STL，选中一个部件问"这是什么"，回答里的出处点了能转过去 |
| 二：体数据 | zip / 文件夹导入、块缓存、原片视图、两个视图联动；掩码的测量和网格；标记、测量、发现 | 合成体模的 zip：原片 2 秒内出来，建模脚本建出体表、肺、血管，层面平面和原片对得上 |
| 三：医学影像 skill | `SKILL.md`、胸部建模脚本、报告定位脚本、`spatial_script` 和隔离；文件卡片上的启用提示 | §10 的端到端通过 |
| 四：以后 | AI 检出按合规结论开放；导出 STL / GLB；专业模式；第二个行业 skill | 另定 |

每一期结束都是可以单独发布的状态。

## 10. 验证

- **单元测试**：读取器（分组、排序、方向、数值换算与参考实现逐像素一致）、块缓存、测量和网格的已知结果（球的体积、立方体的网格）、脚本提交的逐行校验、zip 的各种恶意构造。
- **合成体模**：用程序生成一份胸部 CT 的 DICOM zip（含一个已知位置和大小的磨玻璃结节），自动测试和演示都用它，不用任何人的片子。
- **端到端**（`pnpm dev`，独立的 `FINX_HOME`）：
  1. 附上体模 zip，输入 `/ct 报告说右肺有个磨玻璃结节，在哪？`；
  2. 原片先出现，结构陆续出现；
  3. 生成一条报告来源的发现，点"定位"转到结节，点"看原片"跳到对应层；
  4. 点"问一问"追问"需要担心吗"，回答不出现确诊、排除、治疗建议；
  5. 撤销发现、关掉再打开，状态正确；
  6. 构造一条报告里有、图像里没有的结论，回答照实说没找到。
- **真实样本**：`47085165`、`47083958` 只在本机手工验收，不进仓库。
- **隔离**：脚本里尝试联网和写临时目录之外的文件，都被拒绝。
- **普通用户试用**：找几位没有医学背景的人，只说一句"看看报告说的结节在哪"，记录卡在哪。
- 改了 `crates/` 后 `cargo build --bin finx`；截图前 `pnpm build`。

## 11. 复用现有的东西

| 现有 | 用来做什么 |
|---|---|
| `crates/finx-docs/src/store.rs`、`kind.rs` | 文档库、格式识别，加一种 `Spatial` |
| `crates/finx-docs/src/worker.rs` | worker 进程的做法 |
| `crates/finx-core/src/deferred.rs` | 加 `spatial` 工具组 |
| `crates/finx-core/src/skills/system/`、`bundle.rs` | 内置 skill 的存放和写出 |
| `crates/finx-protocol/src/doc.rs` → `packages/protocol` | 锚点、操作的协议扩展 |
| `apps/desktop/src/main/docs.ts`、`doc-tokens.ts` | `finxdoc://` 二进制通道 |
| `apps/desktop/src/renderer/src/docs/pdf.ts` | 按需加载视图的做法 |
| `apps/desktop/scripts/build-app.mjs` | 把 `uv` 打进安装包 |
| `feat/voxel-phase1-wip` 上的 `dicom.rs`、`import.rs`、`brick.rs` | 设计不沿用，但这三份代码已用真实样本验证过，实现时可以直接搬过来改名 |

## 12. 风险与待定

| 项 | 说明 |
|---|---|
| 建模依赖脚本环境 | 没有 Python 环境就没有三维模型；环境怎么来（随包带 uv 并按需下载 Python，还是用用户机器上的 Python）见 §5.3 |
| 减面质量 | Rust 的减面库效果不好时，网格会很大或有破洞，零期验证 |
| 第一次用脚本要下载一百多 MB | 基础建模不依赖它；开始前在对话里说明大小 |
| `sandbox-exec` | macOS 上已标为过时但仍可用；Windows、Linux 以后另找办法 |
| skill 可被用户改 | 来源不可改、免责文字显示由模块强制；话术本身管不住，写进合规咨询 |
| 模型不能看图 | 照样建模、算候选，跳过核对并写明"未经图像核对" |

## 13. 第二波的接口约定（实现用）

**文档**：`DocFormat::Spatial`。`DocInfo.spatial`：
```
{ kind: "volume" | "mesh",
  volume?: { dims, spacing, origin, direction, unit?, levels, series: [{uid,description,slices,spacing_mm,usable,reason}], picked, reason },
  meshes: [{ id, name, color, opacity, source: "file"|"structure", lods: number }],
  structures: [{ id, name, color, opacity, hidden, stats: {volume_mm3, max_diameter_mm, centroid} }],
  findings: [{ id, name, summary, source: "reference"|"ai"|"user", report_item?, position_mm?, radius_mm?, measures, evidence, view? }],
  markers: [{ id, position_mm, label, source }],
  profile?: { orientation, unit, windows: [[name,width,level]], disclaimer } }
```
**DocOp 新变体**：`SpatialStructure`（来自脚本，含掩码路径）、`SpatialMarker`、`SpatialMeasure`、`SpatialFinding`（来源创建后不能改）、`SpatialProfile`。

**锚点新变体**：`SpatialPoint{position_mm}`、`SpatialSlice{plane,index,rect?}`、`SpatialPart{id}`、`SpatialFinding{id}`、`SpatialView{camera,slice}`。

**finxdoc:// 路径**（主进程只按令牌转发、支持 Range）：
- `finxdoc://<token>/spatial/index.json`：块缓存索引（沿用 brick.rs 的格式）
- `finxdoc://<token>/spatial/bricks.bin`
- `finxdoc://<token>/spatial/mesh/<id>/<lod>.bin`：mesh.rs 的二进制格式（FXMS 头）

**界面 → 内核**：`spatial/view` 事件（智能体要求转视角）由内核推送；用户的标记、测量走 `doc/ops`。

**脚本**：内核在临时目录里放 `volume.npy`（int16，形状 k,j,i）、`meta.json`（spacing、origin、direction、单位、各层图像号、k 是否朝头）、`masks/<id>.npy`（bool）；脚本通过 `finx_spatial` 读这些，提交写到 `out/submit.jsonl`（每行一个 `{type: candidate|marker|structure|finding, ...}`，structure 附 `mask` 的 .npy 路径）。内核读回、校验、换成 DocOp。
