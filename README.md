<div align="center">

<img src="assets/brand/github/finxwork-social-preview-zh.png" alt="FinxWork — 专为金融行业人士提供的智能工作台" width="100%" />

<br /><br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/motion/finxwork-mark-flow-dark.gif" />
  <img src="assets/brand/motion/finxwork-mark-flow-light.gif" alt="FinxWork 动态标识" width="88" height="88" />
</picture>

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/lockup/finxwork-lockup-horizontal-dark.png" />
  <img src="assets/brand/lockup/finxwork-lockup-horizontal-light.png" alt="FinxWork" height="44" />
</picture>

<p>
  <strong>专为金融行业人士提供的智能工作台</strong>
</p>

<p>
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

<p>
  <a href="https://github.com/finxwork/finxwork/stargazers"><img src="https://img.shields.io/github/stars/finxwork/finxwork?style=for-the-badge&logo=github&color=1F6BFF" alt="GitHub Stars" /></a>
  <a href="https://github.com/finxwork/finxwork/network/members"><img src="https://img.shields.io/github/forks/finxwork/finxwork?style=for-the-badge&logo=github&color=2EB8FF" alt="GitHub Forks" /></a>
  <a href="https://github.com/finxwork/finxwork/issues"><img src="https://img.shields.io/github/issues/finxwork/finxwork?style=for-the-badge&color=1B36D9" alt="GitHub Issues" /></a>
  <img src="https://img.shields.io/badge/version-0.2.0-1F6BFF?style=for-the-badge" alt="Version 0.2.0" />
  <img src="https://img.shields.io/badge/Rust-1.89%2B-000000?style=for-the-badge&logo=rust" alt="Rust 1.89+" />
  <img src="https://img.shields.io/badge/Desktop-Electron%20%2B%20React%2019-47848F?style=for-the-badge&logo=electron" alt="Electron + React 19" />
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-555555?style=for-the-badge" alt="macOS and Linux" />
</p>

<p>
  <a href="#模型接入零门槛byok--现有订阅直连">模型接入与订阅直连</a> ·
  <a href="#核心功能">核心功能</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#项目架构">项目架构</a> ·
  <a href="#star-趋势与引用">Star 趋势与引用</a>
</p>

</div>

---

## 模型接入零门槛：BYOK & 现有订阅直连

**FinxWork 不绑定任何单一厂商，也不强制额外购买 API 额度。** 无论是企业自带密钥（BYOK）、各大云厂商包月 Token Plan，还是你日常已经在付费使用的 **ChatGPT、千问办公、Qoder** 等桌面/网页订阅，都可以直接连入工作台统一调度：

| 接入方式 | 支持平台与能力说明 |
| --- | --- |
| **个人订阅直连（复用现有额度）** | <ul><li><strong>ChatGPT</strong>：通过浏览器 OAuth 登录，直接使用现有 ChatGPT 订阅额度，无需单独申请 API Key</li><li><strong>千问办公（QwenWork）</strong>：自动发现并连接本机千问办公已登录账户，建立独立模型会话、按需续期</li><li><strong>Qoder</strong>：直连本机已登录的 Qoder 账户，将现有编码/推理模型能力引入 FinxWork 工作流</li></ul> |
| **Token Plan / Coding Plan 套餐** | 原生适配 **阿里云百炼 Token Plan**、**腾讯云 Token Plan**、**火山方舟 Agent Plan / Coding Plan**、**智谱 GLM Coding Plan（中国站 / Z.ai 国际站）**，支持套餐目录动态刷新与多模型切换 |
| **标准 BYOK（自带 API Key）** | 内置 **OpenAI、Anthropic、Google、DeepSeek、通义千问、Moonshot（Kimi）、MiniMax、智谱 AI、xAI、OpenRouter** 官方接入，预设上下文长度、思考强度与价格参数 |
| **企业网关与本地私有模型** | 支持任意 **OpenAI / Anthropic 兼容自定义端点**（公司内部网关、中转站，或 **Ollama** 等本地推理服务），支持协议自动探测，满足金融内网合规与数据不出域需求 |

> 所有密钥与授权凭证仅保存在本地，支持工作台可视化切换默认模型与思考深度，也可通过 `finx login` 在命令行中一键接入。

---

## 核心功能

围绕投研分析、财务建模、报告撰写与汇报路演等高频金融工作流，**FinxWork** 将 Rust 智能体内核与桌面工作台深度融合，让人与 AI 在同一份真实文件与工作空间中高效协作：

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>📊 财务建模与表格重算</h3>
      <p>原生支持 <code>.xlsx</code>、<code>.csv</code>、<code>.tsv</code> 编辑与 <code>.xls</code> 只读解析。内置公式计算引擎支持结构化引用展开、全表重算、循环引用检测与关键指标影响面分析，不篡改原始公式文本，每一笔改动均可追溯与撤销。</p>
    </td>
    <td width="50%" valign="top">
      <h3>📄 研报阅读与文档精编</h3>
      <p>在对话旁直接并排打开 PDF 公告、招股书与 <code>.docx</code> 报告，支持页面区域框选或划词一键引用提问；Word 编辑采用外科式局部保存并支持高保真 PDF 导出，完整保留原有排版、页眉页脚与表格结构。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>📽️ 路演与汇报幻灯片协同</h3>
      <p>支持 <code>.pptx</code> 幻灯片高清渲染预览与文本/数据精准替换，在保留原有母版风格、图表与中文字体版式的前提下完成页面内容更新，兼顾合规校对与制作效率。</p>
    </td>
    <td width="50%" valign="top">
      <h3>🌐 浏览器协同与信息核验</h3>
      <p>配套 Chrome 扩展与原生浏览器控制桥接（<code>finx-browser</code>），让智能体在受控会话中复用你已登录的网站状态检索公告与网页数据，并直接在工作台右侧预览与核验引用来源。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🤖 专属 Bot、子智能体与技能扩展</h3>
      <p>支持创建面向固定投研任务的专属 Bot 与定时例行任务（Routine），可按需编排多子智能体并行拆解分析，并通过标准化 MCP（Model Context Protocol）与自定义 Skills 接入内部数据与工具。</p>
    </td>
    <td width="50%" valign="top">
      <h3>🔒 本地优先与严格审批控制</h3>
      <p>全链路零遥测数据上传；所有文档编辑先落工作副本、确认后再写回原文件，敏感系统操作需经明确权限审批确认，保障金融资料与本地工作区安全。</p>
    </td>
  </tr>
</table>

---

## 快速开始

### 从源码启动工作台

```bash
# 1. 构建 Rust 智能体内核与工具引擎（需 Rust 1.89+）
cargo build

# 2. 安装前端依赖并启动 FinxWork 桌面端（需 Node.js + pnpm）
pnpm install
pnpm dev
```

### 命令行与自动化集成

除了桌面端工作台，FinxWork 也可通过 `finx` CLI 运行在终端或自动化脚本中：

```bash
# 连接模型（支持 ChatGPT 订阅、Token Plan、BYOK 或自定义本地服务）
finx login

# 启动交互式工作会话
finx

# 单次任务执行并输出结构化 JSON（适用于流水线与脚本调度）
finx exec --json "核对当前目录下的财报模型并汇总关键指标变化"
```

如需接入编辑器或外部系统，可使用 `finx acp`（Agent Client Protocol）与 `finx serve`（JSON-RPC）。更多细节见 [docs/cli/quickstart.md](docs/cli/quickstart.md) 与 [docs/cli/llms.txt](docs/cli/llms.txt)。

---

## 项目架构

```text
finxwork/
├── apps/
│   ├── desktop/              # Electron + React 19 桌面端工作台 (@finx/desktop)
│   └── chrome-extension/     # 浏览器控制伴侣扩展
├── crates/
│   ├── finx-core/            # 智能体内核、会话循环、子智能体调度与提示词系统
│   ├── finx-cli/             # 命令行入口 (finx / exec / acp / serve)
│   ├── finx-docs/            # 统一文档工作副本、修订记录与 PDFium 后端
│   ├── finx-sheet/           # 电子表格公式重算、循环引用与 CSV/XLS/XLSX 引擎
│   ├── finx-word/            # Word (.docx) 协同编辑与版式渲染引擎
│   ├── finx-slide/           # PowerPoint (.pptx) 渲染与局部精准编辑引擎
│   ├── finx-browser/         # 浏览器自动化与原生宿主桥接
│   ├── finx-llm/             # 多模型适配、模型目录与凭证管理
│   ├── finx-mcp/             # MCP (Model Context Protocol) 扩展集成
│   ├── finx-tools/           # 文件、终端命令与网页检索工具集
│   ├── finx-connections/     # ChatGPT / 千问办公 / Qoder 等订阅与连接适配器
│   ├── finx-acp/             # ACP 协议服务
│   ├── finx-rpc/             # JSON-RPC 传输层
│   ├── finx-server/          # 本地后端服务
│   └── finx-protocol/        # Rust / TypeScript 共享协议定义
├── packages/
│   ├── client/               # TypeScript 客户端 SDK
│   └── protocol/             # 自动生成的 TypeScript 协议类型
└── assets/brand/             # 品牌标志、横版/竖版组合与动态视觉资产
```

---

## Star 趋势与引用

<div align="center">

<a href="https://star-history.com/#finxwork/finxwork&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=finxwork/finxwork&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=finxwork/finxwork&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=finxwork/finxwork&type=Date" width="85%" />
  </picture>
</a>

</div>

如果 **FinxWork** 对你的研究、投研自动化工作流或工程实践有所帮助，欢迎引用：

```bibtex
@software{finxwork2026,
  title  = {FinxWork: The Intelligent Workbench Built for Finance Professionals},
  author = {FinxWork Contributors},
  year   = {2026},
  url    = {https://github.com/finxwork/finxwork}
}
```
