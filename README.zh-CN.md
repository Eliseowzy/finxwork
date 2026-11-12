<div align="center">

<img src="assets/brand/github/finxwork-social-preview-zh.png" alt="FinxWork — 千丝万缕的数据，汇成一个 α · 为金融专业人士打造的 AI 工作台" width="100%" />

<br /><br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/motion/finxwork-mark-flow-dark.gif" />
  <img src="assets/brand/motion/finxwork-mark-flow-light.gif" alt="FinxWork 动态 α 标识" width="88" height="88" />
</picture>

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/lockup/finxwork-lockup-horizontal-dark.png" />
  <img src="assets/brand/lockup/finxwork-lockup-horizontal-light.png" alt="FinxWork" height="44" />
</picture>

<p>
  <strong>千丝万缕的数据，汇成一个 α。</strong><br />
  面向代码、终端、电子表格、文档、幻灯片与浏览器的 AI 智能体内核与工作台。
</p>

<p>
  <a href="README.md">English</a> · <strong>简体中文</strong>
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
  <a href="#快速开始">快速开始</a> ·
  <a href="#三种接入方式">三种接入方式</a> ·
  <a href="#项目架构">项目架构</a> ·
  <a href="#文档导航">文档导航</a> ·
  <a href="#引用">引用</a>
</p>

</div>

---

## 项目简介

**FinxWork** 将高性能 Rust 智能体内核（`finx`）、Electron + React 19 桌面工作台（`@finx/desktop`）以及浏览器伴侣插件（`apps/chrome-extension`）融为一体。它可以读写代码、执行终端命令、检索网页、自动化浏览器操作，并原生打开、重算与编辑电子表格、Word 文档、PPT 幻灯片与 PDF——底层模型完全由你自由选择。

| 核心能力 | 说明 |
| --- | --- |
| **智能体内核与 CLI（`finx`）** | 支持终端交互会话、单次 `finx exec --json` 脚本自动化、子智能体调度、MCP 扩展，且零遥测上报 |
| **原生办公文档引擎** | 通过 `finx-docs` / `finx-sheet` / `finx-word` / `finx-slide` 原生支持 `.xlsx`/`.csv`/`.tsv` 公式重算、`.docx`、`.pptx` 与 PDF 解析 |
| **桌面端工作台（`@finx/desktop`）** | 富文本与 Markdown/KaTeX/Mermaid 渲染、多模型连接管理、文档同屏协同编辑 |
| **浏览器控制** | 配套 Chrome 扩展 + `finx-browser` 原生宿主桥接，实现真实页面观察与交互 |
| **开放协议** | 支持编辑器接入协议 `finx acp`（ACP）与程序化调用协议 `finx serve`（JSON-RPC） |
| **多模型接入** | 支持 API Key、Token Plan、ChatGPT 订阅、本地 Ollama 或任意 OpenAI 兼容自定义服务 |

---

## 快速开始

### 安装 CLI

```bash
curl -fsSL https://github.com/finxwork/finx-releases/releases/latest/download/install.sh | sh
```

支持 **macOS** 与 **Linux**（`x86_64` 与 `arm64`），默认安装二进制文件至 `~/.local/bin`。其他安装方式见 [docs/cli/quickstart.md](docs/cli/quickstart.md)。

### 30 秒上手

```bash
finx login
finx "explain what this repository does"
```

`finx login` 用于连接你的模型服务（API Key、Token Plan、ChatGPT 订阅、本地 Ollama 或自定义兼容接口）。在未显式配置前，`finx` 不会做任何隐式假定。

### 从源码构建

```bash
# 1. 构建 Rust 工作区（需 Rust 1.89+，edition 2024）
cargo build

# 2. 启动桌面应用（需 Node.js + pnpm）
pnpm install
pnpm dev
```

---

## 三种接入方式

- **在终端中使用**：直接运行 `finx`，对话保留在当前终端滚动历史中；除非你授权，否则修改前都会先征求确认。
- **在脚本中调用**：单次任务直接输出结构化 JSON 结果：

  ```bash
  finx exec --json "summarize the changes on this branch" | jq -r .final_output
  ```

  退出码含义：`0` 完成、`1` 失败、`2` 参数错误或未配置模型、`3` 部分操作因无人审批被拒绝、`130` 中断。详见 [docs/cli/scripting.md](docs/cli/scripting.md)。

- **集成到其他程序**：`finx acp` 通过 Agent Client Protocol 服务编辑器（[acp.md](docs/cli/acp.md)）；`finx serve` 提供 JSON-RPC 接口（[json-rpc.md](docs/cli/json-rpc.md)），[examples/rpc](examples/rpc) 含有一页完整的 Python 客户端示例。

---

## 安全与隐私

- **权限边界透明**：当前无操作系统级沙箱，安全依赖权限模式、规则、工作区边界与受保护路径机制（[permissions.md](docs/cli/permissions.md)）。仅建议在容器或一次性隔离环境中使用 `bypass-permissions`。
- **仓库指令感知**：进入项目时会自动读取 `AGENTS.md` 与项目级 Skills。
- **零遥测（No Telemetry）**：所有网络访问行为均列明于 [privacy.md](docs/cli/privacy.md)。

<details>
<summary><strong>供编程智能体调用（For Coding Agents）</strong> — 自动化参数、JSON 协议与环境约束</summary>

如果你是通过外部编程智能体配置或调用 `finx`：

- 使用 `finx exec --json "TASK"` 执行任务。结果位于 `final_output`，`exit_code`、`error`、`tool_calls` 与 `refused` 描述执行详情；可用 `finx exec --resume last "NEXT"` 延续上次会话。
- `finx status --json`、`finx doctor --json`、`finx models --json`、`finx tools --json` 仅探测环境，不做任何修改。
- `--json` 模式下的异常直接输出 JSON 到 stdout：`{"error": {"kind", "message", "help"}, "exit_code": 2}`。
- 退出码 `3` 表示操作因缺少审批被拒绝，应调整权限模式或规则，切勿盲目重试。
- 仅在用户明确指示或处于独立运行容器内时，才允许传入 `--dangerously-skip-permissions`。
- 密钥请通过标准输入传入，避免出现在命令行参数中：`printf %s "$KEY" | finx login deepseek --key-stdin --model deepseek/deepseek-flash`。
- 当设置 `AI_AGENT` 环境变量时，`finx config set` 会拒绝修改权限类配置（权限归人工操作者控制）。
- 面向 LLM 的文档索引：[docs/cli/llms.txt](docs/cli/llms.txt)。

</details>

---

## 项目架构

```text
finxwork/
├── apps/
│   ├── desktop/              # Electron + React 19 桌面工作台 (@finx/desktop)
│   └── chrome-extension/     # 浏览器伴侣扩展
├── crates/
│   ├── finx-core/            # 智能体内核、会话循环、子智能体与提示词
│   ├── finx-cli/             # 命令行入口 (`finx`, `exec`, `acp`, `serve`)
│   ├── finx-llm/             # 模型适配器、目录与凭证管理
│   ├── finx-tools/           # 工作区、终端命令与网页检索工具
│   ├── finx-docs/            # 统一文档存储与索引
│   ├── finx-sheet/           # 电子表格公式重算、CSV/XLS/XLSX 处理
│   ├── finx-word/            # Word (.docx) 编辑与版式支持
│   ├── finx-slide/           # PowerPoint (.pptx) 渲染与外科式编辑
│   ├── finx-browser/         # 浏览器自动化与原生宿主桥接
│   ├── finx-mcp/             # Model Context Protocol (MCP) 集成
│   ├── finx-acp/             # Agent Client Protocol 服务端
│   ├── finx-rpc/             # JSON-RPC 传输层
│   ├── finx-server/          # 本地后端服务
│   ├── finx-protocol/        # Rust/TS 共享协议定义
│   └── finx-connections/     # 模型服务与 Token Plan 连接管理
├── packages/
│   ├── client/               # TypeScript 客户端 SDK
│   └── protocol/             # 自动生成的 TypeScript 协议类型
└── assets/brand/             # 品牌标志、横版/竖版组合与动态资产
```

---

## 文档导航

[快速上手](docs/cli/quickstart.md) · [模型配置](docs/cli/models.md) · [内置工具](docs/cli/tools.md) · [权限控制](docs/cli/permissions.md) · [脚本化调用](docs/cli/scripting.md) · [ACP 协议](docs/cli/acp.md) · [JSON-RPC](docs/cli/json-rpc.md) · [隐私说明](docs/cli/privacy.md) · [故障排查](docs/cli/troubleshooting.md) · [LLM 索引](docs/cli/llms.txt)

---

## Star 趋势

<div align="center">

<a href="https://star-history.com/#finxwork/finxwork&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=finxwork/finxwork&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=finxwork/finxwork&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=finxwork/finxwork&type=Date" width="85%" />
  </picture>
</a>

</div>

---

## 引用

如果你在研究、工作流或工程评测中使用了 **FinxWork**，欢迎按以下格式引用：

```bibtex
@software{finxwork2026,
  title  = {FinxWork: The AI Agent Kernel and Workbench for Finance and Engineering},
  author = {FinxWork Contributors},
  year   = {2026},
  url    = {https://github.com/finxwork/finxwork}
}
```
