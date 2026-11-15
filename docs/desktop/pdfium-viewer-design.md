# PDF 显示改用自带 PDFium

| 项 | 内容 |
|---|---|
| 版本 | v0.2（构思稿）。v0.2：评审修订——锚点仍用矩形、序号只在界面内用（PV-05 改）；Chrome 对标改为人眼无差别（G1）；补表单绘制、渐进渲染、取消、改动竞态、崩溃归属、参数校验、搜索让路、内存与 DOM 等坑；工作量上调 |
| 日期 | 2026-11-07 |
| 状态 | 讨论中，未实现 |
| 关系 | 修订 document-editor-design.md §7.3（PDF 画布用 pdf.js）。内核侧沿用 §9.1 的引擎分工、§9.4.8 的 worker 隔离；页面字节的安全约束沿用 §7.3 的 `finxdoc://` 令牌 |

## 目录

- 0. 阅读说明
- 1. 背景与目标
- 2. 设计原则
- 3. 总体架构
- 4. 页面渲染
- 5. 传输
- 6. 文字层：选区、复制、搜索、定位高亮
- 7. 前端组件
- 8. 与 pdf.js 对比
- 9. 风险与对策
- 10. 分期与工作量
- 11. 决策与待定问题

## 0. 阅读说明

| 术语 | 定义 |
|---|---|
| worker | `finx-doc-worker` 进程，跑 `crates/finx-docs/src/engine.rs`，唯一加载 PDFium 的地方 |
| 渲染 worker | 本方案新增：由 Electron 主进程直接拉起的一个 worker 实例，只做显示用的渲染和文字几何 |
| 图块（tile） | 页面在某一缩放档下切成的 512×512 设备像素方块 |
| 缩放档 | 把连续缩放归到的离散倍率（见 §4.3），图块按档缓存 |
| 页坐标 | PDF 用户空间，单位 pt，原点左下；界面坐标原点左上，单位 CSS px |
| DPR | `window.devicePixelRatio`，Retina 屏为 2 |

## 1. 背景与目标

### 1.1 现状

- 文档栏的 PDF 由渲染进程里的 pdf.js（pdfjs-dist 5.4.394）显示：`PDFViewer` 负责布局与按需渲染，文字层负责选择、复制、搜索（`apps/desktop/src/renderer/src/docs/PdfView.tsx`、`pdf.ts`）。
- 字节经 `finxdoc://<token>/current.pdf` 按 Range 读取（`apps/desktop/src/main/docs.ts`）。
- 内核已打包 PDFium（chromium/8076，`Contents/Frameworks/libpdfium.dylib`），worker 已有 `Render`（整页渲染后裁剪，PNG + base64，经 JSON 行返回）和 `Chars`（逐字框）两个请求，供智能体读页、截区域图用。

### 1.2 问题

1. **选区像马赛克**：pdf.js 文字层是一堆绝对定位的透明 `<span>`，浏览器原生选区按 span 画蓝底，span 之间有缝、高低不齐、行距处断开。Chrome 自带 PDF 查看器（同为 PDFium）按行合并成整块，观感差距明显。
2. **两个引擎看到的文字不一样**（design §9.4.1）：显示用 pdf.js，锚点和智能体读取用 PDFium，选区要再经 `doc/resolve` 换算，边角情况（连字、竖排、隐形文字）两边不一致。
3. **界面受制于 pdf.js**：选区、搜索高亮、批注层都要绕着 `PDFViewer` 的 DOM 和事件总线做，难以完全自定义。
4. 渲染质量与 Chrome 不同源：字体回退、细线、透明组的效果和"用 Chrome 打开"不一样。

### 1.3 目标

| 编号 | 目标 | 过关标准 |
|---|---|---|
| G1 | 渲染与 Chrome 同级 | 固定样张集上与 Chrome PDF 查看器并排对比，人眼无明显差别；样张截图入回归测试。注意：Chrome 里的 PDFium 用 Skia 后端、版本随 Chrome，我们用 pdfium-binaries 的 AGG 后端，抗锯齿与细线有系统性差别，逐像素一致不可能，也不作为目标 |
| G2 | 选区按行合并成整块 | 同一行连续选中的字画成一个矩形，行间无缝；视觉对标 Chrome |
| G3 | 流畅 | 500 页 / 53 MB 年报：首屏 < 300 ms；滚动 60 fps 不白屏（先出低清再出高清）；缩放手势中不卡 |
| G4 | 显示、锚点、智能体读取都用 PDFium 文字 | 界面选区与内核读到的字出自同一引擎，`doc/resolve` 换算不再因引擎差异出错；锚点格式不变（§6.1） |
| G5 | 保留现有工具栏 | 目录、缩略图、页码、缩放、搜索、区域工具、批注卡片行为不变 |

### 1.4 不在本方案

- 表单填写（AcroForm 交互输入）：一期只显示表单外观（`render_form_data(true)`），不做可编辑控件。pdf.js 现在 `ENABLE_FORMS` 能填，见 §9 R6。
- 改正文文字（design §9.3）。
- 打印。

## 2. 设计原则

1. **PDFium 只在 worker 里**（§9.4.8 不变）：渲染进程拿到的只有位图和几何数据，拿不到 PDF 字节，也不跑任何 PDF 解析代码。安全面比现在（渲染进程里跑 pdf.js 解析不可信 PDF）更小。
2. **显示通道与智能体通道分开**：显示渲染量大、要抢占取消，不能和 `finx serve` 里智能体的 `doc_read`、`Render` 排同一个队；所以显示用独立的渲染 worker（§3）。
3. **位图走二进制，不走 JSON**：base64 PNG 经 JSON 行对显示来说太慢（§5.1）。
4. **文字几何一次取、前端算**：一页的字框一次给到前端，命中测试、选区合并、搜索高亮都在前端做，不必每次拖动都往返进程。
5. **先糊后清**：任何时刻屏上都有东西，宁可先放大旧图块，也不留白。

## 3. 总体架构

```
渲染进程 (PdfCanvas)                 主进程                            渲染 worker (finx-doc-worker --view)
┌──────────────────────┐   fetch   ┌─────────────────────┐ stdin/stdout ┌────────────────────────────┐
│ <img>/<canvas> 图块   │ ────────▶ │ finxdoc://<token>/   │ ───────────▶ │ PDFium：FPDF_RenderPageBitmap│
│ 选区/搜索/批注覆盖层   │ ◀──────── │   tile|text|info     │ ◀─────────── │ FPDFText_*、书签、链接       │
└──────────────────────┘  二进制    │ 令牌→工作副本路径     │  长度前缀帧   └────────────────────────────┘
                                    │ 请求排队/取消/LRU     │
                                    └─────────────────────┘
finx serve 里的 worker 不变：智能体 doc_read、Render、批注写入照旧。
```

- 主进程按需拉起**一个**渲染 worker（同一个二进制，加 `--view` 启动参数），所有打开的 PDF 共用；崩溃后自动重启并让前端重取在屏图块。
- 令牌解析沿用 `doc-tokens.ts`：主进程把令牌换成工作副本路径交给 worker 打开，页面仍拿不到路径。
- 修改后刷新：内核提交成功会推送 `doc/changed`（design §9.4.2）。主进程收到后让渲染 worker 重新打开该文件（`FPDF_LoadDocument` 对 53 MB 文件 2 ms），并作废该文档的图块缓存版本号；前端只重取受影响页。
- **改动竞态**：内核增量保存时文件正在追加，渲染 worker 此刻重开可能读到半份。规则：只在收到带新 `rev` 的 `doc/changed`（内核在保存落盘、`fsync` 之后才发）时重开；内核写 `current.pdf` 一律先写临时文件再原子改名（若现有增量追加不是这样，需内核配合改，列入 1 期）。重开失败时保留旧句柄继续显示，稍后重试。

> 为什么不复用 `finx serve` 的 worker：那条通道是 JSON 行、一问一答、不能取消，且和智能体请求排队。为什么不在主进程里直接链接 PDFium（N-API）：PDFium 非线程安全且会崩，崩在主进程就是整个应用退出，违背 §9.4.8。

## 4. 页面渲染

### 4.1 接口（worker 新增）

| 请求 | 参数 | 返回 |
|---|---|---|
| `view_open` | handle, path, password | 页数、每页尺寸（pt，已按 crop box 和旋转换算）、书签、是否加密 |
| `view_tile` | handle, page, zoom（缩放档）, dpr, tx, ty（图块行列）, rev | 图块位图（见 §5.2 格式） |
| `view_text` | handle, page | 该页文字几何（§6.1） |
| `view_links` | handle, page | 链接区域与目标（页内跳转 / http(s) URL） |
| `view_cancel` | ids[] | 丢弃尚未开始的请求 |

渲染实现：

- **只渲染图块那一块**，不像现有 `Render` 先画整页再裁（整页位图在高缩放下要几百 MB）。用 `FPDF_RenderPageBitmap(bitmap, page, -tileX, -tileY, pageW_px, pageH_px, rotate, flags)`：位图只有图块大小，起点取负偏移，PDFium 自动裁掉图块外的部分。不用 `FPDF_RenderPageBitmapWithMatrix`，原因有二：它不画表单，而补画表单的 `FPDF_FFLDraw` 只接受偏移和尺寸、不接受矩阵；渐进渲染 `FPDF_RenderPageBitmap_Start` 也没有带矩阵的版本。统一用“负偏移 + 整页尺寸”，三者坐标一致。
- 标志：`FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER`（直接出 RGBA），不加 `FPDF_LCD_TEXT`（子像素文字在非整数缩放和合成时出彩边）；之后同一偏移调 `FPDF_FFLDraw` 画表单外观（需先 `FPDFDOC_InitFormFillEnvironment`）。
- 绑定：pdfium-render 0.9.5 的底层绑定里有 `FPDF_RenderPageBitmap_Start`、`FPDF_FFLDraw`，直接调 `pdfium.bindings()`；但 Cargo 开的是 `pdfium_7881` 特性而打包库是 chromium/8076，新用到的每个函数要核对签名（0 期）。
- 白底：先 `FPDFBitmap_FillRect` 白色，便于用不带透明通道的格式编码。
- 每页 `FPDF_LoadPage` 结果在 worker 里缓存最近 16 页（LRU），文字页 `FPDFText_LoadPage` 同样缓存。

### 4.2 分块

- 图块固定 **512×512 设备像素**（DPR=2 时等于 256×256 CSS px）。一张 A4 在 fit-width（约 800 CSS px 宽、DPR 2）下约 1600×2260 设备像素，切 4×5=20 块。
- 低缩放（整页 ≤ 1024×1024 设备像素，如缩略图和缩小浏览）不分块，整页一张。
- 优先级：视口内 > 视口上下各 1 屏的预取 > 其余。视口移出的未开始请求立即 `view_cancel`。
- 并发：worker 单线程，主进程队列一次只给 worker 一个请求，但按优先级重排；所以取消和插队都在主进程完成。
- 参数校验：主进程只接受合法缩放档、`dpr ∈ {1, 2, 3}`、图块行列在该页范围内，其余直接 400，防止页面（或被注入的内容）请求超大位图拖垮 worker。worker 侧再按现有 `Render` 的上限兜底。

### 4.3 缩放档与先糊后清

- 缩放档：25%、33%、50%、67%、80%、100%、125%、150%、200%、300%、400%、600%、800%，fit-width / fit-page 算出的实际倍率**向上**取最近一档渲染，CSS 缩小到实际倍率显示（缩小比放大清晰）。
- 捏合缩放过程中：不发新请求，直接对现有图块做 CSS `transform: scale()`（GPU 合成，60 fps）；手势停 120 ms 后按新档请求清晰图块，到一块换一块。
- 每页一张**低清整页图**（50% 档），任何新页先显示它，避免白屏；快速拖滚动条时只请求低清图。它以 **PNG 编码**存（一页约 30–60 KB，500 页约 20 MB），进入视口 ±1 屏时才解码成 `ImageBitmap`、离开即释放。不能全部解码常驻：一张约 1.2 MB，500 页就是 600 MB。
- 高缩放（> 400%）只渲染视口内图块，不预取。

### 4.4 HiDPI

- 渲染像素 = CSS 尺寸 × DPR × 缩放档，像素与屏幕 1:1，不靠浏览器插值。
- 每页**一个** `<canvas>`，图块用 `drawImage` 画到对应位置，不为每个图块建 DOM 元素（否则高缩放下几百个 canvas，布局与合成都重）。
- 监听 `matchMedia('(resolution: …dppx)')`，窗口拖到不同 DPR 的屏幕时作废缓存重取。

### 4.5 缓存

| 层 | 位置 | 内容 | 上限 |
|---|---|---|---|
| L1 | 渲染进程 | 已解码的 `ImageBitmap`，键 = (doc, rev, page, zoom, dpr, tx, ty) | 约 192 MB（1 MB/块），LRU；只留视口 ±2 屏；低清整页图见 §4.3，按 PNG 存、用到才解码 |
| L2 | 主进程 | 一律 **PNG(Fast)** 编码的图块（raw 只用于传输、不进缓存） | 约 128 MB（文字页约 1500 块），LRU；PNG 由主进程在 worker 返回 raw 后放进后台线程（`worker_threads` + 纯 JS/wasm 编码器，或 worker 空闲时补编）编码 |
| L0 | worker | 已加载的 `FPDF_PAGE` / `FPDF_TEXTPAGE` | 16 页 |

`rev` 来自 `doc/changed`，改动后旧图块自然失效，不必逐个删。

### 4.6 性能估算

依据：PDFium 在 Apple Silicon 上渲染普通文字页约 80–200 Mpx/s（Chrome 实测量级；扫描件、复杂矢量图慢 3–10 倍），零期打开 500 页文件 0.002 s（design §9.2.2）。

| 场景 | 像素量 | 渲染 | 编码（§5.2 方案） | 传输 + 解码 | 合计 |
|---|---|---|---|---|---|
| 一个 512² 图块，文字页 | 0.26 Mpx | 2–4 ms | raw：0；PNG(快速)：3–6 ms | < 1 ms | 约 3–10 ms |
| fit-width 首屏（20 块，DPR 2） | 5.2 Mpx | 30–60 ms | — | — | 首屏约 60–150 ms（视口内先出，约 8–10 块） |
| 低清整页图（50% 档） | 0.3 Mpx | 3–5 ms | PNG 3 ms | — | 一页约 8 ms |
| 扫描件一页（300 dpi JPEG） | 同上 | ×5–10 | — | — | 首屏约 300–600 ms，需先糊后清兜底 |

结论：文字类文件满足 G3；扫描件靠低清图兜底，仍不白屏。与 pdf.js 的速度比较目前没有实测数据（“快 2–5 倍”是原生对 JS/wasm 的一般经验），0 期用同一批样张对两者都测首屏与滚动帧率，作为是否继续的依据（§10）。

## 5. 传输

### 5.1 现有 `Render` 通道为何不够

JSON 行里塞 base64 PNG：编码 PNG（默认压缩级别慢）、base64 膨胀 33%、`serde_json` 写、Node 读行再 `JSON.parse`、渲染进程再解 base64、再解 PNG。一个 512² 图块要多花 15–30 ms，并且一个大图会堵住后面所有请求。

### 5.2 方案：worker ⇄ 主进程用长度前缀二进制帧，主进程 ⇄ 页面用 `finxdoc://`

**worker ⇄ 主进程**（`--view` 模式专用）：

```
帧 = u32 长度 | u32 请求 id | u8 类型 | JSON 头（变长，带 u16 长度）| 二进制负载
```

请求仍是 JSON（小），回复的位图作为二进制负载直接写 stdout，不 base64。

**主进程 ⇄ 页面**：扩展现有 `finxdoc://` 协议（与 `current.pdf` 同一令牌校验）：

| URL | 内容 | Content-Type |
|---|---|---|
| `finxdoc://<token>/view/info` | 页数、页尺寸、书签 | application/json |
| `finxdoc://<token>/view/tile?p=12&z=150&d=2&x=1&y=3&r=7` | 图块 | image/png 或 application/octet-stream |
| `finxdoc://<token>/view/text?p=12&r=7` | 文字几何 | application/octet-stream（§6.1） |
| `finxdoc://<token>/view/links?p=12&r=7` | 链接 | application/json |

- 取消：页面 `fetch` 带 `AbortSignal`，主进程在 `protocol.handle` 里监听 `req.signal` 并转成 `view_cancel`。**待验证**：Electron 各版本里页面的 abort 能否传到 `protocol.handle` 的 `req.signal` 并不确定，0 期先测；不行就改为页面另发 `finxdoc://<token>/view/cancel?ids=…`，或整条通道换 `MessagePort`。
- 键完全由 URL 表示，主进程 L2 缓存按 URL 命中。
- 可选优化（第 3 期再评估）：`MessagePort` + 可转移 `ArrayBuffer`，省掉协议层的一次拷贝。`finxdoc://` 先行，因为它已有令牌校验、天然支持取消、调试时能直接在 DevTools Network 里看到。

### 5.3 位图格式

| 格式 | 512² 图块大小 | 编码耗时 | 解码 | 结论 |
|---|---|---|---|---|
| raw RGBA | 1 MB | 0 | 0（`new ImageData` → `createImageBitmap`） | **本机进程间首选**：都在内存里，1 MB 拷贝 < 0.5 ms |
| PNG（`png` crate，`Compression::Fast`，无滤波） | 文字页 40–120 KB | 3–6 ms | 浏览器原生，约 2 ms | 用于 L2 缓存与低清整页图（省内存） |
| WebP 无损 | 比 PNG 小 25% | 15–40 ms | 原生 | 编码太慢，不用 |
| WebP / JPEG 有损 | 最小 | 5–10 ms | 原生 | 文字边缘发糊，违背 G1，不用 |

方案：worker 输出 raw RGBA；主进程对视口内请求直接透传 raw（Content-Type `application/octet-stream`，头里带宽高），同时编成 PNG(Fast) 放进 L2；L2 命中时返回 PNG。低清整页图始终是 PNG。L1 里都是 `ImageBitmap`，与格式无关。

## 6. 文字层：选区、复制、搜索、定位高亮

### 6.1 一页的文字几何

`view_text` 一次返回该页全部字符，紧凑二进制：

```
头：字符数 n、页宽高、旋转
每字符：u32 码位 | f32×4 字框（FPDFText_GetCharBox，页坐标） | f32×4 宽松框（FPDFText_GetLooseCharBox） | u8 标志（生成的空格/换行、隐形、竖排）
```

- 一页 3000 字约 3000 × 37 B ≈ 110 KB，gzip 前也只需 < 1 ms 传输；首次进入视口时取，与图块并行。
- 字符序号就是 PDFium 的 `FPDFText` 序号，**只在界面内部用**（命中、拖选、合并、复制、搜索）。
- **锚点不改**：仍是 `Anchor::Text { page, quads, text, block }`（`finx-protocol/src/doc.rs`，每行一个矩形）。选完后照旧把按行合并好的矩形交给 `doc/resolve`，由内核 `layout::take` 换成锚点。原因：
  1. 序号不稳定：删页、加批注后重存、表单外观重生成，都可能让同一页的 `FPDFText` 序号整体漂移；锚点按页坐标存，批注和引用才不会错位。
  2. 序号本来就对不上：内核 `chars()` 跳过换行、生成字符和隐形字，再按版面分析重排；`view_text` 为了与 `FPDFText_*` 对齐，不跳这些字，两边序号不同。
  3. 收益改为：两边都是 PDFium，矩形落在哪些字上，界面与内核判断一致，`doc/resolve` 不再因引擎差异取错字。
- 现有 `chars()` 会跳过换行与隐形字，`view_text` 不跳，只打标志，保证序号与 `FPDFText_*` 一致。

### 6.2 命中测试与拖选

- 前端维护每页字框，按行聚类建索引（见下），命中测试 = 先找最近的行，再在行内二分 x。对应 PDFium 的 `FPDFText_GetCharIndexAtPos`，但在前端做，拖动时零往返。
- 拖选：鼠标按下定起点字符序号，移动时定终点，选区 = 序号区间（与 Chrome 一致）。注意序号是**内容流顺序**，不一定是阅读顺序：多栏排版、表格、页眉页脚处可能跳来跳去（Chrome 同样有这个问题）。一期按序号；内核已有版面分析（design DE-17，`layout` 的 blocks），以后可在 `view_text` 里附上阅读顺序重排，工作量另计（PQ-05）。双击选词（按 Unicode 断词，中文按字符类连续段）、三击选行。
- 跨页拖选：起点页的到末尾 + 中间整页 + 终点页的开头；现有 `Pending.more` 结构沿用。
- 不使用浏览器原生选区，所以没有 span 拼缝问题；键盘 Shift+方向键扩展选区在第 2 期做。

### 6.3 按行合并成整块（对标 Chrome）

PDFium 已提供 `FPDFText_CountRects(start, count)` + `FPDFText_GetRect(i)`：把一段字符按行合并成矩形，Chrome 的选区就是用它画的。两种用法：

| 方案 | 做法 | 取舍 |
|---|---|---|
| A. worker 算 | 选区变化时请求 `view_rects(page, from, to)`，返回矩形列表 | 与 Chrome 逐像素一致；但拖动时每次往返（约 1–2 ms，可节流到每帧一次） |
| B. 前端算 | 用 §6.1 字框在前端复刻合并规则 | 零往返；规则需自己维护 |

**推荐 B 为主、A 为参照**：合并规则简单且确定——

1. 按序号顺序遍历选中字符，跳过空框；
2. 与当前行矩形"同一行"的判定：两框垂直方向重叠 ≥ 较矮者高度的 50%，且水平方向前进（竖排时换轴）；
3. 同一行则并入（取 x 的并、y 取行内最大上沿与最小下沿）；否则开新行；
4. 每行矩形的上下沿再扩到该行**宽松框**（`GetLooseCharBox`，含字体上升/下降）的范围，使相邻行的块首尾相接、无缝；
5. 行首尾若是 PDFium 生成的空格，宽度并入（Chrome 选中行尾会多出一小段，同样效果）。

开发期用方案 A 的结果做单测基准（同一组样张，两种结果 IoU > 0.98）。

绘制：每页一个绝对定位的 `<canvas>`（或 SVG）覆盖层，填充色 `rgba(0, 120, 215, 0.3)` 叠在图块上，`mix-blend-mode: multiply` 让黑字仍是黑的（与 Chrome 一致）。

### 6.4 复制

- `Cmd+C`：取序号区间文字 = `FPDFText_GetText(from, to-from)` 的等价（前端已有码位），生成的换行保留为 `\n`，连字符断行不合并（与 Chrome 一致）。
- 写剪贴板用 `navigator.clipboard.writeText`；右键菜单"复制""引用到对话"（沿用 `quoteToComposer`）。

### 6.5 搜索

- 工具栏搜索框不变。查找在 worker 做：`FPDFText_FindStart(flags: 不区分大小写)` 逐页跑，结果以 `[page, from, len]` 流式返回（每 20 页一批），工具栏显示"3 / 41"。
- 500 页文件全文搜索预计 0.3–1 s（PDFium 逐页加载文字页），先出当前页附近的结果。worker 单线程，搜索**每批 5 页一个请求**，由主进程队列调度，批次之间图块请求可以插队，搜索期间滚动不卡；新查询到来时取消旧查询剩余批次。中文、全半角：额外在前端对已取到的页做规范化（NFKC）匹配，补 PDFium 漏的情况。
- 高亮：命中段经 §6.3 合并成块，全部命中淡黄、当前命中橙色，滚动到当前命中所在行。

### 6.6 AI 定位高亮

- 现有 `jump` / `Flash`：锚点是 `text`（四边形）或 `region`（矩形）。锚点格式不变；前端用 §6.1 的字框找出锚点矩形覆盖的字，再按 §6.3 合并成整块闪烁，比现在逐四边形叠画更干净。
- 有报告时帮定位（如医疗、财报引用）：同一机制，一次可以高亮多段，侧栏列出命中并可逐个跳转。

### 6.7 链接与无障碍

- 链接：`FPDFLink_*` 取区域，覆盖透明 `<a>`；外链仅 http(s) 且经主进程 `shell.openExternal`（沿用现行规则），内链跳页。
- 无障碍：每页附一个屏幕阅读器可读、视觉隐藏的文字段落（按行），不参与选择，满足基本朗读。

## 7. 前端组件

### 7.1 替换范围

| 现在 | 改为 |
|---|---|
| `pdf.ts`：pdf.js、`RangeTransport`、`loadPdf` | `pdfium.ts`：`openView(token)`、`tileUrl()`、`fetchText()`、`find()`；不再引入 pdfjs-dist |
| `PdfView.tsx` 里 `PDFViewer` / `EventBus` / `PDFFindController` | 自有组件，状态在 React，事件不经事件总线 |
| `Thumb` 用 pdf.js 画缩略图 | 请求 25% 档整页图 |
| `Outline` 读 pdf.js 书签 | 读 `view/info` 里的书签（内核 `outline()` 已有） |
| 区域截图从页面 canvas 取 | 直接请求该区域的高清图块（现有 `Render` clip 能力），不再依赖屏上像素 |

### 7.2 组件结构

```
PdfView                     工具栏、侧栏、卡片：与现在相同的外壳与快捷键
├─ Toolbar                  目录/缩略图开关、页码输入、缩放（档位 + 适合宽度/整页）、搜索
├─ Side                     Outline | Thumbs（虚拟列表）
└─ PdfCanvas                滚动容器；虚拟化，只挂载视口 ±1 屏的页
   └─ Page × n              绝对定位，按页尺寸 × 缩放占位
      ├─ TileLayer          图块 <canvas>，先低清整页图、后清晰图块
      ├─ SelectionLayer     选区 / 搜索 / AI 定位 / 闪烁，一张 canvas
      ├─ AnnotationLayer    批注层（沿用现有，坐标改由 PdfCanvas 提供的页→视图换算）
      └─ LinkLayer          链接热区
hooks: useViewDoc(token) · useTiles(page, zoom) · useTextGeometry(page) · useSelection() · useFind()
```

- 页→视图坐标换算集中在一个 `PageGeometry`（页尺寸、旋转、缩放），选区、批注、区域工具共用，取代现在从 pdf.js `viewport` 取。
- 缩放：保留"适合宽度随栏宽变化"（ResizeObserver）、捏合缩放保持手势点不动（现有逻辑改为改自己的 scale 状态）。
- 密码：`view_open` 返回"需要密码 / 密码错"，沿用 `PasswordForm`。

### 7.3 回退

保留 pdf.js 一个版本周期，作为**设置里的隐藏开关**与**自动回退**：同一文件导致渲染 worker 崩溃 2 次、或 `view_open` 报 PDFium 打不开（极少见的损坏文件，pdf.js 有时更宽容）时，该文件改用旧 `PdfView`。

**崩溃归属**：一个渲染 worker 服务所有打开的文档，崩溃时主进程记下当时正在处理的请求及其文件，只把那个文件计一次；重启后先重开其它文件、最后再试它。这样一份坏文件不会拖着别的文件一起回退，也不会让 worker 反复崩。稳定一个版本后删除 pdf.js 与 `pdfjs` 数据文件（cmaps、standard_fonts、wasm），安装包减小约 8–10 MB。

## 8. 与 pdf.js 对比

| 方面 | pdf.js（现在） | 自带 PDFium（本方案） |
|---|---|---|
| 渲染质量 | 好，个别字体/透明组/细线与 Chrome 不同 | 与 Chrome 同源 |
| 选区观感 | 逐 span，拼缝、高低不齐 | 按行整块，同 Chrome |
| 文字与锚点 | 显示用 pdf.js、内核用 PDFium，同一矩形两边取到的字可能不同 | 都用 PDFium，取字一致；锚点格式不变 |
| 速度 | JS + wasm，主线程外绘制 | 原生，经验上应更快，但多一次进程间传输；0 期实测对比后才有结论 |
| 内存 | 渲染进程内解析整份结构 | 解析在 worker；渲染进程只存位图 |
| 安全 | 渲染进程解析不可信 PDF | 解析在独立进程，崩溃不影响界面 |
| 表单交互 | 能填 | 一期只读显示（R6） |
| 原生文本选择/查找（Cmd+F、无障碍） | 浏览器原生 | 自己实现，工作量在这里 |
| 维护 | 跟 pdfjs-dist 升级 | 跟 PDFium 二进制升级（已在做） |
| 自定义界面 | 受 `PDFViewer` DOM 限制 | 完全自控 |

## 9. 风险与对策

| 编号 | 风险 | 对策 |
|---|---|---|
| R1 | 进程间传输成为瓶颈（大缩放、快速滚动） | raw 帧 + 优先级队列 + 取消；L2 缓存；零期实测，必要时换 `MessagePort` 可转移缓冲 |
| R2 | 单线程 worker 被一张复杂页（大扫描件、海量矢量）卡住几百毫秒，其它页排队 | 渲染 worker 开 2 个实例（不同文档或同文档不同页，PDFium 每进程一份不冲突）；用 `FPDF_RenderPageBitmap_Start/Continue`（渐进渲染 + 暂停回调）让高优先级请求插队 |
| R3 | 自己实现选择交互，细节多（拖到页外、自动滚动、竖排、RTL、双击选词） | 分期：第 1 期横排拖选/复制；第 2 期双击三击、键盘扩选、竖排；用方案 A 做基准测试 |
| R4 | 内存：位图缓存比 pdf.js 大 | L1 上限 + 视口外回收；低清整页图用 PNG |
| R5 | PDFium 崩溃 | 进程隔离，自动重启、重开文档、前端重取在屏图块；连续崩溃回退 pdf.js（§7.3） |
| R6 | 表单不能填 | 一期显示外观；需要时第 4 期用 `FORM_*` API + 前端覆盖原生输入框，或该文件临时切回 pdf.js |
| R7 | 与正在做的 pdf.js 整块选区短期改进重复 | 短期改进只在 `PdfView.tsx` 文字层上，本方案第 2 期上线后整体替换；合并规则（§6.3）可复用到短期方案 |
| R9 | 渲染效果与 Chrome 有系统性差别（Skia 与 AGG 后端、版本不同） | 验收按人眼对比 + 样张回归（G1）；若差别明显，评估用 Skia 后端构建的 PDFium（pdfium-binaries 有 `v8`/`skia` 变体，需单独验证体积与稳定性） |
| R10 | 渲染调用依赖底层绑定，pdfium-render 的特性版本（7881）与打包库（8076）不一致 | 0 期逐个核对用到的函数签名；或把特性升到与打包库一致 |
| R8 | Windows/Linux 以后要支持 | PDFium 二进制各平台都有（pdfium-binaries）；方案不依赖 macOS 专有 API |

## 10. 分期与工作量

按一名熟悉本仓库的工程师估算（人日）。

| 期 | 内容 | 过关标准 | 工作量 |
|---|---|---|---|
| 0 期：验证 | worker `--view` 模式原型：二进制帧、`view_tile`（负偏移渲染 + `FPDF_FFLDraw` 表单 + 渐进渲染 `_Start/_Continue`）、`finxdoc://…/view/tile`；一个只读的测试页。必验三项：① 表单外观在分块下位置正确；② 页面 abort 能否到达 `protocol.handle` 的 `req.signal`；③ 内核保存与渲染 worker 重开的竞态（§3） | 53 MB / 500 页与 20 个样张：单图块 p50 < 10 ms、首屏 < 300 ms，且与 pdf.js 同样张对比不更慢；与 Chrome 并排人眼无明显差别；①②③ 有结论 | 4–5 |
| 1 期：只读显示 | 分块、缩放档、先糊后清、HiDPI、三层缓存、虚拟化滚动；目录、缩略图、页码、缩放接上；`doc/changed` 刷新（含内核原子写的配合改动）；密码；崩溃重启与归属；参数校验；pdf.js 回退开关 | 日常文件替代 pdf.js 显示无明显退步 | 10–12 |
| 2 期：文字 | `view_text`、命中测试、拖选（含跨页）、按行合并整块、复制、搜索（流式）、AI 定位高亮、链接；选区矩形经 `doc/resolve` 换锚点（格式不变）；搜索分批让路；批注层/区域工具迁到新坐标换算 | G2、G4 达成；现有批注、引用到对话、区域截图回归通过 | 11–13 |
| 3 期：打磨 | 双击/三击、键盘扩选、竖排、渐进渲染插队、双实例、`MessagePort` 评估、无障碍文字 | 与 Chrome 交互逐项对照表全部通过 | 7–9 |
| 4 期（可选） | 表单填写；删除 pdf.js | — | 5 |

合计第 0–2 期（可替换 pdf.js）约 **25–30 人日**，第 3 期后达到 Chrome 同级体验约 **32–39 人日**（不含阅读顺序重排 PQ-05 与表单填写）。v0.1 的 19–23 人日偏乐观，漏算了表单分块绘制、取消通道、改动竞态、崩溃归属和自己实现选择交互的细节。建议默认开关在第 2 期结束后打开，pdf.js 保留到第 3 期结束。

## 11. 决策与待定问题

### 决策（提议）

| 编号 | 决策 |
|---|---|
| PV-01 | 显示改用自带 PDFium，渲染在独立的渲染 worker（主进程拉起），不在主进程、不在渲染进程 |
| PV-02 | 位图经 `finxdoc://<token>/view/*` 交给页面；worker ⇄ 主进程用长度前缀二进制帧；视口内 raw RGBA，缓存与低清图用 PNG(Fast)；不用有损格式 |
| PV-03 | 图块 512² 设备像素、离散缩放档向上取、手势中 CSS 缩放、停手后换清晰图 |
| PV-04 | 文字几何整页一次给前端，选区、合并、命中在前端算；`FPDFText_CountRects/GetRect` 作为合并规则的基准 |
| PV-05 | 字符序号只在界面内用；锚点仍是按行矩形 + 文字，经 `doc/resolve` 生成，格式不变（v0.2 修订，原提议“锚点改用序号”撤回） |
| PV-06 | pdf.js 保留为回退一个版本周期后删除 |

### 待定问题

| 编号 | 问题 |
|---|---|
| PQ-01 | raw 透传 vs 全部 PNG：看 0 期实测的内存与延迟 |
| PQ-02 | 渲染 worker 一个还是两个实例（R2） |
| PQ-03 | 表单填写是否必要，什么时候做（R6） |
| PQ-04 | 通过后 document-editor-design §7.3、§9.4.1 一并修订 |
| PQ-05 | 拖选是否按版面分析的阅读顺序而非内容流顺序（§6.2），何时做 |
| PQ-06 | 内核写 `current.pdf` 是否已是原子替换；不是的话由谁、在哪一期改（§3） |
