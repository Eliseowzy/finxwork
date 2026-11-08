# PPTX 编辑器

PPTX 在文件面板内直接编辑。主画布由浏览器 Canvas 按文稿对象绘制，缩放时重绘文字、形状和图片，不使用整页 PNG 作为编辑画布。

## 分工

- `@betteroffice/pptx-react` 0.5.1 提供画布、缩略栏、工具栏、文字输入、形状操作和撤销。`@betteroffice/pptx` 0.5.1 的 WASM 引擎默认在 Web Worker 内解析、布局、编辑和序列化文稿。Vite 随应用打包 Worker、WASM 和动态模块，无需远程编辑服务。
- `files/state.ts` 持有每个标签的 `PresentationDoc`。编辑器有独立的 React root 和 DOM 容器；切换标签、会话或隐藏文件面板只移走容器，保留 Worker、选区和撤销历史。关闭标签前等待输入提交和保存，未保存成功则保留标签。重新加载外部版本或关闭标签时释放编辑器。
- 原生端提供 `pptx/read`、`pptx/font`、`pptx/write` 和 `pptx/metafile`。会话解析路径，字体从本机读取，写入使用会话工具相同的路径锁和原子文件写入接口。此链路不调用 `render_png()`。

## EMF/WMF 和 OLE 预览

从旧 PowerPoint 转换来的文稿可能把图表保存在 OLE 对象内，并提供 EMF/WMF 矢量预览。0.5.1 浏览器解码器无法直接显示这些资源。BetterOffice 编辑器提供 `decodeImage` 属性（每个编辑器独立），宿主传入解码回调，按字节签名识别元文件后调用 `pptx/metafile`，由 BetterOffice 的元文件解析器生成 SVG，再在前端画布绘制。普通图片继续使用原解码器。主画布和缩略图共用这条解码链路。

转换只用于显示，原始 EMF/WMF、OLE 数据和文稿模型都保持原样。保存不会把 OLE 对象替换成 SVG 或 PNG。转换拒绝或存在遗漏时界面给出提示。这里提供的是嵌入对象的外观显示，不是 OLE 图表内部数据编辑器。补丁说明见 `patches/README.md`。

## 字体

读取 PPTX 时发现 DrawingML 的 Latin、East Asian 和 complex-script 字体槽位，补充 Arial、PingFang SC。浏览器按需向宿主请求这些家族的 regular、bold、italic、bold-italic 字体字节（CJK 只请求 regular、bold），交给 WASM 和 Canvas 使用。字体查找复用 `finx-slide::SystemFonts`，TTC 被提取成独立字体。应用不分发字体，也不访问字体 CDN。

## 保存和外部修改

缩略栏的拖拽由宿主提供插入边界反馈：上半部插在页前，下半部插在页后，横线左端带圆点。最终索引扣除源页被移走的位置，提示线与实际保存的页序一致；自己的相邻边界不触发移动。边缘拖拽自动滚动，离开、取消或完成拖拽时清理反馈。原有键盘调序保留。

编辑暂停 1.2 秒、保存快捷键、标签关闭或窗口失焦时尝试保存。先提交编辑器待处理的输入，再序列化 PPTX。写入排队，保存过程中产生的新编辑会接着保存。

每次写入必须携带读取时或上次保存后的 SHA-256。原生端先验证包和原生引擎可读性，再在路径锁内比较磁盘哈希。不匹配或文件被删除时不写入，保留前端编辑并提示重新加载。普通读写失败可重试。不会自动覆盖其他应用或 Agent 的写入。

## 当前边界

- 支持 `.pptx`，旧二进制 `.ppt` 仍交给系统应用。
- 单个文稿和单个字体上限为 20 MiB，使 base64 RPC 消息留在默认 32 MiB 帧限制内。XML 解包也有大小限制。
- 前端使用发布的 0.5.1 npm 包，原生解析/字体沿用仓库锁定的 BetterOffice fork。fork 的渲染补丁不会自动进入已发布的 WASM；实际版式保真度需要用 PowerPoint 对照样稿评估。
- 当前是每个文件标签一个浏览器编辑会话。多个会话或外部应用的写入以冲突检查保护，不提供实时协同。
- 本次没有加入 Agent 对编辑器对象的直接操作工具。

## 验证

```sh
cargo test -p finx-core pptx::tests --offline
pnpm --filter @finx/desktop typecheck
pnpm --filter @finx/desktop test
pnpm --filter @finx/desktop exec electron-vite build
pnpm --filter @finx/desktop e2e:pptx
```

macOS Electron 端到端检查使用仓库内两页固定样稿和本机 Arial 字体，验证 Canvas 绘制、键盘修改文字、拖动形状后保存的几何坐标、保存重开、隐藏面板后会话保留。默认使用隔离文件传输；以下命令改用临时 FINX_HOME 下的真实原生 RPC 和字体服务，需先构建内核：

```sh
cargo build -p finx-cli --offline
FINXWORK_E2E_NATIVE=1 pnpm --filter @finx/desktop e2e:pptx
FINXWORK_E2E_NATIVE=1 FINXWORK_E2E_VECTOR=1 pnpm --filter @finx/desktop e2e:pptx
FINXWORK_E2E_NATIVE=1 FINXWORK_E2E_REORDER=1 pnpm --filter @finx/desktop e2e:pptx
```

`FINXWORK_E2E_SHOTS` 可指定截图与编辑后样稿的输出目录。检查不读取或修改用户文稿。
