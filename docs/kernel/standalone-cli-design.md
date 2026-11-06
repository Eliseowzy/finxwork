# finx 命令行独立发布方案

| 项 | 内容 |
|---|---|
| 版本 | v0.6 |
| 日期 | 2026-11-06 |
| 状态 | 一期 A–F 包已实现，在分支上，未合入、未发布。§18 的决定都先按文中的建议做，可以再改。还差什么见 §21 |
| 关系 | 把总方案 technical-design.md §12 的"交互界面"（Q-12）从桌面端扩到命令行；扩展 protocol-design.md §6–§8、model-catalog-design.md、mcp-design.md §9；发布沿用 desktop-release.md 的原则 |
| 编号 | 决策从 D-500 起，待定问题从 Q-300 起，避开并行分支正在使用的编号 |

## 方案摘要

**目标：** 没装 FinxWork 的人，装一个文件就能用 finx 做完整的任务：在终端里对话，在脚本里跑，接进编辑器，接进自己的程序。

**三种入口，一个内核。** CLI 给人和脚本，ACP 给编辑器，JSON-RPC 给程序。任务、审批、工具、上下文只有一份，都在内核里。三个入口现在都能跑完一个完整任务（实测，§2）。

**缺口不在内核，在内核外面：**

| 缺口 | 人会碰到什么 | 怎么补 |
|---|---|---|
| 没有带工具的交互模式 | 输入 `finx` 只看到用法错误 | 不带子命令进入交互：终端自己的滚动区加底部活动区，运行中能继续打字（§5） |
| 第一次运行不会配置 | 没有保存密钥的命令，要自己查环境变量的名字 | `finx login` 一条路走完（§7.3）。默认模型已改好：什么都没配时不再假设 DeepSeek，而是提醒去设置（§7.2，已实现） |
| 没有安装渠道 | 只能从源码编译 | 独立的发布仓库、签名公证、安装脚本、Homebrew、`finx upgrade`（§13） |
| 公开之后才暴露的问题 | 新旧两个版本共用 `~/.finx` 时一方起不来；MCP 工具任何模式都不问就执行；ACP 客户端看到中文文案、也没法登录 | §11、§12、§10 |

**几条定下来的做法：**

- **不写第二份逻辑。** CLI 的管理命令在进程内调用服务层的同一个方法，`--json` 输出就是那个方法的结果（§3.2）。
- **主程序保持单文件、静态。** PDF、内置浏览器、电脑操控做成按需安装的组件（§8.4）。实测静态 Linux 构建加载不了动态库，所以 PDF 在 Linux 上由一个独立的 worker 进程承担（§13.3）。
- **JSON-RPC 分三档。** 稳定、实验、内部；只对稳定档承诺兼容（§9.2）。
- **不开端口。** 远程靠 `ssh host finx acp`、`ssh host finx serve --stdio`，不用新代码（§9.5）。
- **不退化。** 非交互路径的启动和内存指标一个都不能变差（§15）。
- **命令有规矩，测试把关。** 一个概念只有一种控制方式、一个名字。运行参数不保存，`--json` 总是一个 JSON 值，打错字给提示而不是开会话（§4）。

**工作量：** 一期约 38 个人天，可以并行，日历上约 3 周，不含等密钥和等拍板（§17）。

## 目录

- 0. 阅读说明
- 1. 目标与范围
- 2. 现状与差距
- 3. 总体架构
- 4. 命令总览
- 5. 交互模式
- 6. 脚本模式
- 7. 模型接入
- 8. 工具
- 9. JSON-RPC
- 10. ACP
- 11. 数据与多版本共存
- 12. 安全与隐私
- 13. 打包、发布与升级
- 14. 文档与示例
- 15. 性能约束
- 16. 测试与验收
- 17. 实施计划
- 18. 需要拍板的事
- 19. 决策与待定问题
- 20. 按需再加

## 0. 阅读说明

| 术语 | 含义 |
|---|---|
| 入口 | 对外的三种方式：CLI、ACP、JSON-RPC |
| 原生协议 | JSON-RPC 入口说的协议（protocol-design §6），和 JSON-RPC 入口指同一件事 |
| 交互模式 | 不带子命令运行 `finx`，在终端里连续对话 |
| 活动区 | 交互模式占用的终端底部几行：还没写完的一行回复、状态行、排队的消息、输入框 |
| 组件 | 主程序之外按需安装的文件：PDF、内置浏览器、电脑操控 |
| 清单 | 每个版本发布的 `finx-manifest.json`：版本号和每个文件的地址、大小、摘要 |

**证据：** 标"实测"的内容在 2026-11-05 跑过：提交 `f14baf5` 的 `dist` 构建（macOS arm64），复制到仓库外，用隔离的 `FINX_HOME` 和模拟模型；Linux 部分在一台 1 vCPU 的 Debian 13 测试机上跑。之后合入的定时任务不影响这些结论。没标的内容来自读代码和已有文档。这一轮没有调用真实模型。

**变更记录：**

| 版本 | 日期 | 说明 |
|---|---|---|
| v0.1 | 2026-11-05 | 初稿 |
| v0.2 | 2026-11-05 | 默认模型改定并实现（§7.2）：去掉写死的 DeepSeek；没配 `model` 时用第一个能用的服务商的首个模型；什么都没配时没有默认模型，命令行、JSON-RPC、ACP、桌面端都提醒去设置（D-506 改写，D-534–D-537，Q-313） |
| v0.3 | 2026-11-05 | 命令规则写进 §4（D-538–D-544）：控制方式和命名规则；运行选项表；继续会话只留两种写法；`--json` 总是一个 JSON 值；打错字给提示；改名：`models show` 改 `unhide`、`sessions rm` 改 `remove`、`web-search test` 改 `check`、`--here` 改 `--local`、`/title` 改 `/rename`；`finx completion`、`exec --image`；`finx chat` 隐藏；测试把关。除 §7.2 外都未实现 |
| v0.4 | 2026-11-05 | 现有命令的改名、`--json`、错误、帮助和规则测试已实现（§4.9）；`finx resume` 先去掉，交互模式做好时加回来；规则测试放在 `finx-cli/src/cli_shape.rs`，登记表是 `finx-cli/cli_surface.json` |
| v0.5 | 2026-11-05 | 一期 A–F 包实现：`finx login`、`models check`、Gemini；`finx tools`、MCP 审批、`config`、组件、`upgrade`；交互模式；分档、示例、ACP 登录；发布脚本、安装脚本、用户文档。D-545–D-553，现状见 §21 |
| v0.6 | 2026-11-06 | 负责人接受棘轮标出的启动回退（§21.3，D-554） |

## 1. 目标与范围

### 1.1 目标

| 编号 | 目标 | 含义 |
|---|---|---|
| SG1 | 独立 | 不依赖 FinxWork、Rust、Node。一个可执行文件，装上就能用 |
| SG2 | 一条路走通 | 新用户从安装到第一个任务，只看终端提示就够，不用读文档 |
| SG3 | 三个入口都开放 | CLI、ACP、JSON-RPC 都有公开文档和兼容承诺，都有真实场景的验收 |
| SG4 | 模型接入完整 | API Key、账号订阅、本机模型、自建或第三方兼容服务四条路都走得通，每家有明确的验收状态 |
| SG5 | 工具完整 | 工具有公开的清单和契约，缺依赖时说得清怎么装；能通过 MCP、Skill 扩展 |
| SG6 | 能升级、能共存 | 自带升级；和 FinxWork 共用数据目录时，谁新谁旧都不会把对方弄坏 |
| SG7 | 不退化 | 启动、内存和桌面端的行为都不因为这件事变差 |

### 1.2 范围

| 做 | 不做 |
|---|---|
| macOS（arm64、x64）、Linux（x64、arm64） | Windows（§18.2） |
| 交互模式，保留终端自己的滚动区 | 全屏界面（§20） |
| JSON-RPC 走 stdio 和 Unix socket，远程走 ssh | 监听 TCP、HTTP、WebSocket（§20） |
| 公开文档、示例、TS SDK（二期） | 云端托管、多租户 |
| CLI 管理密钥、模型、工具、配置、会话 | 桌面端专属的界面能力：文档编辑面板、Bot、定时任务不进 CLI 命令（§3.3） |

### 1.3 做成的样子

一期的验收就是下面这几个场景，全部在干净环境里跑（细节见 §16.2）。

| 编号 | 场景 | 通过的标准 |
|---|---|---|
| S1 | 安装 | 一条命令装好；`finx --version` 能跑；macOS 上不被 Gatekeeper 拦 |
| S2 | 第一次运行 | `finx` 引导登录，选模型，收到第一条回复 |
| S3 | 交互 | 多步改代码的任务：审批、打断、运行中插话、继续上次的会话 |
| S4 | 脚本 | CI 里 `finx exec --output json`，退出码和结果对象都能用来判断成败 |
| S5 | 编辑器 | 在真实编辑器里配上 `finx acp`，登录，改文件，审批 |
| S6 | 程序 | 不装任何依赖的 Python 示例通过 JSON-RPC 跑完一个带审批的任务 |
| S7 | 升级与共存 | `finx upgrade` 之后配置和会话都在；和 FinxWork 共用 `~/.finx`，两边都能用 |
| S8 | 模型 | 一级服务商全部通过 `finx models check`（§7.6） |
| S9 | 工具 | `finx tools --json` 列出全部工具；缺组件的工具报错时说清怎么装 |

## 2. 现状与差距

| 方面 | 现状 | 差距 | 章节 |
|---|---|---|---|
| 运行 | 单文件，32 MB，gzip 后 13 MB，只依赖系统库；复制到仓库外能跑（实测） | 无 | — |
| 交互 | `finx` 报用法错误，退出 2；隐藏的 `finx chat` 能对话但没有工具（实测） | 没有带工具的交互模式。总方案把它定给了桌面端（Q-12） | §5 |
| 首次运行 | 默认模型已按实际接入的服务商来定，什么都没配时提醒去设置（§7.2，已实现）。保存密钥只有协议方法 `auth/set` | 没有登录命令 | §7 |
| 脚本 | `--output json`、事件流、`--ops-stdin` 都能用（实测） | 没有可用的批准人时写操作被拒，模型说完就结束，退出码还是 0，文件没写（实测）。点名或配置了没密钥的模型时也建会话，还提示"继续" | §6 |
| JSON-RPC | 101 个方法，stdio 和 Unix socket，有 Schema；完整任务跑通（实测） | 方法不分档，桌面专用的混在一起；没有公开文档；TS 包是私有的；没有列工具的方法 | §9 |
| ACP | 会话方法、审批、切模型都有；完整任务和审批跑通（实测） | `authMethods` 为空，`authenticate` 返回 -32601；配置了没密钥的模型时 `session/new` 成功、`session/prompt` 才报 -32020（实测）；配置项和审批按钮是写死的中文（实测）；没在真实编辑器里验过 | §10 |
| 模型 | 三种线协议，15 个内置渠道，公共目录，ChatGPT 订阅登录 | 没有 Gemini；OpenAI、Anthropic 官方接口等没有真实验收；本机账号连接没有 CLI 入口 | §7 |
| 工具 | 基础工具、子智能体、联网搜索、文档、浏览器、电脑操控、MCP、Skill | `finx status` 只显示 4 个；没有清单命令和公开契约；MCP 工具任何模式都不审批（D-107）；外部钩子没做；缺 PDFium 时 PDF 打不开，静态 Linux 根本加载不了（实测） | §8 |
| 共存 | 单实例服务、会话文件锁、桌面端的版本替换策略都有 | 配置文件里有一个不认识的键，所有命令连同 `finx acp` 都退出 2（实测），`models.toml` 也一样（实测）；运行中的服务不会发现别的进程保存的新密钥 | §11 |
| 发布 | 桌面端的发布流程已经做完 | CLI 没有产物、没有发布仓库、没有升级；`publish = false`；仓库私有；根目录没有 README 和 LICENSE；CI 只跑 `finx-core`、`finx-llm` 的单元测试和启动门槛 | §13、§16 |
| 平台 | macOS、Linux 能跑 | Windows 没有任何构建，32 个文件直接用 Unix API | §18.2 |

## 3. 总体架构

### 3.1 三个入口

```
   人                 脚本              编辑器              程序、SDK、桌面端
    │                  │                  │                      │
  finx             finx exec           finx acp      finx serve --stdio / --listen
    │                  │                  │                      │
    │                  │               ACP 投影              原生协议投影
    │                  │                  └──── finx-server ─────┘
    └──────────────────┴────────────┬─────────────┘
                                    │  Op / Event
                              finx-core（内核）
             finx-llm · finx-tools · finx-mcp · finx-browser · finx-docs …
```

- **交互模式和 `exec` 直接驱动 `Kernel`**，不起服务（D-503）。它们只有一个会话和一个前端，不需要会话中枢；`exec` 现在就是这样，启动快的主要原因之一也在这里。
- **`serve` 和 `acp` 经过 `finx-server`**，一次编码，互不转换（protocol-design §2）。
- **三个入口都不碰模型和工具的细节。** 新增一家模型或一个工具，三个入口同时生效。

### 3.2 每件事归谁

| 内容 | 归属 | 入口怎么用 |
|---|---|---|
| 任务、审批、工具、上下文、压缩 | 内核 | 发 Op、收 Event |
| 管理：密钥、配置、技能、MCP、模型菜单、连接、联网搜索 | `finx-server` 的方法，内部调 `finx-core` | JSON-RPC 直接调用；**CLI 在进程内调用同一个方法**；ACP 只开放标准里有的部分 |
| 展示：回复怎么排版、审批怎么问 | 各入口自己 | 不进内核 |

**为什么 CLI 直接调服务层方法（D-502）：** 保存密钥要先验证、联网搜索加密钥要先真实搜一次并调整顺序，这些规则现在写在 `Server::set_key`、`Server::web_search_set_key` 里。CLI 依赖了 `finx-server`，构造一个 `Server` 再调方法就行：不用搬代码，也不可能和桌面端的规则分叉。这些是偶尔才用的命令，构造服务的开销无所谓。`--json` 的输出就是方法的结果，已有的 `finx models --json` 与 `models/list` 相同，就是这个约定。

### 3.3 能力对照

| 能力 | 交互模式 | `exec` | JSON-RPC | ACP |
|---|---|---|---|---|
| 任务、工具、审批 | ✓ | ✓ | ✓ | ✓ |
| 运行中插话、排队 | ✓ | `--ops-stdin` | ✓ | —（任务在跑时再发 prompt 返回 `prompt_in_progress`） |
| 打断 | ✓ | ✓ | ✓ | ✓ |
| 撤回重发 | `/rewind` | `--ops-stdin` | ✓ | — |
| 切模型、推理等级、权限模式 | ✓ | 启动参数，`--ops-stdin` | ✓ | 配置项 |
| 子智能体 | ✓ | ✓ | ✓ | 显示成一个工具调用，它的审批也转给客户端 |
| `/compact`、`/context`、`/skill:name` | ✓ | ✓ | ✓ | ✓ |
| 会话列表、恢复、删除 | ✓ | `finx sessions`、`resume` | ✓ | ✓ |
| 登录、配置、技能、MCP 管理 | ✓ | 对应子命令 | ✓ | 只有登录（§10.1） |
| Bot、定时任务、文档编辑面板、内嵌浏览器 | — | — | 实验或内部档 | — |

不强求每一格都打勾（D-501）。JSON-RPC 能力最全，ACP 守标准不加私有扩展（D-28），CLI 只给人和脚本真正用得上的。

## 4. 命令总览

### 4.1 命令表

| 命令 | 作用 | 状态 | 期 |
|---|---|---|---|
| `finx ["PROMPT"]` | 交互模式；接受运行参数（§4.3） | 新 | 一 |
| `finx exec "PROMPT"` | 跑一个任务；`--resume <last\|ID>` 接着一个会话跑 | 改：预检、退出码、`--tools`、`--add-dir`、`--image`（§6）；`--json` 改成一个结果对象（§4.6）；去掉 `--continue`（§4.4） | 一 |
| `finx resume [last\|ID] ["PROMPT"]` | 在终端里继续会话，默认 `last`，只进交互模式；没有终端时退出 2，提示用 `finx exec --resume` | 新 | 一 |
| `finx login [PROVIDER]`、`finx logout PROVIDER` | 接入模型（§7.3） | 新 | 一 |
| `finx models`、`hide`、`unhide` | 模型菜单 | 改：`show` 改名 `unhide`（§4.4） | 一 |
| `finx models check [MODEL]` | 真实请求检查一个模型（§7.6） | 新 | 一 |
| ~~`finx connections …`~~ | 本机账号连接不进公开版，也就不加这组命令（§7.7、§18.3） | 不做 | — |
| `finx tools [NAME] [--all] [--json]` | 工具清单和定义（§8.3） | 新 | 一 |
| `finx install <pdf\|browser\|computer>`、`finx uninstall …` | 组件（§8.4）；`finx browser install` 继续可用 | 新 | 一 |
| `finx config [list]`、`get`、`set`、`unset`、`path` | 配置，调 `config/read`、`config/write`；`--show-origin` 写明每个值来自哪一层 | 新 | 一 |
| `finx sessions`、`remove`、`rename` | 会话；`remove` 移入回收目录 | 改 | 一 |
| `finx web-search status\|set-key\|check` | 联网搜索，调 `web_search/*` | 新 | 一 |
| `finx mcp [list]`、`finx skills` | 不带动词就是列表；写入范围统一（§4.4） | 小改 | 一 |
| `finx trust [DIR] [--remove]` | 项目信任 | 改 | 一 |
| `finx status`、`finx doctor [--online] [--strict]` | 现状和诊断。`doctor` 新增组件状态和配置警告（§8.4、§11.2）；`--online` 加一次真实请求；`--strict` 把警告算失败 | 改 | 一 |
| `finx serve`、`finx protocol schema` | JSON-RPC | 已有，Schema 加分档 | 一 |
| `finx acp [--login]` | ACP（§10.1） | 改 | 一 |
| `finx upgrade [--check] [--version V]` | 升级（§13.9）；`finx update` 是别名 | 新 | 一 |
| `finx completion bash\|zsh\|fish` | 打印补全脚本，也是 Homebrew 公式生成补全的入口 | 新 | 一 |
| `finx chat` | 只用模型层对话。隐藏，不进帮助：查模型用 `finx models check`，和智能体对话用 `finx`。人会把 `chat` 当成主入口，然后发现它没有工具 | 改 | 一 |

**其他约定：**

- 密钥只从标准输入读，不进参数，也就不进 shell 历史：`finx login deepseek --key-stdin`、`finx web-search set-key tavily`。
- **语言**：面向人的文字按 `FINX_LANG`，其次 `LC_ALL`、`LC_MESSAGES`、`LANG` 决定，以 `zh` 开头时用中文，其他情况用英文。`--help` 只有英文。面向模型的文字一律英文（D-520）。
- **扩展靠 Skill 和 MCP。** `finx foo` 不会去找 `PATH` 里的 `finx-foo`。
- **隐藏的命令**要么是内部的（`doc-worker`、`connector`、`interactive`、`browser native-host`、`chat`），要么正在废弃。

### 4.2 一个概念，一种控制方式，一个名字（D-538）

目标是懂 git 的人猜得到。加东西之前先看能不能扩展现有的：每多一个控制项，以后想收回都要走一次废弃流程。

按顺序问，第一个"是"就停：

| 问题 | 用 |
|---|---|
| 是一个动作吗 | 子命令：动词，或名词加动词。交互模式里用同名的斜杠命令 |
| 是动作的对象吗 | 位置参数 |
| 是密钥吗 | 凭据存储，环境变量只给 CI。不进参数（会出现在 `ps` 和 shell 历史里），不进配置文件 |
| 只影响这次运行吗 | 参数 |
| 要一直生效吗 | 配置项，外加同名参数用来临时覆盖 |
| 是 CI、包装脚本、终端、诊断或测试在设吗 | 环境变量（§6.4） |
| 还没做完吗 | `experimental.<name>` 配置项，默认关，只能写在用户层，不单开参数和环境变量。做完或放弃时，没有什么人们敲过的东西要删 |

**同一个概念在各处的写法：** 配置和 JSON 字段用 `snake_case`，参数用 `kebab-case`，环境变量用 `FINX_` 加大写。取值在哪都用同一组词。

每个运行选项在下表占一行。个别入口的名字可以不同（ACP 的字段名由规范决定），但都要写在这里，测试按它检查（§4.7）：

| 选项 | 命令行 | 配置 | 环境变量 | JSON-RPC | ACP |
|---|---|---|---|---|---|
| 模型 | `-m`、`--model` | `model` | `FINX_MODEL` | `model` | `model` |
| 推理等级 | `--thinking` | `thinking` | — | `thinking` | `thinking` |
| 权限模式 | `--permission-mode` | `permission_mode` | `FINX_PERMISSION_MODE` | `permission_mode` | `permission_mode` |
| 工作目录 | `--cwd` | — | — | `cwd` | `cwd` |
| 额外目录 | `--add-dir` | `extra_writable_roots` | — | `extra_roots` | `additionalDirectories` |
| 内置工具 | `--tools` | `tools.enabled` | — | — | — |
| 轮次上限 | `--max-turns` | `max_turns` | — | — | — |

**运行参数不保存，设置命令才保存（D-539）。** `--model`、`--permission-mode` 只影响这一次，就像 `git pull --rebase` 不会改 `pull.rebase`。专门改东西的命令才保存，并打印一行写明值和文件：

```
$ finx config set thinking low
thinking set to low in ~/.finx/config.toml
```

`config set`、`unset`，`login` 选模型，`models hide`、`unhide`，`trust`，`mcp`、`skills` 的增删和开关都这样。这也回答了"默认模型怎么固定"：`finx config set model <ID>`，不另加命令。

**只看的命令不改东西。** `status`、`doctor`、`models`、`tools`、`sessions`、各种 `get` 和 `list` 只读（刷新缓存除外），脚本和智能体可以放心调。

**`finx config` 的范围和安全项（D-540）：**

- `get` 不带范围时给实际生效的值，`--show-origin` 写明它来自哪一层，和 `git config --show-origin` 一样。层次是现成的（`config/read` 的 `origins`）。
- 配置项分两类，改权限的（`permission_mode`、`rules`、`hooks`、`mcp_servers`、`extra_writable_roots`、`tools.bash.pass_provider_keys`、`browser.sites` 这一类）单独列一张表。环境里有 `AI_AGENT` 时，`set` 和 `unset` 拒绝改这些键，并说明要人自己在终端里改。场景：用户图省事给 `finx config` 开了"总是允许"，只想让模型调一下 `thinking`，模型却能顺手把权限模式改成完全访问。这不是安全边界（模型可以清掉变量），只是多一道。

### 4.3 参数

- **跑智能体的命令用同一组运行参数**，只在 `RunArgs` 定义一次：`finx`、`exec`、`resume` 都接受 `-m`、`--thinking`、`--permission-mode`、`--cwd`、`--add-dir`。`acp`、`serve` 用全局的 `-c` 设默认值。
- **后写的赢。** 参数重复或冲突时取最后一个（clap 的 `args_override_self`、`overrides_with`，现在是报错），这样 `alias finx='finx --permission-mode manual'` 之后还能临时改。
- **布尔参数成对：** `--x`、`--no-x`。枚举是一个带值的参数，值不进参数名。
- **短参数稀缺，只有：** `-h` 帮助、`-V` 和 `-v` 版本、`-c` 覆盖配置（和 `git -c` 一样）、`-m` 模型。
- **别的工具带来的写法给指引，不做别名：** `finx -p`、`--print` 退出 2，说用 `finx exec "PROMPT"`；`finx --continue`、`--resume`、`-r` 退出 2，说用 `finx resume`。

### 4.4 定下来的名字（D-541）

第一个公开版之前改名没有代价，所以现在一次改好，不留别名。

**继续会话只有两种写法：**

| 写法 | 用在 |
|---|---|
| `finx resume [last\|ID] ["PROMPT"]` | 终端里接着聊。不在终端时退出 2，提示用下一种 |
| `finx exec --resume <last\|ID> "PROMPT"` | 脚本里接着跑 |

交互模式里是 `/resume`。去掉 `finx exec --continue` 和 `finx resume -p`，也不做 `finx --continue`：它们都是同一件事的另一种写法。这种写法一旦放出去就收不回来。

**动词：**

| 动词 | 意思 | 用在 |
|---|---|---|
| 不带动词，或 `list` | 列表 | `models`、`sessions`、`skills`、`tools`、`connections`、`config`、`mcp` |
| `get` | 看一个，不改东西 | `mcp get`、`config get` |
| `add`、`remove` | 增删。不用 `rm`、`delete` | `mcp`、`skills`、`sessions remove` |
| `enable`、`disable` | 开关 | `mcp`、`skills` |
| `set`、`unset` | 设值 | `config` |
| `hide`、`unhide` | 模型菜单 | `models` |
| `login`、`logout` | 账号 | 顶层、`mcp` |
| `install`、`uninstall` | 组件 | 顶层 |
| `check` | 真的连一下试试 | `models check`、`web-search check`、`mcp list --check` |
| `status` | 这一组现在的状态 | 顶层、`web-search` |

几处因此改名：

- `finx models show` 改成 `unhide`。`show` 在大多数工具里是看详情，敲 `finx models show x` 想看详情的人，会悄悄改掉自己的菜单。协议方法 `models/show` 不变。
- `finx sessions rm` 改成 `remove`；`finx web-search test` 改成 `check`，和同类命令一致。
- `finx mcp` 不带动词也是列表，和其他分组一样。
- 复数的分组名不改。`finx models`、`finx sessions` 读起来自然，不带动词就是列表，不需要再分出 `session` 和 `sessions` 两个命令。

**写入范围：**

| 词 | 写到哪 | 配置层 |
|---|---|---|
| `--global`（默认） | `~/.finx/config.toml` | `user` |
| `--local` | `~/.finx/projects/<key>/config.toml`，只有自己，只在这个项目 | `user_project` |
| `--project` | `<project>/.finx/config.toml`，进仓库 | `project` |

`--here` 改名 `--local`，和 git 同义。

**斜杠命令：** 动作用子命令的名字，改设置用配置项的名字和取值。所以 `/title` 改成 `/rename`，和 `finx sessions rename` 一致；`/permissions` 是唯一的简写，因为 `/permission-mode` 太长。`/exit` 和 `/quit` 相同，不然它会被当成普通文字发给模型（§5.6）。

### 4.5 第一个词（D-504、D-542）

**命令行解析不能变慢。** `main` 在解析之前看第一个不是全局选项（`-c`、`--config`、`--mcp-config`）的词：没有这个词，或者它不是已知的子命令，也不是帮助和版本，就走下表。这样 clap 的根命令不用多带一组参数，其他命令的解析开销不变。

| 输入 | 结果 |
|---|---|
| `finx`、`finx -m ID` | 交互模式，在最前面插入隐藏子命令 `interactive` |
| `finx "修复登录页的测试"` | 交互模式，这句话作为第一条消息 |
| `finx -- status 怎么看` | `--` 之后都是提示词 |
| `finx 修复 登录页 测试` | 退出 2：提示词要加引号。多个没加引号的词多半是打错了，或者 shell 已经展开了里面的 `*`、`?` |
| `finx stauts` | 退出 2：`did you mean finx status?`，同时给出当提示词发送的写法。不然一个手误就开了一个会话、花了一次模型请求 |

**怎么算接近：** 用相邻对调算一步的编辑距离（`strsim`，clap 已经带了）。命令名不到 6 个字母时差 1 步，否则差 2 步，所以 `hello` 不会被当成 `help`。只在这条路径上算。

每多一个命令名，就少一个能当提示词的词。起名时选没人会单独当一句话敲的词。`finx update` 因此是别名：它和 `upgrade` 差太远，不做别名就会开一个会话。

`parse_plain` 的测试里 `finx` 目前算"错误用法"，要改过来。

### 4.6 输出和错误（D-543）

- **结果写 stdout，进度和诊断写 stderr。**
- **`--json` 在所有命令里都是一个 JSON 值，内容是对应方法的结果。** 现在 `finx exec --json` 是事件流（JSON Lines），`--output json` 才是一个结果对象，于是 `finx exec --json "…" | jq .final_output` 拿不到结果。改成 `--json` 等于 `--output json`，事件流只走 `--output stream-json`。
- **失败也一样。** 参数里有 `--json` 时，错误（包括用法错误）写到 stdout，字段和 `exec` 的结果对象相同，stderr 不写：

  ```json
  {"error": {"kind": "no_model", "message": "no model is set up"}, "exit_code": 2}
  ```

- **字段只增不改（§9.3）。** 非改不可时用 `--json=v2`，第一次需要时再做。
- **没有终端时绝不提问。** 直接退出，并写明用哪个参数可以不用提问。
- **错误说清三件事：** 出了什么事、是哪个输入、该怎么办。打错的给最接近的写法。
- **`NO_COLOR` 和 `TERM=dumb` 都关颜色。** 现在只看 `NO_COLOR`。
- **顶层帮助按用途分组，每条一行，带几条例子。** 现在是一张平铺的表，有的说明长到折行。分组写在 clap 的 `help_template` 里，测试检查每个没隐藏的子命令都出现、只出现一次，帮助不会和命令表走样：

  ```
  Usage: finx ["PROMPT"]
         finx <COMMAND>

  Run:     exec, resume, sessions
  Models:  login, logout, models, connections
  Extend:  tools, mcp, skills, web-search, browser, install, uninstall
  Setup:   config, trust, status, doctor, upgrade, completion
  Serve:   serve, acp, protocol
  ```

### 4.7 怎么改，谁把关（D-544）

**改名和移除。** 命令、参数、配置键、环境变量都标一档：稳定、实验、废弃、内部。公开之后，改名或移除稳定项时，旧写法继续能用并警告，至少两个版本、至少 30 天。警告写明哪个版本去掉，这个版本号是一个常量，版本到了测试就失败，旧写法不会被忘掉。配置键改名时旧名继续读，保存时迁移，`finx doctor` 报告。

**测试把关**（`crates/finx-cli/src/cli_shape.rs`，读真实的命令树和源码）：

- 长参数都是 `kebab-case`，参数名里没有值；配置键都是 `snake_case`；
- 子命令的动词只来自 §4.4 的表，例外要写明原因；
- 每个能看到的命令都登记了打印什么：有 `--json`、只打印 JSON，或者不打印数据；
- 每个没隐藏的子命令在顶层帮助里出现一次（§4.6）；
- 代码里的每个 `FINX_*` 都登记在 `crates/finx-cli/cli_surface.json`，写明作用和档；登记了代码里却没有也算失败。新的测试变量要以 `FINX_TEST_` 开头；
- 总方案和协议方案提到的 `FINX_*` 都要真实存在。`FINX_DEBUG_HTTP` 这种文档写了、代码里没有的情况（§6.4）就是这样漏出来的；
- 运行选项表（§4.2）的每一行都对得上：`finx exec` 有这个参数，配置键真能加载，环境变量的名字和配置项相同，`session/new` 有这个字段，ACP 有这个选项；反过来，ACP 提供的选项、`finx exec` 的参数都要在登记表里；
- 废弃的写法写明哪个版本去掉，版本到了就失败。现在有 `--approval` 和 `FINX_APPROVAL`，0.3.0 去掉。

规则只有一份，改命令的人和评审的人都看 §4.2–§4.6。

### 4.8 新增的配置项

| 配置项 | 默认 | 说明 |
|---|---|---|
| `ui.show_thinking` | `false` | 推理内容是否写进滚动区（§5.7） |
| `history.enabled` | `true` | 是否保存输入历史（§5.4） |
| `update.check` | `true` | 交互模式是否检查更新（§13.9） |
| `mcp_servers.<name>.approval` | 不设 | `never`：信任这个服务器，只能写在用户层（§8.5） |
| `[[hooks]]` | 无 | 外部钩子，二期，未实现（§8.6） |

### 4.9 已经做到哪（2026-11-05）

§4.1 的命令全部实现，规则测试（§4.7）管着全部命令。和前面写的不同的地方：

- `finx connections` 不做（§7.7）；
- `config path`、`web-search set-key`、`sessions rename` 是动词表之外的例外，原因写在 `cli_surface.json`；
- 第一个词的判断（§4.5）在 `main.rs` 的 `first_word`，用一张写死的命令名单，不建解析器；`cli_shape` 检查名单和命令树一致；
- `RunArgs` 只留运行参数，`finx exec` 自己的输出和输入参数在 `ExecArgs`；
- `finx --help` 第一行改成 "finx: an AI agent for your terminal, your editor and your programs"（Q-308）。

## 5. 交互模式

### 5.1 样子

```
$ finx
finx 0.2.0 · deepseek/deepseek-flash · 逐项确认 · ~/code/app
› 修复登录页的测试

• bash cargo test login
  ✗ exit 101 · 3.2s
• read src/login.rs
• edit src/login.rs (1 change)

? 允许修改 src/login.rs
  - let timeout = 30;
  + let timeout = 60;
  [y] 允许   [a] 本会话允许所有修改   [n] 拒绝   [q] 停止任务
> y
  ✓ Edited src/login.rs
测试超时是因为…                                      ← 还在写的一行
⠹ 正在回复 · 12s · 1,204 tokens · 上下文 18%         ← 状态行
↳ 跟进：顺便更新 changelog（Tab 提前，↑ 取回）        ← 排队的消息
› 也跑一下集成测试_                                   ← 输入框
```

最后四行是活动区，其余都已经写进终端的滚动区。

### 5.2 为什么不做全屏（D-505）

保留终端自己的滚动区：滚动、搜索、选中复制都是终端原有的，退出后内容还在，SSH 和 tmux 里也一样。代价是做不了分栏和面板，这些桌面端有。

不引入界面框架。活动区只有几行，整块重画就够了，依赖只有 `crossterm` 和 `unicode-width`，只有 `finx-cli` 用到。

### 5.3 活动区怎么画

完成的内容一行一行打进滚动区，之后就归终端管。每次更新：

1. 光标回到活动区第一行，清到屏幕底；
2. 打出新完成的行，它们自然滚进滚动区；
3. 重画活动区；
4. 把光标放到输入框的编辑位置，这样输入法的候选窗才在对的地方。

- 一次重画包在同步输出（`CSI ? 2026 h/l`）里，不支持的终端会忽略，不闪屏。
- 重画合并，最多约每 33 ms 一次。事件照常收，只是不逐个画，流式再快也不占多少 CPU；空闲时不重画。
- 行数按 `unicode-width` 算，中文占两列。算错时最坏是活动区多留或少留一行，下一次重画或 `Ctrl-L` 就恢复，不影响内容。
- 终端尺寸变化时重算，只重画活动区。滚动区里的内容由终端自己重新折行。

### 5.4 输入与按键

用原始模式，一个线程阻塞读键盘事件，经 channel 进事件循环。运行时沿用 `exec` 的单线程 runtime。

| 按键 | 空闲时 | 任务运行时 |
|---|---|---|
| 回车 | 发送 | 插话：下一步送达（`Op::Prompt`，`mode: steer`） |
| `Tab` | 补全 `/` 命令和路径 | 输入框有字：作为跟进发出，任务结束后送达（`mode: follow_up`）。输入框为空且有排队：把最后一条提前一档，跟进变插话（`Op::Requeue`），插话变立即送达（`Op::SteerNow`） |
| `Alt+回车`、`Ctrl+J`；终端支持时 `Shift+回车` | 换行 | 换行 |
| `↑` | 输入历史 | 输入框为空且有排队时，取回最后一条（`Op::Withdraw`，文字回到输入框） |
| `Ctrl+C` | 有字清空；空的时候 2 秒内按两次退出 | 打断任务（`Op::Interrupt`）；2 秒内再按退出，与 `exec` 相同 |
| `Ctrl+D` | 空的时候退出 | 同左 |
| `Ctrl+L` | 重画 | 重画 |
| `Ctrl+Z` | 恢复终端后挂起，`fg` 回来继续 | 同左 |

- **粘贴**：打开括号粘贴。多行内容原样进输入框，不会被当成多次回车。
- **输入历史**：保存在 `$FINX_HOME/history.jsonl`，权限 0600，按项目过滤。`history.enabled = false` 关闭。
- **运行中的语义** 全部是已有的队列（input-queue-design）：`queue_changed` 给完整队列，活动区逐条显示；模型看到的仍是普通用户消息。

### 5.5 审批

事件 `approval_requested` 已经带 `args`，内容够显示。CLI 比现在的行内询问多做一件事：**让人看见要改什么。**

| 工具 | 显示 |
|---|---|
| `edit` | 每处修改的 `old_text`、`new_text`，按 diff 显示 |
| `write` | 路径和字节数，内容开头几行 |
| `bash` | 完整命令，加上判定的原因 |
| 其他 | `summary` 和 `reason` |

超过一屏时折叠，输入 `v` 展开。回答和 `exec` 一样是一行字加回车（D-551）。选项和 `approval_prompt.rs` 一样：`y`、`a`（有规则或模式可记时才出现）、`n`（可附一句说明）、`q`，网站权限用数字。这部分代码共用，`exec` 也跟着得到 diff。子智能体的审批同样一次问一个，开头带它的名字。

等待审批时键盘归审批，输入框里的字保留。

### 5.6 斜杠命令

只有完全匹配下表的词才算命令，其余一律当普通文字发出，`/etc/hosts 是干什么的` 不会被吃掉。

| 命令 | 做什么 | 怎么实现 |
|---|---|---|
| `/help` | 按键和命令 | 本地 |
| `/compact`、`/context`、`/skill:name` | 内核命令 | 原样发送，内核处理 |
| `/model [ID]` | 列模型菜单或切换 | `finx_core::models::list`、`Op::SetModel` |
| `/thinking [LEVEL]` | 推理等级 | `Op::SetModel` |
| `/permissions [MODE]` | 权限模式 | `Op::SetPermissionMode` |
| `/new` | 开新会话 | `Kernel::shutdown` 后 `Kernel::start` |
| `/resume [ID]` | 列本项目的会话，或继续一个 | `SessionStore::list`、`Kernel::resume`，打印最近的记录 |
| `/rewind` | 选一条发过的消息，文字回到输入框，发送才真正回退 | `Op::Resend`（message-resend-design） |
| `/rename TEXT` | 命名会话 | `Op::SetTitle` |
| `/status`、`/tools`、`/mcp`、`/skills` | 和对应子命令相同 | 本地 |
| `/login` | 同 `finx login`，成功后可以马上 `/model` 切过去 | 本地 |
| `/quit`、`/exit` | 退出 | 本地 |

### 5.7 显示

- **回复**：按行处理，写完的一行才进滚动区。标题加粗，代码块和行内代码换色，其余原样。表格、链接不做特殊处理。还没写完的一行留在活动区。
- **推理内容**：默认不进滚动区，状态行显示"正在思考 · 8s"。`ui.show_thinking = true` 时以暗色写入。
- **工具**：沿用 `render.rs` 的两行格式。运行中活动区显示输出的最后三行（`tool_progress`）。
- **其他事件**：压缩、重试、子智能体开始结束、MCP 状态、警告，和 `exec` 用同一套文字。

`render.rs` 拆成"事件变成哪些行"和"写到哪里"两层，`exec` 的输出保持不变：回复写 stdout，其余写 stderr。

### 5.8 启动、退出和异常

- **启动**：`Kernel::start` 走完才显示输入框。它不等 MCP（服务器在后台连接），所以慢的服务器不挡打字，不需要把内核也放到后台（D-550）。会话文件沿用现有逻辑，第一次有内容才创建。
- **要求终端**：stdin 或 stdout 不是终端，或者 `TERM=dumb`，退出 2，提示改用 `finx exec`。
- **没有可用模型**：进入登录流程（§7.3）。
- **退出**：打印用量和 `finx resume`。
- **恢复终端**：退出路径、panic 钩子、`SIGTERM`、`SIGHUP` 都要恢复原始模式和括号粘贴。
- **信任**：见 §12.2。

### 5.9 代码结构

| 位置 | 内容 |
|---|---|
| `crates/finx-cli/src/cmd_interactive.rs` | 事件循环：键盘、内核事件、重画定时 |
| `crates/finx-cli/src/term/live.rs` | 活动区 |
| `crates/finx-cli/src/term/editor.rs` | 输入框：光标、换行、宽字符、历史、补全 |
| `crates/finx-cli/src/term/markdown.rs` | 按行排版 |
| `crates/finx-cli/src/render.rs` | 拆成行格式化和输出，`exec` 与交互模式共用 |
| `crates/finx-cli/src/approval_prompt.rs` | 审批的显示和判定，两边共用 |

## 6. 脚本模式

`exec` 的输出和参数基本够用（technical-design §12）。这里补四件事。

### 6.1 退出码（D-508）

| 退出码 | 含义 | 变化 |
|---|---|---|
| 0 | 任务完成 | |
| 1 | 任务失败 | |
| 2 | 参数或配置错误，包括没有凭据 | 新增"没有凭据"这一类。什么模型都没设置时已经是 2（§7.2，已实现） |
| 3 | 任务跑完了，但有操作因为没人能批准被拒绝 | 新增 |
| 130 | 被打断 | |

**为什么要 3。** 场景：CI 里 `finx exec "修复测试"`，忘了设权限模式。写文件被拒，模型回一句"我没有权限"，退出码 0，流水线显示成功，实际什么都没改（实测）。这是最坏的一种失败。退出 3 之后流水线立刻红，提示也说得清。代价是：模型只是试了一条被拒的命令、换别的办法答对了的情况也会退出 3；这种任务设一下权限模式或规则就好。

实现：`tool_exec.rs` 走到 `Approval::NoApprover` 时发一条 `warning`（新的 `WarningCode`），`exec` 数它，结束时在 stderr 汇总一行，并在 JSON 里加 `refused: [{name, summary}]`。

### 6.2 预检（D-507）

开始之前先解析模型、看有没有凭据。没有就退出 2，不建会话，也不提示"继续"。

什么模型都没有的情况已经这样做了（§7.2）。这里要补的是点名或配置了一个模型、它却没有密钥的情况，提示说清楚两条路：

```
error: no credentials for anthropic/claude-sonnet-5-5
  run `finx login anthropic`, or set ANTHROPIC_API_KEY
```

- 凭据的查询结果有进程内缓存，真正发请求时不会再查一次。
- `finx chat` 走同一个预检。

### 6.3 新参数

| 参数 | 说明 |
|---|---|
| `--tools read,bash` | 这次只用这些内置工具，名字写错直接退出 2。现在 `-c tools.enabled=[…]` 也能设，但 `finx status` 不校验（实测） |
| `--add-dir DIR` | 工作区之外还可以写的目录（`extra_writable_roots`），可重复 |
| `--image PATH` | 附一张图片，可重复。现在脚本发不了图片，内核和协议本来就支持 |

### 6.4 环境变量

环境变量用来说明环境，不用来表达偏好。每个变量只有一个作用，都登记在一个文件里，测试检查它和代码一致（§4.7）。公开文档列稳定的那些。

| 作用 | 变量 | 档 |
|---|---|---|
| 覆盖配置，给 CI 和包装脚本 | `FINX_MODEL`、`FINX_PERMISSION_MODE`。名字和取值都和配置项相同。只有需要对整棵进程树生效时才给变量，其他配置项用 `-c key=value` | 稳定 |
| 位置和周边环境 | `FINX_HOME`、`FINX_PDFIUM`、`FINX_CREDENTIAL_STORE`、`FINX_NO_BROWSER`、`FINX_LANG`（新）、`FINX_MODEL_CATALOG_URL` | 稳定 |
| 服务商密钥 | 各家自己的名字，如 `ANTHROPIC_API_KEY` | 稳定 |
| 诊断 | `FINX_LOG` | 稳定 |
| 给工具子进程 | `AI_AGENT=finx`、`FINX_CALL_ID` | 稳定 |
| Unix 惯例 | `NO_COLOR`、`TERM`、`HOME` | 稳定 |
| 只给测试和内部用，不进公开文档 | `FINX_STARTUP_TRACE`、`FINX_UPDATE_SNAPSHOTS`、`FINX_QODER_*`、`FINX_TEST_*` 等。新加的统一用 `FINX_TEST_*` | 内部 |
| 文档写了、代码里没有 | `FINX_DEBUG_HTTP`（总方案 §10.4）、`FINX_DEBUG_RPC`（protocol-design §9），从文档里去掉（Q-310） | — |

## 7. 模型接入

### 7.1 "完整"指什么

| 接入方式 | 例子 | 现状 | 一期要做 |
|---|---|---|---|
| API Key | DeepSeek、OpenAI、Anthropic、千问、Kimi、智谱、OpenRouter | 内置 | 加 Gemini（§7.5）；OpenAI 改走 Responses；真实验收（§7.6） |
| Token Plan | 百炼、腾讯云、火山、智谱、Z.ai | 内置 | 补验收 |
| 账号订阅 | ChatGPT | 内核和 CLI 都有 | 收进 `finx login` |
| 本机账号连接 | 千问办公、Qoder | 内核有，CLI 没入口 | 看 §18.3 |
| 本机模型 | Ollama；LM Studio、llama.cpp 走自定义 | 内置 Ollama | 收进 `finx login` |
| 兼容服务 | 公司网关、Azure、自建 | `models.toml` 手写 | `finx login --base-url`（§7.3），文档给配方 |
| 云厂商原生 | Bedrock、Vertex | 没有 | 不做原生，走网关；触发条件见 §20 |

增加一家：写配置，跑 `probe_channel`（model-catalog-design）。架构不用动。

### 7.2 默认模型（D-506，已实现）

原来 `config.rs` 里写死了 `DEFAULT_MODEL = "deepseek/deepseek-flash"`，没配 `model` 就是它，不管用户有哪家的凭据。第一次打开 FinxWork，什么都没配，输入框上就已经显示一个 DeepSeek 模型；只接了 Anthropic，新会话还是发给 DeepSeek，然后报缺密钥。

现在内核不替用户假设模型。新会话的模型这样定：

1. 这次点名的：`-m`、`session/new` 的 `model`；
2. 配置写明的：`-c model=`、`FINX_MODEL`、配置文件。没有密钥也算数，提示会要这家的密钥；
3. 都没写：第一个能用的服务商的模型（下面的规则）；
4. 还没有：**没有默认模型**，提醒用户去设置。

**"能用的服务商"：** 有凭据（环境变量、保存的密钥、配置、命令、账号连接），或者不需要凭据且应答过的本机服务。顺序就是 `models/list` 的服务商顺序：内置和 `models.toml` 里的按 ID 排，账号连接排在后面。

**用这家的哪个模型：**

| 顺序 | 规则 | 为什么 |
|---|---|---|
| 1 | 这家声明的第一个模型（`builtin.toml` 或 `models.toml` 的第一条 `models`，账号连接目录的第一个），且没被隐藏 | 由人挑一个适合日常工作的，既不选最贵的也不选最弱的。不随目录更新悄悄变贵 |
| 2 | 菜单里显示的模型中，没停用、发布最晚的 | 用户自己加的服务商没写，或者第一个被隐藏了 |
| 3 | 这家以及之后各家都只剩隐藏的模型时，第一家的第一个 | 全隐藏了也比跑不起来好 |

`builtin.toml` 里每家的第一个模型：

| 服务商 | 模型 |
|---|---|
| Anthropic | `claude-sonnet-5-5` |
| DeepSeek | `deepseek-flash` |
| 智谱 | `glm-5.3` |
| Kimi | `kimi-k3.1-pro` |
| OpenAI | `gpt-6.1-terra` |
| OpenRouter | `anthropic/claude-sonnet-5.5` |
| 千问 | `qwen3.8-max` |
| 百炼 Token Plan | `qwen3.8-max` |
| 腾讯 Token Plan | `tc-code-latest` |
| 火山 Agent Plan、Coding Plan | `ark-code-latest` |
| Z.ai、智谱 Coding Plan | `glm-5.3` |

没有另外加 `default_model` 这个字段：第一条 `models` 就够了，每家本来就可能有这一段，声明过的模型总在菜单里。测试 `every_built_in_provider_starts_on_a_model_it_still_offers` 检查这些模型都还在、没停用，公共目录每周同步后它们一旦下线，这条测试就会失败。

逻辑在 `finx_core::models`（`default_model`、`session_model`），`exec`、`chat`、`serve`、`acp`、Bot、桌面端共用；交互模式以后也用它。配了 `model` 的路径不多做任何事，不增加启动开销。

**没有默认模型时每个入口的表现：**

| 入口 | 表现 |
|---|---|
| `finx exec`、`finx chat` | 退出 2，不建会话，不读 stdin。stderr 见下 |
| `finx models` | 照常列服务商和每家要什么，末尾加同一段提醒；没有一行标 `(default)`。`--json` 的 `defaults` 里没有 `model`，`models` 为空 |
| `finx status` | `model` 一行写 `none is set up`；`--json` 的 `model.ref` 是 null，`model.error` 说明原因。有模型时 `model.chosen` 说明来历：`configured` 或 `first usable provider` |
| `finx doctor` | `default model` 一项不通过，退出 1 |
| JSON-RPC | `models/list` 的 `defaults.model` 不出现。`session/new`（没点名模型时）、`bots/open`（要新开对话时）返回新错误 −32046 `no_model`；不留下空的 `~/.finx/chats/` 文件夹 |
| ACP | `session/new` 返回 `auth_required`（−32000），`message` 说明要做什么（§10.1） |
| 桌面端 | 见 desktop-kernel-integration §8.4：引导页、新会话页、模型菜单、Bot 页都提醒接入 |

命令行的提醒（实测）：

```
$ finx exec hello
error: no model is set up

To set up a model, any one of these will do:
  an API key in the environment   ANTHROPIC_API_KEY, DASHSCOPE_API_KEY, DEEPSEEK_API_KEY, MOONSHOT_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, ZHIPUAI_API_KEY
  a ChatGPT subscription          finx login chatgpt
  a local Ollama                  pass -m ollama/<model>

`finx models` lists every provider and what it needs. To choose the default model, set
model = "provider/model-id" in ~/.finx/config.toml
```

环境变量的名字来自目录，不会过时。`finx login` 做好之后（§7.3），这段提醒的第一条换成它。

**默认模型是算出来的，不写配置。** 接入或移除一家，`models/list` 马上跟着变，不用重启。`defaults.model` 反映实际结果，客户端不用自己猜；桌面端引导页"准备就绪"标出的默认模型和新会话实际用的是同一个。

**已知的取舍（Q-313）：** 没写 `model` 时默认模型按顺序算，所以后接入的服务商排在前面时，默认模型会跟着变。比如先接了 Kimi，后来又接了 Anthropic，没选过模型的新会话就从 Kimi 变成 Anthropic。模型按钮上看得见，`finx status` 也写着。要固定就写 `model`。

**打开旧会话不受影响。** 会话用的模型所属服务商还在，就照常打开，缺密钥时发送才报。服务商没了（连接断开或移除）：有默认模型就暂时用它，并发 warning；连默认模型也没有时，会话仍然打开，历史能看，模型还显示原来的，warning 说明要接入模型，发送时任务失败（`ModelRegistry::unavailable`，D-536）。日志不改写，服务商回来后回到原模型。

### 7.3 `finx login`（D-509）

```
$ finx login
选择接入方式：
  1  API Key       DeepSeek、OpenAI、Anthropic、Gemini、千问、Kimi、智谱、OpenRouter
  2  ChatGPT 订阅  浏览器登录，不用密钥
  3  Token Plan    百炼、腾讯云、火山、智谱、Z.ai
  4  本机模型      Ollama（已检测到 3 个模型）
  5  兼容服务      自己填地址
> 1
…
粘贴 DeepSeek 的密钥（不会显示）：
已验证，4 个模型。默认模型：
  › deepseek/deepseek-flash
    deepseek/deepseek-v4-pro
已保存到钥匙串。试试：finx
```

- **规则不重写。** 调 `Server::set_key`：先用这把密钥问一次模型列表，被拒就不保存，问不到也保存（已有规则）。
- **选模型**：菜单来自 `models/list`，写入用 `config/write`。已经配了 `model` 时只在用户选择时才改。
- **环境变量优先**：同名环境变量已经设了的话，明确说"当前实际用的是 `DEEPSEEK_API_KEY`"，免得改了密钥不生效还找不到原因。
- **ChatGPT**：把 `cmd_info.rs` 里的流程搬过来，并尝试打开浏览器（用 `cmd_customize.rs` 已有的函数），同时打印地址。
- **Token Plan**：同 API Key，提示里给出 `key_url`。

非交互：

```bash
printf %s "$KEY" | finx login deepseek --key-stdin --model deepseek/deepseek-flash
```

```bash
printf %s "$KEY" | finx login mygateway --base-url https://llm.example.com/v1 --api openai-chat --key-stdin
```

`--base-url` 把服务商写进 `models.toml`（只写用户目录，D-17），用同一把文件锁，保留注释。`finx models login chatgpt-api` 改成 `finx login chatgpt`；还没有外部用户，不留别名。

### 7.4 密钥保存在哪

优先级不变：配置文件写明的、环境变量、已保存的。

| 平台 | 保存位置 | 说明 |
|---|---|---|
| macOS | 登录钥匙串，经 `/usr/bin/security` 读写 | 换版本不弹窗。代价：访问列表指向这个系统工具，同一用户的其他程序调它也能读到。公开文档要讲清 |
| Linux | `$FINX_HOME/credentials.toml`，权限 0600 | 明文。服务器和容器上通常也没有系统钥匙串。`finx status` 写明来源。接 Secret Service 的条件见 §20 |

跨进程的新鲜度见 §11.3。

### 7.5 新接口

**Gemini（D-510）：先走官方的 OpenAI 兼容接口，不写新适配器。** 已知的难点只有一个：按 Google 的文档和开发者反馈，Gemini 3 在函数调用上带一个签名，后续轮次必须原样发回，否则报 400。它放在工具调用的 `extra_content.google.thought_signature` 里，而我们的中立类型 `ToolCall` 只有 `id`、`name`、`arguments`、`arguments_error`，放不下。这一轮没有真实请求过，实现时以真实结果为准。

- `ToolCall` 加一个可选字段 `provider_data`，存这段不透明的 JSON，没有时不序列化。旧日志照读，协议是新增字段。
- `openai_chat.rs` 解析响应时收下工具调用的 `extra_content`，发请求时原样带回。只在同一个模型上回放，规则和推理内容的 `replay_thinking` 相同。
- `builtin.toml` 加 `[providers.google]`，公共目录已有 `google.json`。
- 用 `finx models check` 验多轮工具调用。这条路走不通，或者需要 Google 专有能力时，再写原生适配器。

**OpenAI：先留在 `openai-chat`（D-545）。** 原计划改走 `openai-responses`，但 `openai_responses.rs` 是照 ChatGPT 订阅的路线写的（工具包成 `{"type":"namespace"}`、`store:false`），没有真实密钥就把 api.openai.com 切过去，可能把能用的改坏。等有密钥，加一个变体并跑 `finx models check` 再切。

**其他：** 不再加内置渠道。OpenAI 兼容的长尾走 OpenRouter 或 `--base-url`，文档给配方。

### 7.6 验收（D-511）

`finx models check [MODEL]` 把现在的 `crates/finx-llm/examples/probe_channel.rs` 和 `finx chat --tool-test` 合成一个用户也能跑的命令：

| 检查 | 通过的标准 |
|---|---|
| 文本 | 流式收到回复，有用量 |
| 工具调用 | 两轮：模型调用工具，收到结果后继续 |
| 并行工具调用 | 一次多个调用，结果按 id 对上 |
| 推理等级 | 菜单列出的每一档都能发送 |
| 图片 | 目录说支持时，发一张小图能答 |
| 缓存 | 第二次请求有缓存命中；没有只提示，不算失败 |
| 中断 | 中途取消能及时结束 |

每次只花几十个 token。`--json` 给脚本用。发版前用 `tools/acceptance/` 下的脚本把名单跑一遍。

**分级：**

| 级别 | 服务商 | 要求 | 现状 |
|---|---|---|---|
| 一级 | DeepSeek、OpenAI、Anthropic、Gemini、ChatGPT 订阅、OpenRouter、Ollama | 每次发版前真实跑 | DeepSeek、ChatGPT 验过；OpenAI、Anthropic 没有密钥；Gemini 未实现；OpenRouter、Ollama 待验 |
| 二级 | 千问、Kimi、智谱、各 Token Plan、DeepSeek 的 Anthropic 端点 | 首发前跑一次，之后按需 | 百炼 Token Plan、DeepSeek 的 Anthropic 端点验过；Kimi、智谱、Z.ai、火山、腾讯没有密钥；千问的 API 待验 |

"现状"一列取自 model-catalog-design §13.3，真实验收都是 2026-11-04 及以前的。名单和密钥见 §18.6。公开文档有一张表，写明每家最后验证的版本，不假装都测过。

### 7.7 本机账号连接

公开版不带（D-546，§18.3）。`finx-connections` 有一个 cargo feature `local-accounts`，默认开，桌面端的构建带它；发布脚本用 `--no-default-features` 构建，`Manager::new` 不注册这两家的环境，发现不到也连不上。ChatGPT 订阅不受影响。不加 `finx connections` 这组命令，协议方法仍在实验档。

代码还在二进制里，只是走不到。真要把代码也去掉，要拆开 `lib.rs` 对 `QwenWork` 的直接依赖，源码公开之前再决定。

## 8. 工具

### 8.1 清单

| 工具 | 组 | 默认 | 需要 |
|---|---|---|---|
| `read`、`write`、`edit`、`bash` | 基础，始终在工具列表里 | 开 | `tools.enabled` 可以减 |
| `spawn_agent`、`send_message` | 子智能体 | 开 | `agents.enabled` |
| `tool_search`、`call_tool` | 按需加载的入口 | 有按需组时出现 | — |
| `web_search` | `web`，按需 | 开 | 无密钥时用有免费额度的服务（§12.5） |
| `doc_open`、`doc_read`、`doc_find`、`doc_view`、`doc_edit`、`doc_save`、`sheet_calc`、`sheet_trace` | `doc`，按需 | 开 | 工作簿不需要别的（实测）；PDF 要 `pdf` 组件 |
| `browser_navigate`、`browser_snapshot`、`browser_act`、`browser_batch`、`browser_tabs`、`browser_wait`、`browser_screenshot`、`browser_console`、`browser_eval` | `browser`，按需 | 关 | `browser.enabled = true`；系统有 Chrome、Edge、Chromium，或 `finx install browser`。`browser_eval` 还要开脚本 |
| `cua_apps`、`cua_launch`、`cua_snapshot`、`cua_act`、`cua_screenshot` | `cua`，按需 | 关 | macOS；`desktop.enabled = true`；`computer` 组件；系统授权 |
| `mcp__<服务器>__<工具>` | 按服务器 | 配置决定 | MCP 服务器 |
| `send_to_user`、`manage_routine` | Bot | 只在 Bot 会话里 | 不进 CLI |

默认工具列表的结构不变（实测 `exec` 发给模型的是 `read`、`write`、`edit`、`bash`、`spawn_agent`、`send_message`、`tool_search`、`call_tool`，`web`、`doc` 在提示词的目录里）。这个结构是为提示词缓存定的，不因为发布改动。

### 8.2 工具契约

`finx_tools::Tool` 就是契约。公开文档要把它说清楚，方便 MCP 作者和读日志的人：

| 部分 | 内容 |
|---|---|
| 定义 | `spec()`：名字（1–64 位字母、数字、`_`、`-`）、描述、参数的 JSON Schema |
| 类别 | `kind()`：只读可并行，修改独占；`origin()`：内置或 MCP |
| 审批 | 工具只声明自己是什么，判定在内核的 `ApprovalPolicy` |
| 输出 | 单个结果的 token 预算，完整输出存盘，可以读回（总方案 §5.7、D-239） |
| 错误 | 错误是数据：作为工具结果返回给模型，不让任务崩溃（总方案 P4） |
| 取消 | 贯穿，随时可中断（总方案 P6） |

**稳定性：** 工具名和参数是模型和日志都看的。改名或删参数等于破坏旧日志的显示和恢复，所以加一个快照测试：`finx tools --json` 的内置部分和仓库里的副本一致，改动在评审里能看到。

### 8.3 `finx tools` 和 `tools/list`（D-512）

```
$ finx tools
read          基础   读取文件                           可用
bash          基础   运行命令                           可用
web_search    web    联网搜索                           可用（Exa，免费额度）
doc_open      doc    打开文档和工作簿                   可用；PDF 需要 finx install pdf
browser_*     browser  打开网页并操作（9 个）           未开启：browser.enabled = true
mcp__exa__*   mcp    （连接后才知道，加 --mcp）
```

- `finx tools NAME` 打印描述和参数 Schema。
- `--json` 与新方法 `tools/list` 相同：每个工具的 `name`、`description`、`parameters`、`group`、`origin`、`kind`、`loaded`（在工具列表里还是按需）、`available`、`needs`（缺什么）。
- `tools/list` 带 `session_id` 时返回这个会话实际的工具，包括已连上的 MCP；不带时只列内置工具。它放在稳定档。
- `finx status` 的 `tools` 行改成"基础 4 个，按需 web、doc"，不再让人以为只有 4 个工具。

### 8.4 组件（D-513）

主程序不带这些文件，要用时再装。

| 组件 | 命令 | 内容 | 来自 | 装到 |
|---|---|---|---|---|
| `pdf` | `finx install pdf` | macOS：我们签过名的 `libpdfium.dylib`；Linux：`libpdfium.so` 和动态链接的 `finx-doc-worker`（§13.3） | 发布仓库 | `$FINX_HOME/addons/pdf/<版本>/` |
| `browser` | `finx install browser` | Chrome for Testing，已有实现（`finx browser install`） | Google 的发布地址 | `$FINX_HOME/browser/chromium` |
| `computer` | `finx install computer` | 我们签过名的 `agent-desktop` 和它的辅助程序，只有 macOS | 发布仓库 | `$FINX_HOME/desktop/bin` |

- **为什么 PDF 不放进主程序：** 7 MB 的动态库不是每个人都要；静态 Linux 也放不进去（§13.3）。
- **按版本分目录：** Linux 的 worker 和主程序一起发版，请求格式可能变。目录带版本号，版本对不上就是没装，不会出现半新半旧。`finx upgrade` 顺手升级已经装了的组件。
- **校验：** 文件摘要来自清单，见 §13.6。
- **缺组件时怎么说：** 不改提示词，错误写在工具结果里，模型正好在决定下一步时读到：`PDF support is not installed. Ask the user to run "finx install pdf", or read the file another way.` 交互模式可以再问一句"现在装吗"。
- **`finx doctor`** 列出每个组件的状态。
- **`FINX_HOME` 要生效：** `engine.rs::locate_library` 和 `finx-desktop` 的查找路径现在写死 `HOME/.finx`，隔离环境里找错地方。这次改成跟 `FINX_HOME`。
- **你自己的 Chrome：** `finx browser extension install` 能注册本地宿主，但扩展本身还没上架（browser-design D-219），文件只在 FinxWork 包里。上架之前，公开版的浏览器工具只承诺内置浏览器。
- **电脑操控的系统授权：** 辅助功能和屏幕录制的授权在桌面端给的是 FinxWork，命令行里预计是给运行 `finx` 的那个终端程序，要实测并写进文档。

### 8.5 MCP 工具的审批（D-514，已实现）

**原来：** `approval.rs` 里 MCP 工具在所有权限模式下直接放行（mcp-design D-107）。用户选了"逐项确认"，MCP 工具照样不问就发邮件、删数据。公开之后这是说不过去的。

**现在：**

| 权限模式 | 标了 `readOnlyHint` | 其他 |
|---|---|---|
| `manual`、`accept-edits` | 不问 | 问；`[a]` 记住这个工具，本会话不再问 |
| `bypass-permissions` | 不问 | 不问 |
| 没人能批准 | 不问 | 拒绝 |

- `readOnlyHint` 是服务器的自我声明（Q-110 担心的就是这个），所以只信用户自己配置的服务器；项目 `.mcp.json` 里的服务器标了也要问。
- `mcp_servers.<name>.approval = "never"` 是用户明确信任某个服务器的办法，只能写在用户层配置里，不受项目配置影响。
- 桌面端的连接器也走同一个判定。Bot 默认完全访问不受影响；普通会话在手动模式下会多一些询问。这是产品层面的变化，见 §18.4。
- **实现（D-547）：** `Tool` 多一个 `runs_unasked(args)`，默认否；`McpTool` 和 `call_tool` 由 `McpServerConfig::runs_unasked` 回答。`tool_search` 只查已有的定义，总是不问。`call_tool` 点了一个没有服务器认领的名字时不问（什么也不会运行），但还有服务器在连接时要问，因为它连上之后这个调用可能真的运行。
- **规则：** `[[rules]]` 按完整工具名匹配，如 `prefix = ["mcp__mail__send"]`，`allow`、`ask`、`deny` 都有效；"本会话不再问"就是加一条这样的规则。
- **谁算项目带来的：** 定义来自 `.mcp.json` 或项目层配置的服务器，在 `Workspace::open` 里标 `project_defined`。这个字段不进文件，别处写不了。`approval` 出现在项目层或个人项目层时被去掉并警告。


### 8.6 扩展方式

| 方式 | 适合 | 状态 |
|---|---|---|
| Skill | 指令加脚本，模型自己用 `read`、`bash` | 已有 |
| MCP | 真正的工具，任何语言 | 已有（stdio、HTTP、OAuth） |
| 客户端工具 | JSON-RPC 程序把自己的能力给模型 | 二期 |
| 外部钩子 | 工具前后执行用户脚本：拦截、记录、改结果 | 二期 |

**不做配置文件里定义的命令工具（D-515）。** Skill 加 `bash` 和 MCP 已经覆盖；多一条路只是多一套审批和错误处理。

**客户端工具（二期）。** 场景：一个程序用 JSON-RPC 驱动 finx，想把"查内部系统"给模型，又不想再起一个 MCP 服务。

- `session/new` 加 `client_tools: [{name, description, parameters}]`；
- 模型调用时发事件 `client_tool_call {call_id, name, args}`，客户端用 Op `client_tool_result {call_id, content, is_error}` 回答，和审批同一套模式，不需要服务端向客户端发请求；
- 内核里是一个 `ClientTool: Tool`，`ToolOrigin` 多一个值，审批规则同 MCP；
- 客户端断开或恢复会话时没重新登记：调用返回错误结果，会话继续；
- ACP 不需要：它有 `mcpServers`。

**外部钩子（二期）。** 总方案 §6.10 的 `Hooks` 接口已经有了，审批策略就是它的一个实现，缺的是"执行用户脚本"这个实现。

```toml
[[hooks]]
event = "before_tool"     # before_tool | after_tool | turn_end
match = "bash"            # 工具名，支持 * 通配
command = ["./check.sh"]
timeout_secs = 10
```

- stdin 给一个 JSON，stdout 回 `{"decision":"allow"|"deny"|"ask","reason":"…"}`；
- 超时或出错按"询问"处理，没人能答时拒绝，不静默放行；
- 项目层的钩子只在受信任的项目里生效（总方案 §11.7 已写明）；
- 配置项严格校验，不走 §11.2 的宽松规则。

## 9. JSON-RPC

### 9.1 现状

协议本身不用大改（protocol-design §6）：NDJSON、版本协商、capabilities、事件带 `seq`、接入时给快照、Schema 导出，端到端测试用 Schema 校验每条消息。实测协商符合文档：客户端给 99，回 2；给 1，回 -32602。

缺的是"把它当公开接口"所需要的东西：分档、兼容规则、文档、示例、SDK。

### 9.2 分档（D-516）

| 档 | 方法 | 承诺 |
|---|---|---|
| **稳定** | `initialize`；`session/*`（13 个）；`sessions/*`；`resource/read`；`models/*`；`auth/*`；`credentials/*`；`config/*`；`skills/*`；`mcp/*`；`web_search/*`；`files/*`；`chatgpt/*`；`server/shutdown`；新增的 `tools/list` | §9.3 的规则 |
| **实验** | `connections/*`；`connectors/install`；`doc/*`；`bots/*`；`browser/` 下除 `host` 之外的方法 | 可以随版本改，由 capabilities 声明，文档标明 |
| **内部** | `browser/host`，以及通知 `browser/cdp`、`browser/extension`、`browser/control`、`browser/request` | 只给桌面端和扩展宿主用，不写进公开文档 |

通知同样分档：`session/event`、`session/detached`、`sessions/changed`、`models/changed`、`config/changed`、`skills/changed`、`mcp/changed`、`mcp/probe_progress`、`files/changed` 和 `$/cancel_request` 稳定，`doc/changed`、`bots/changed`、`browser/changed` 实验。

- 档写在 `crates/finx-protocol/src/schema.rs` 的 `stability`，导出到 Schema 的 `x-stability`（已实现）。按前缀判断，新方法默认算稳定，要放进实验档得明说，这样不会有方法没档。

### 9.3 兼容规则（D-517）

1. **稳定档在同一协议版本内只增不改**：可以加方法、可选字段、事件类型、错误码。客户端必须忽略不认识的字段和事件（§6.2 已有这条）。
2. **不兼容的修改升协议版本。** 升级后旧版本至少再支持两个次版本。现在服务端只接受版本 2，届时改成接受一个范围。
3. **`Event` 和 `Op` 是稳定档的一部分。** `finx exec --output stream-json` 的事件流和 `--json` 的结果对象也按这条走（§4.6）。
4. **测试把关（已实现，D-552）：** 发版时把 `schema.json` 拷成 `crates/finx-protocol/schema-released.json`。`what_the_last_release_promised_still_holds` 在协议版本相同时拿它比较：稳定档的方法和通知、`Event`、`Op` 以及它们用到的类型，字段和枚举值不能少，类型不能变，不能多出必填字段。第一个版本发布之前这个文件不存在，测试跳过。
5. **错误码只增不改。** 客户端按 `data.kind` 判断。

### 9.4 新增和调整

| 内容 | 说明 |
|---|---|
| `tools/list` | §8.3 |
| `WarningCode` 新值 | 没人能批准（§6.1） |
| `ToolCall.provider_data` | §7.5，客户端不用理会 |
| `session/new` 的默认模型 | 由 §7.2 决定，`models/list` 的 `defaults` 反映结果（已实现） |
| `no_model`（−32046） | 没点名模型、没配置、也没有能用的服务商（§7.2，已实现）。`defaults.model` 不出现时就是这种状态 |

点名或配置了一个没有凭据的模型时，行为不变：`session/new` 成功，发送时任务以 `auth` 失败。程序可以先看 `models/list` 的 `available`。

### 9.5 远程（D-518）

**不开端口。** stdio 本来就能过 ssh，不需要新代码：

```bash
ssh host finx serve --stdio
```

```bash
ssh host finx acp
```

连常驻服务用 socket 转发：

```bash
ssh -L /tmp/finx.sock:/home/me/.finx/run/finx.sock host
```

认证、加密都交给 ssh。Unix socket 上的 uid 检查（protocol-design §9）不变。这条路进测试（§16.1）。WebSocket 继续预留，等真有远程客户端（§20）。

### 9.6 SDK

**一期不发 SDK，发文档和示例。** 协议就是一行行 JSON，几十行代码就能跑完一个带审批的任务（§2 的验证就是这样跑的），先证明这一点。

| 位置 | 内容 |
|---|---|
| `examples/rpc/minimal.py` | 不依赖第三方库：启动 `finx serve --stdio`，建会话，发任务，答审批，打印结果 |
| `examples/rpc/minimal.mjs` | Node 版，同样零依赖 |

这两个示例在 CI 里用模拟模型跑，文档不会过期。

**二期发 `@finxwork/sdk`（npm 上这个名字还空着）。**

- 新包 `packages/sdk`：传输（启动子进程、连 socket）、请求和事件、一个薄的会话封装，类型来自 `@finx/protocol`。
- `@finx/client` 保持原样。它里面大部分是界面逻辑（步骤折叠、提及、草稿、Bot 聊天），不适合公开，也不打算把它们定成接口。
- Python 包等有人要（§20）。

### 9.7 文档

`docs/cli/json-rpc.md` 手写：快速开始、连接方式、会话和事件的模型、审批、错误、兼容规则。方法说明由 `tools/gen-protocol-docs.mjs` 从 `schema.json` 生成，只收稳定档和实验档，标明档位。`docs/kernel/protocol-design.md` 继续是内部设计文档。

## 10. ACP

### 10.1 登录（D-519，已实现）

**场景：** 用户在编辑器里配上 `finx acp`，没有密钥，发第一句话。现在的表现：`session/new` 成功，配置项里只有一个 DeepSeek 模型，`session/prompt` 返回 -32020，文字是 `set DEEPSEEK_API_KEY`（实测）。而图形界面启动的编辑器通常拿不到 shell 里的环境变量，所以这句提示还经常没用。

**改成走标准的认证流程。** 现有的 D-28（不加私有扩展）不受影响：`authMethods`、`authenticate`、`auth_required` 都是 ACP v1 的标准内容，terminal 方法在官方 schema 1.13 里不需要 `unstable` 开关，不用 `_meta`。

`initialize` 的回复：

```json
{
  "protocolVersion": 1,
  "authMethods": [
    { "id": "finx-terminal", "name": "Sign in from a terminal", "type": "terminal", "args": ["--login"] },
    { "id": "finx-chatgpt", "name": "Sign in with ChatGPT", "description": "Opens your browser" },
    { "id": "finx-saved", "name": "Use the credentials saved for finx", "description": "Run `finx login` in a terminal first" }
  ]
}
```

| 时机 | finx 做什么 |
|---|---|
| `initialize` | 客户端声明 `clientCapabilities.auth.terminal: true` 时才列 `finx-terminal`（规范要求），其他两个总是列 |
| `session/new`，什么模型都没设置 | 返回 `auth_required`（-32000），`message` 说明要做什么（已实现，§7.2） |
| `session/new`，配置的模型没有凭据 | 返回 `auth_required`（-32000），`message` 写明缺哪家 |
| `session/load`、`resume` | 不检查：看历史不需要凭据 |
| `session/prompt` 因为鉴权失败 | 返回 `auth_required`，不再是 -32020 |
| `authenticate("finx-saved")` | 重新读凭据：有就回 `{}`，没有回 -32000 |
| `authenticate("finx-chatgpt")` | 跑 ChatGPT 登录，等到完成；`$/cancel_request` 能取消 |
| terminal 方法 | 客户端在终端里运行 `finx acp --login`（基础命令加上 `args`），流程同 `finx login`，退出 0 表示成功，然后重连 |

规范不让 `authenticate` 接收 terminal 方法，v1 也不提供向用户要密钥的通道，所以 API Key 只能走 terminal 方法或事先 `finx login`。不要为此在协议里塞密钥。v2 草案有一种 `env_var` 方法，定稿后再看。

`--login` 放在 `acp` 子命令上，因为客户端是在配置好的启动命令（`finx acp`）后面追加参数，不能换命令。

### 10.2 文案（D-520，已实现）

`crates/finx-acp/src/out.rs` 里配置项名称和审批按钮是写死的中文（"模型""推理等级""允许"）。Zed 的英文用户看到的也是中文（实测）。改成跟 §5 同一份文案表，按环境变量取语言，默认英文。

### 10.3 上架注册表

ACP 官方注册表能让编辑器一键安装。按它现在的要求（`agentclientprotocol/registry` 的 FORMAT.md、CONTRIBUTING.md）：

```json
{
  "id": "finx",
  "name": "finx",
  "version": "0.2.0",
  "description": "…",
  "repository": "https://github.com/finxwork/finx-releases",
  "license_url": "…",
  "distribution": {
    "binary": {
      "darwin-aarch64": {
        "archive": "https://github.com/finxwork/finx-releases/releases/download/v0.2.0/finx-0.2.0-aarch64-apple-darwin.tar.gz",
        "cmd": "./finx",
        "args": ["acp"],
        "sha256": "…"
      }
    }
  }
}
```

| 要求 | 我们怎么满足 |
|---|---|
| `authMethods` 里至少有一个 `agent` 或 `terminal` | §10.1 的 agent 方法不看客户端能力，总是在 |
| 必填 `id`、`name`、`version`、`description`、`license_url`、`distribution`，还要一个单色 `icon.svg` | 发版时生成；图标从现有标志出 |
| 平台键 `darwin-aarch64`、`darwin-x86_64`、`linux-aarch64`、`linux-x86_64` | 四个都有；缺 Windows 只是警告 |
| 地址不能含 `/latest/`，版本要和条目一致，地址要能访问 | 指向固定版本（§13.5） |
| 接受 `.tar.gz`，不接受 `.dmg`、`.pkg` | 产物就是 `.tar.gz` |
| 没有 `repository` 时可能要手动提 PR 更新 | 填发布仓库，这也是发布仓库要独立的原因之一（§13.5） |

注册表允许闭源，只要求 `license_url`。CI 命令是 `verify_agents.py --auth-check`，发布前本地先跑。

### 10.4 真实编辑器验收

protocol-design §11 的"在 Zed 中实测"至今写着尚未进行。公开之前必须补上，验收清单：

1. 配置 `finx acp`，新会话看到模型、推理等级、权限模式三个选项，文字是英文；
2. 没有凭据时出现登录入口，走完 terminal 方法后能用；
3. 改文件：看到 diff，审批，编辑器里文件刷新；
4. `/compact` 和 `/skill:name` 出现在命令列表里；
5. 取消、恢复旧会话、删除会话；
6. 图片、`@` 引用的内容能送达。

JetBrains 等其他客户端在首发之后再验。

### 10.5 继续不做

| 内容 | 现状 | 什么时候做 |
|---|---|---|
| session modes | 只提供配置项（Q-26） | 真实客户端不认配置项时 |
| `fs/*`、`terminal/*` 委托给编辑器 | 全部本地执行（Q-23） | 编辑器里未保存的内容必须让模型看到时 |
| `finx acp --attach` 接常驻服务 | 没有（Q-28） | 有人要在编辑器和桌面端之间切换同一个会话时 |

## 11. 数据与多版本共存

场景：一个人同时有 FinxWork 和独立的 `finx`。两个二进制各自更新，版本不同，共用 `~/.finx`。这件事以前不存在，因为只有一个来源。

### 11.1 谁读写什么

| 数据 | 现在 | 规则 |
|---|---|---|
| `config.toml`、项目配置 | 未知键直接报错，所有命令退出 2（实测） | §11.2 |
| `models.toml` | 同上（实测） | §11.2 |
| 会话日志 | 不认识的条目跳过（D-235）；头部 `version` 只写不查 | 保持。读到更高的版本给一条警告，不拒绝 |
| `finx.db` | 新版本写过的文件不碰，报错（已有测试） | 保持，只影响 Bot 和定时任务 |
| 协议 | 版本协商 | 保持 |
| 服务和 socket | 单实例锁；应用按 desktop-kernel-integration §5.5 替换 | 保持，§11.4 |
| 密钥 | 共用 | §11.3 |
| 组件 | 新东西 | 按版本分目录（§8.4） |

### 11.2 配置里不认识的键（D-521）

**场景：** 新版 FinxWork 写了一个旧版 `finx` 不认识的设置，比如新增的 `[foo]`。之后旧版的每个命令都退出 2，连 `finx doctor` 和编辑器里的 `finx acp` 都起不来，用户只能手动改文件。

总方案 §10.1 的严格校验是为了防拼写错误被悄悄忽略。这个目的还在，所以把它和向前兼容分开：

| 情况 | 行为 |
|---|---|
| 读取时遇到不认识的键 | 警告，带文件、行号和"你是不是想写…"；忽略这个键，继续运行 |
| `rules`、`hooks` 里不认识的键 | 还是错误。安全规则不能悄悄少一条 |
| 值不合法（包括认识的键、不认识的枚举值） | 还是错误。比如新版的 `permission_mode = "plan"`，旧版不能猜 |
| `config/write`、`finx config set` | 还是严格。客户端写入不认识的键是 bug |
| `finx doctor` | 列出这些键。`--strict` 时算失败，方便 CI |

实现用 `serde_ignored`，并去掉这些结构上的 `deny_unknown_fields`。`models.toml` 同样处理。警告走现有的 `warnings`，`exec` 写 stderr，`--json` 模式里是事件。

### 11.3 密钥跨进程可见（D-522）

**场景：** FinxWork 开着，常驻服务在跑。用户在终端 `finx login anthropic` 成功，回到应用里 Anthropic 还是"缺密钥"，要重启才好。原因是 `credentials.rs` 每个进程只读一次并缓存，`forget` 现在只有 MCP OAuth 在用。

**修在拥有这份数据的地方：** 每次 `set`、`delete` 同时更新 `$FINX_HOME/credentials.stamp`。`get` 命中缓存前比较它的修改时间，变了就清缓存。一次 `stat` 约 1 µs，比一次模型请求小几个数量级。服务在 `models/list` 时用同一个比较决定要不要 `directory.invalidate()`，再发 `models/changed`。

不选"通过 socket 转给服务"：服务不一定在，版本也不一定兼容，还要处理回退。

### 11.4 服务和桌面端

不改 desktop-kernel-integration §5.5 的策略，只把它写进公开文档：

- `exec` 和交互模式不经过服务，不受影响；
- 从终端启动的 `finx serve --listen unix://` 和应用共用默认 socket。应用打开时如果发现跑的不是自带的文件，会在空闲时替换它。想独立运行就用 `--listen unix:///自己的路径`；
- 同一个会话不能被两个进程同时打开。现在报 `StoreError::Locked`，CLI 要把它翻成人话："这个会话正在另一个 finx 或 FinxWork 里打开"。

### 11.5 降级

`finx upgrade --version V` 能回到旧版。按上面的规则旧版能读新版的配置和日志，新版写的条目被跳过。`finx.db` 例外，Bot 和定时任务要等回到新版。

## 12. 安全与隐私

公开之后，使用者不再是作者本人。总方案 §11 的防线不变，这里只写变化。

### 12.1 公开文档要讲清的事

- 没有操作系统级沙箱。防线是权限模式、规则、工作区边界、受保护路径、项目信任。
- `bypass-permissions` 只在容器或一次性环境里用。
- `AGENTS.md` 和项目层 Skill 总会被读取（D-68）。仓库内容可能试图影响模型。
- 密钥存哪里、其他程序能不能读到（§7.4）。
- 所有会访问网络的地方（§12.5）。

### 12.2 项目信任提示（D-523）

**现在：** 不受信任的项目里，`.mcp.json`、权限相关的配置、钩子都被忽略，只有一条警告，要自己知道运行 `finx trust`。

**交互模式：** 只有项目里确实有可信任的东西时才问一次，其余时候什么都不问。

```
这个项目带了配置：
  .mcp.json  2 个 MCP 服务器（filesystem, github）
  .finx/config.toml  permission_mode, 3 条规则
信任它们吗？信任后这些程序会在你的电脑上运行。[y/N]
```

- 默认"否"。回答记在 `trusted.toml`，"否"也记住，不反复问；
- `exec`、`serve`、`acp` 不问，行为不变；
- 服务器的启动命令要显示出来，别只显示名字。

### 12.3 MCP 审批

见 §8.5。

### 12.4 Bot 和定时任务（D-524）

routine-design D-433 写明："定时运行的权力和 Bot 相同"是因为现在只有主人自己用，发布给别人之前要重新决定。

**这个方案不把它们放进 CLI 产品：** 没有子命令，公开文档不提，协议里标实验档。没有定时任务时调度器不运行（routine-design）。桌面端的发布要不要带，是另一个决定（desktop-release §6.2 已经记了这一条）。

### 12.5 网络访问清单（D-525）

没有遥测，没有崩溃上报。下面是全部的出站访问，公开文档照抄，并用一个端到端测试核对（§16.1）。

| 去哪 | 什么时候 | 怎么关 |
|---|---|---|
| 模型服务商 | 任务；保存密钥时的验证；`--refresh`；`finx serve` 后台每天刷新模型列表 | 用本机模型；`models.network = false` 关后台刷新 |
| models.dev | `finx models --refresh`；`finx serve` 后台每天一次 | `models.network = false` |
| 联网搜索服务 | 模型调用 `web_search` 时。**无密钥时搜索词发给 Exa 或 Parallel** | `web_search.enabled = false` |
| MCP 服务器和它们的登录地址 | 配置了才有 | 不配置 |
| GitHub（发布仓库） | `finx upgrade`、`finx install`；交互模式每天一次检查更新（§13.9） | `update.check = false` |
| Google 的 Chrome for Testing 地址 | `finx install browser` | 不装 |
| 模型运行的命令和打开的网页 | 由权限模式和网站权限控制 | 总方案 §11、browser-design §7 |

### 12.6 沙箱

一期不做，沿用 2026-10-29 定的优先级。二期单独出设计文档，起点是 2026-11-04 的调研和本机探测。方向性的结论：

- 真正常见的逃逸是写一个以后会被宿主执行的文件（钩子、配置、git 元数据），不是突破内核；所以总方案 §11.8"内核和工具都不需要修改"低估了工作量；
- 还没存在的宿主配置路径也要保护；开了网也要挡 Unix socket；
- MCP stdio、连接器、浏览器进程都不经过 `Environment.exec`，要单独考虑；
- macOS 上每次启动进程多约 9 ms（探测值），`sandbox-exec` 的手册标注已弃用。

## 13. 打包、发布与升级

原则沿用 desktop-release.md：**只依赖 GitHub（RG1）、不打扰（RG2）、GitHub 账号失守也装不上别人的代码（RG3）、发布原子（RG4）**。

### 13.1 版本号（D-526）

- 根 `Cargo.toml` 的 `workspace.package.version` 就是 CLI 的版本。现在一直是 0.1.0，第一个公开版 0.2.0。
- 标签 `v<版本>`，预发布带 `-`，不会成为 latest。
- 协议版本单独走（§9.3）。
- 桌面端 `kernel.json` 取自 `finx --version`，它的替换逻辑看 inode 和内容，不受影响（desktop-release §4.6）。
- `finx --version` 只打印版本号。提交和目标平台放在 `finx status`，不增加 `--version` 的开销。

### 13.2 产物（D-527）

| 平台 | Rust 目标 | 链接方式 |
|---|---|---|
| macOS arm64 | `aarch64-apple-darwin` | 系统库 |
| macOS x64 | `x86_64-apple-darwin` | 系统库 |
| Linux x64 | `x86_64-unknown-linux-musl` | 静态 |
| Linux arm64 | `aarch64-unknown-linux-musl` | 静态 |

每个版本的文件：

| 文件 | 内容 |
|---|---|
| `finx-<版本>-<目标>.tar.gz` | `finx`、`LICENSE`、`THIRD_PARTY_NOTICES.md`、`README.md` |
| `finx-pdf-<版本>-<目标>.tar.gz` | PDF 组件 |
| `finx-computer-<版本>-<目标>.tar.gz` | 电脑操控组件，只有 macOS |
| `finx-manifest.json`、`finx-manifest.json.sig` | 清单和签名（§13.6） |
| `SHA256SUMS` | 给手动校验的人 |
| `install.sh` | 安装脚本（§13.7） |

**Linux 为什么用静态构建：** 不挑发行版，Alpine、老系统、精简容器都能跑；启动也快得多。同一台 1 vCPU 机器上交替跑 `--version`，静态 0.75 ms，glibc 动态 1.88 ms（实测，400 轮中位数；两份 11-03 的构建，不是同一提交，只看量级）。总方案的 2 ms 目标和性能报告也都按静态构建算。

### 13.3 Linux 上的 PDF（D-528）

静态程序不能 `dlopen`。实测把 `FINX_PDFIUM` 指向一个真实的共享库，`doc-worker` 返回 `DlOpen { source: "Dynamic loading not supported" }`。工作簿不用 PDFium，静态构建能开（实测）。

文档 worker 本来就是独立进程（`Launcher::Process`），PDFium 崩溃不影响内核。所以只需要让这个进程可以是另一个程序：

- `finx-docs` 加一个 bin `finx-doc-worker`，只有文档引擎，不带内核；
- 用 `x86_64-unknown-linux-gnu.2.28`、`aarch64-unknown-linux-gnu.2.28` 构建（`cargo-zigbuild` 能指定 glibc 版本，2.28 是暂定的最低版本，要和 PDFium 预编译包的要求核对），和 `libpdfium.so` 放在一起，就是 PDF 组件；
- `Launcher::this_program()` 改成：当前版本的组件目录里有 `finx-doc-worker` 就用它，否则用自己的 `doc-worker`。规则和平台无关，macOS 的组件没有 worker，自然走自己；
- `locate_library` 先找程序旁边，Linux 上能直接找到库；macOS 上要给它加上组件目录这一项；
- musl 发行版（Alpine）首发不支持 PDF，工具结果说明情况，模型可以用 `pdftotext` 之类的办法（§20）。

备选方案比较：

| 方案 | 问题 |
|---|---|
| Linux 主程序改用 glibc 动态 | 启动慢一倍多；要决定最低 glibc 版本；Alpine 跑不了，还是要出 musl 版 |
| 把 PDFium 静态链进主程序 | 官方预编译包没有静态库；每个人都多背几 MB，缺页也更多 |
| Linux 不支持 PDF | 工具目录写着支持 PDF，实际用不了 |

### 13.4 macOS 签名和公证（D-529）

```bash
codesign --force --options runtime --timestamp --identifier finx --sign "$IDENTITY" finx
```

```bash
ditto -c -k --keepParent finx finx.zip && xcrun notarytool submit finx.zip --keychain-profile "$PROFILE" --wait
```

- 复用 `build-app.mjs` 的身份和公证凭证。**钥匙不出这台 Mac**（DQ-16），所以 macOS 产物在本机构建。
- 主程序不需要 entitlement（`build-app.mjs` 的注释已写明）。hardened runtime 的库验证要求动态库同一个 Team ID，所以 `libpdfium.dylib`、`agent-desktop` 由我们重新签名，这也是组件必须从我们的发布仓库下载的原因。`build-app.mjs` 已经验证过这个组合能打开 PDF。
- **单个可执行文件不能钉票据。** Apple 的文档明确说不支持。第一次运行时 Gatekeeper 联网查询；有隔离属性而又离线时会被拦。`curl` 和 Homebrew formula 下载的文件通常不带隔离属性，浏览器下载的带。这几条在 §16.2 实测。
- 密钥走 `/usr/bin/security`，换版本不弹窗，和签名无关。

### 13.5 发布仓库（D-530）

新建公开仓库 `finxwork/finx-releases`，只放 Release 和说明。不和桌面端的 `finxwork/finxwork-releases` 共用，也不等源码公开：

| 原因 | 说明 |
|---|---|
| "latest" 只有一个 | 桌面端靠 `releases/latest/download/RELEASES-darwin-<arch>.json` 判断更新。同一个仓库里发 CLI 版本，latest 就指向没有这些文件的 Release，应用会以为没有更新 |
| 节奏不同 | CLI 修一个 bug 不应该逼着重新打 139 MB 的应用包 |
| ACP 注册表自动更新 | 它按 `repository` 的 latest release 检查版本 |
| 源码公开是另一个决定 | §18.5 |

设置和 desktop-release §6.1 相同：打开 immutable releases；只有维护者有写权限，开两步验证。用户反馈先放在这个仓库的 Issues。

### 13.6 清单和签名（D-531）

```json
{
  "version": "0.2.0",
  "protocol_version": 2,
  "published_at": "2026-11-20T08:00:00Z",
  "artifacts": {
    "aarch64-apple-darwin": { "url": "…/finx-0.2.0-aarch64-apple-darwin.tar.gz", "sha256": "…", "size": 13000000 }
  },
  "addons": {
    "pdf": { "aarch64-apple-darwin": { "url": "…", "sha256": "…", "size": 3400000 } }
  }
}
```

- 地址：`releases/latest/download/finx-manifest.json` 看最新版，`releases/download/v<版本>/…` 取固定版本。不调 GitHub API，没有频率限制。
- 清单用 ed25519 签名，`finx upgrade`、`finx install` 用编译进程序的公钥验证（`crates/finx-core/src/release_public_key.txt`）。`ring` 已经是依赖，不增加依赖。私钥 2026-11-05 已生成，放在这台 Mac 的钥匙串，`security find-generic-password -a finx -s finx-release-signing -w`，**还没有离线备份（Q-309）**。签名工具是 `crates/finx-core/examples/release_sign.rs`，不进 `finx`（D-549）。开发构建可以用 `FINX_TEST_RELEASES`、`FINX_TEST_RELEASE_KEY` 换地址和公钥，发布构建读不到这两个变量。
- macOS 额外用 `codesign --verify -R` 验证新文件的 Team ID，和桌面端 RG3 是同一层保护。
- `install.sh` 只验证 SHA256：脚本本身来自同一个地方，再验签名不增加保护。公开文档给出手动校验的步骤。

### 13.7 安装脚本（D-532）

```bash
curl -fsSL https://github.com/finxwork/finx-releases/releases/latest/download/install.sh | sh
```

- `finxwork.ai/install.sh` 跳转到这里，是便利而不是依赖（站点在 `site/`）。
- POSIX `sh`，只依赖 `curl` 或 `wget`、`tar`、`sha256sum` 或 `shasum`。
- 判断平台。macOS 上用 `sysctl hw.optional.arm64` 判断，Rosetta 下的终端也能拿到 arm64 版。
- 默认装到 `~/.local/bin/finx`，`FINX_INSTALL_DIR` 或 `--dir` 可改；不用 sudo；不在 PATH 里时打印要加的那一行，不改用户的 shell 配置。
- `--version V` 装指定版本。重复运行就是升级。
- 卸载：删掉这个文件。`~/.finx` 留给用户决定，文档说明里面有什么。

**国内访问 GitHub 不稳定**（DQ-19）：脚本和 `finx upgrade` 都走 `HTTPS_PROXY`。是否设镜像见 §20。

### 13.8 其他渠道

| 渠道 | 期 | 说明 |
|---|---|---|
| Homebrew tap | 一 | `brew install finxwork/tap/finx`。Homebrew 核心库里没有叫 `finx` 的 formula（已查）。tap 仓库 `finxwork/homebrew-tap`，发版脚本更新 formula，地址指向发布仓库 |
| ACP 注册表 | 一 | §10.3 |
| `cargo install` | 不发布 | `publish = false`，crates.io 上 `finx` 已被别的项目占用，`ironcalc_base` 还是 git 依赖。源码公开后可以 `cargo install --git` |
| npm、deb、rpm、Docker 镜像、GitHub Action | 按需 | §20 |

### 13.9 升级（D-533）

**`finx upgrade`：**

1. 判断安装方式。路径在 Homebrew 的 Cellar 里：提示 `brew upgrade finx`，不动；在 `.app` 里：提示由 FinxWork 更新；在 `~/.cargo/bin`：提示重新编译；其余自己升；
2. 取清单，验签名，比版本。只升不降，除非 `--version` 明确指定；
3. 下载，校验 SHA256；macOS 再验证 Team ID；
4. 解到同一目录的临时文件，`rename` 覆盖。正在运行的进程继续用旧的 inode，不受影响；
5. 已经装了的组件一起升；
6. 读 `run/finx.lock`，如果常驻服务跑的就是这个路径，提示一句它还是旧版，不主动重启。

**更新提示：**

- 只在交互模式；每天最多查一次，结果缓存在 `$FINX_HOME/run/update-check.json`；后台进行，失败不提示；
- 启动时一行：`finx 0.3.0 可用，运行 finx upgrade`。不询问、不自动安装；
- `exec`、`serve`、`acp` 永远不查：脚本和编辑器里不能有意外的网络访问和输出；
- `update.check = false` 关闭。

### 13.10 发布一个版本

`pnpm release:cli`（`tools/release/`），结构和桌面端的 `release.mjs` 相同，复用 `pdfium.mjs`、`agent-desktop.mjs`、`rust-target.mjs`。

1. **检查前提**，任何一条不满足就在构建之前停下：工作区干净；`crates/finx-cli/releases/<版本>.md` 写了变化；有公证凭证和清单私钥；发布仓库存在且公开；没有这个标签；版本比 latest 高；上一版的 Schema 比较通过；
2. **构建**：四个目标的主程序（`--profile dist --locked`，Linux 用 `cargo-zigbuild`），组件；
3. **签名、公证** macOS 的文件；
4. **冒烟测试**：macOS 本机跑；Linux 上传到测试机或容器跑（§16.1）；
5. **生成** `SHA256SUMS`、清单、清单签名；
6. **创建草稿 Release，上传全部文件，一次性发布并设为 latest。** 草稿不算 latest，全部就位之前用户读到的还是上一版（RG4）；
7. **更新** Homebrew formula；提示去提 ACP 注册表的 PR（有 `repository` 时会自动更新，第一次要手动）。

`--dry-run` 走到第 5 步。撤回沿用 desktop-release §6.4：向前修复。

`dist` 配置一次完整构建约 15 分钟（实测，机器上还有别的任务），四个目标约 1 小时。可以接受，发版不频繁。

### 13.11 许可证和公开前的检查

**依赖没有障碍。** `cargo metadata` 列出 424 个第三方包，除了下面两个都是宽松许可（实测）：`option-ext`（MPL-2.0，只约束它自己的文件，链接没问题，写进声明）；`r-efi`（三选一，选 MIT）。另外要声明：PDFium（BSD-3）、IronCalc、公共模型目录的快照、Chrome for Testing（用户自己下载）、agent-desktop、`crates/finx-connections/licenses` 里已有的。`THIRD_PARTY_NOTICES.md` 由发版脚本生成。

**给 finx 选什么许可证见 §18.5。** 闭源分发同样要有许可条款，ACP 注册表也要 `license_url`。

**源码公开之前要处理的**（不公开也建议先做）：

| 项 | 现状 |
|---|---|
| `ironcalc_base` 的 `[patch]` | 指向个人账号下的 fork。移到 `finxwork` 组织，避免公开构建依赖个人账号 |
| 文档里的本机路径 | `docs/desktop/` 的几个演示 HTML 带本机路径，要清掉 |
| 文档里提到的其他私有项目 | `desktop-release.md` 提到共用公证密钥的另一个项目 |
| 示例会话日志 | `examples/snake-game/finx-session.jsonl` 要看一遍 |
| 第三方桌面登录适配器 | §18.3 |
| 检查脚本 | `tools/check-public.sh`：扫路径、密钥形状和其他项目的名字，放进 CI |

## 14. 文档与示例

| 文件 | 内容 |
|---|---|
| 根目录 `README.md` | 是什么、安装、30 秒上手、三个入口各一个例子 |
| `docs/cli/quickstart.md` | 从安装到第一个任务 |
| `docs/cli/models.md` | 每家怎么接；验收状态表；自定义服务的配方 |
| `docs/cli/tools.md` | 工具清单和契约，由 `finx tools --json` 生成一部分；组件；MCP；Skill |
| `docs/cli/permissions.md` | 权限模式、规则、受保护路径、项目信任、没有沙箱这件事 |
| `docs/cli/scripting.md` | `exec`、退出码、JSON 结果、事件流、CI 示例、环境变量 |
| `docs/cli/acp.md` | 编辑器配置、登录、限制 |
| `docs/cli/json-rpc.md` | §9.7 |
| `docs/cli/privacy.md` | §12.5 的清单、数据存在哪、怎么卸载 |
| `docs/cli/troubleshooting.md` | `finx doctor`、和 FinxWork 共存、常见报错 |
| `SECURITY.md`、`CHANGELOG.md`、`LICENSE` | 标准文件 |
| `README.md` 的"给编程智能体"一节，`docs/cli/llms.txt` | 很多人是让自己的编程智能体来装和调 finx 的：怎么调 `exec`，结果在 `final_output`，`status --json`、`doctor --json` 查环境且不改东西，什么时候才能传 `--dangerously-skip-permissions`。`llms.txt` 是用户文档的索引 |

`docs/cli/` 面向用户，用英文写，再出中文版。`docs/kernel/` 继续是内部设计文档。源码不公开时，文档同步到发布仓库的 README 和 `docs/`。

**文档不过期：** quickstart、scripting 里的命令由一个脚本用模拟模型跑一遍，放进 CI。`examples/` 只放跑得起来的东西，贪吃蛇的示例保留。

产品描述也要改。`finx --help` 第一行现在是 "an agent kernel for software tasks"，面向的是内部读者，也不符合基础提示词里的能力范围。措辞见 Q-308。

## 15. 性能约束

规则沿用性能手册（`docs/kernel/benchmarks/performance-playbook.md`）：**没有一项指标可以退步**。合并前用 `tools/bench/ratchet.py` 比较。

| 指标 | 基线（Linux 静态 dist，1105 报告） | 这个方案要注意什么 |
|---|---|---|
| `--help` | 约 1.0 ms | 根命令不加参数（§4） |
| `status --json`、`doctor --json` | 约 1.7 ms | 未知键检查不能变慢；`doctor` 多的检查只读路径 |
| `sessions --json` | 约 1.3 ms | 不变 |
| `exec` 到第一个模型请求 | 按 ratchet 基线 | 预检复用缓存（§6.2）；`stat` 一次 stamp（§11.3） |
| `finx acp`、`serve` 的 `initialize` | 按 ratchet 基线 | `authMethods` 是静态的；凭据只在 `session/new` 时看 |
| 二进制大小 | macOS 32 MB | 新依赖只有 `crossterm`、`unicode-width`、`clap_complete`，合入时记录增量。`clap_complete` 只在 `finx completion` 里用到，要确认它不增加别的命令的缺页 |

**新增指标：**

| 指标 | 目标 | 怎么量 |
|---|---|---|
| `finx` 到显示输入框 | 不高于 `status`，不等内核启动 | pty 测试里取时 |
| 流式时的 CPU | 重画合并后，和 `exec` 的文本输出同一量级 | 模拟模型高速输出 |
| 空闲 CPU | 0，没有定时重画 | 采样 |
| 空闲内存 | 不高于 `exec` 加输入框本身 | `bench_memory.py` |

代码只在交互路径上用到的部分不会碰冷路径，但会让二进制变大。所以合入前必须量本地命令的缺页数（D-98），不能只看耗时。

## 16. 测试与验收

### 16.1 自动测试

| 内容 | 怎么测 | 在哪跑 |
|---|---|---|
| 单元和现有端到端 | `cargo test --workspace` | CI（macOS、Linux）。**现在 CI 只跑两个 crate 的单元测试，这是第一件要补的** |
| 交互模式 | 新增 `crates/finx-cli/tests/e2e_interactive.rs`，一个小的 pty 工具配模拟模型：发送、流式、审批四种答案、打断、插话、跟进、取回、调整大小、中文和宽字符、括号粘贴、斜杠命令、恢复终端（含 panic）、非终端时拒绝 | CI |
| 登录 | 模拟模型：接受和拒绝密钥、`--key-stdin`、`--base-url`、环境变量优先、写配置 | CI |
| 默认模型 | 已有：`finx-core/src/models.rs` 的单元测试，`e2e_no_model.rs` 走命令行、JSON-RPC、ACP，桌面端 `apps/desktop/e2e/first-run.mjs` 走第一次使用 | CI，桌面端手动 |
| 退出码 | 0、1、2、3、130 各一个场景 | CI |
| 命令规则 | `crates/finx-cli/src/cli_shape.rs`（§4.7）和 `tests/e2e_commands.rs`（已有）；第一个词的五种输入（§4.5，随交互模式） | CI |
| ACP 协议 | 官方 schema 的兼容测试（已有），加认证流程：`auth_required`、三种方法、terminal 能力的开关 | CI |
| JSON-RPC 示例 | `examples/rpc/` 配模拟模型真跑 | CI |
| 协议兼容 | §9.3 的 Schema 比较 | CI |
| 工具快照 | §8.2 | CI |
| 多版本共存 | 上一个发布版和当前版用同一个 `FINX_HOME`，互相写配置、读日志、设密钥 | CI，缓存上一版二进制 |
| 配置未知键 | §11.2 的每一行 | CI |
| 安装和升级 | 仿照桌面端的 `update-e2e.mjs`，本地起一个 GitHub 形状的服务：安装、升级、指定版本、摘要错误、签名错误、Homebrew 路径判断、组件 | CI |
| 网络清单 | 把 `HTTPS_PROXY` 指向一个记录用的代理，跑 `exec`、`acp`、`serve`，断言只访问了清单里的地址 | CI |
| 远程 | `ssh localhost finx acp`、`finx serve --stdio` | Linux CI |
| 静态构建 | 容器里跑冒烟：Ubuntu、Debian、Alpine、一个老 glibc 的系统。arm64 用 CI 的 arm runner 或 QEMU | CI |
| 性能 | `tools/bench/ratchet.py`、启动门槛（已有） | 合入前 |

macOS runner 在私有仓库里按 10 倍计费，可以只在合入 main 时跑 macOS。

### 16.2 干净环境验收（§1.3 的场景）

发版前手动走一遍，能脚本化的脚本化。

| 场景 | 环境 | 要特别看的 |
|---|---|---|
| S1 | 新的 macOS 用户账号：`curl`；浏览器下载 tar.gz；Homebrew。Linux：容器 | 浏览器下载的文件第一次运行，联网和断网各一次；`curl` 下载的确实没有隔离属性 |
| S2 | 空的 `HOME`，没有环境变量 | 每一步的提示；跳过、输错密钥、取消 |
| S3 | 真实模型，一个小仓库 | 终端：Terminal.app、iTerm2、VS Code、tmux、SSH；中文输入法 |
| S4 | GitHub Actions 示例 | 忘了设权限模式时流水线变红 |
| S5 | Zed（要先装） | §10.4 的清单 |
| S6 | 系统自带的 Python | 不装任何包 |
| S7 | 装着 FinxWork 的 Mac | 两边同时开；终端登录后应用能看到；应用开着时终端恢复同一个会话有清楚的提示 |
| S8 | 真实密钥 | §7.6 的名单 |
| S9 | 没装组件 | 模型读 PDF 时的表现：真实模型上跑几次，看它是告诉用户还是换办法 |

AGENT.md 的要求不变：只有单元测试不算验收。

## 17. 实施计划

### 17.1 一期：能独立使用

| 包 | 内容 | 主要改动 | 估算 |
|---|---|---|---|
| **A 打底** | 配置未知键（§11.2）；密钥跨进程（§11.3）；预检和退出码（§6）；命令规则和改名（§4），先做，后面的包照着写；`finx completion`；文案表（§10.2、§5）；CI 跑全部测试（§16.1） | `finx-core/config.rs`、`models.rs`、`tool_exec.rs`，`finx-llm/credentials.rs`，`finx-cli/main.rs`、`cmd_exec.rs`、`tests/cli_shape.rs`，`.github/workflows/ci.yml` | 7 天 |
| **B 模型** | `finx login`、`logout`（§7.3）；`--base-url`；`models check`（§7.6）；Gemini（§7.5）；OpenAI 改 Responses；验收 | `finx-cli/cmd_login.rs`，`finx-llm/types.rs`、`openai_chat.rs`、`builtin.toml` | 5 天 |
| **C 工具** | `finx tools`、`tools/list`（§8.3）；组件和 `finx install`（§8.4）；PDF worker（§13.3）；MCP 审批（§8.5）；工具快照；`config`、`sessions`、`web-search` 子命令 | `finx-cli/cmd_tools.rs`、`cmd_install.rs`、`cmd_config.rs`，`finx-docs/worker.rs`，`finx-core/approval.rs` | 5 天 |
| **D 交互** | §5 全部；项目信任提示（§12.2）；pty 测试 | `finx-cli/cmd_interactive.rs`、`term/`、`render.rs`、`approval_prompt.rs`，`main.rs` | 10 天 |
| **E 协议** | 分档和 Schema 比较（§9.2、§9.3）；文档生成；两个示例；ACP 登录（§10.1）；ACP 文案；注册表条目；真实编辑器验收 | `finx-protocol/schema.rs`，`finx-acp/lib.rs`、`out.rs`，`tools/gen-protocol-docs.mjs`，`examples/rpc/` | 4 天 |
| **F 发布** | 版本号；打包、签名、公证；清单和签名；安装脚本；Homebrew；`finx upgrade`；许可证和声明；用户文档；干净环境验收 | `tools/release/`，`finx-cli/cmd_upgrade.rs`，`site/`，`docs/cli/` | 7 天 |

共约 38 天，包含端到端测试，不含等待密钥和拍板。

**和验收场景的对应：** A 是地基，S4 的退出码和 S7 的共存靠它；B 对应 S2、S8；C 对应 S9；D 对应 S3；E 对应 S5、S6；F 对应 S1、S7，并把全部场景走一遍。

**顺序：** A 先合，它改的是共用的地方。B、C、D、E 互不依赖，可以各开一个 worktree 并行，要注意 `main.rs` 的子命令枚举和 `schema.json` 会有小冲突。F 的打包部分可以和它们并行，最后的验收放在最后。并行时日历上约 3 周。

**中途可以发的版本：** A、B、E、F 做完之后，即使交互模式还没好，也可以发一个给脚本和编辑器用的预览版（`0.2.0-beta`）。

### 17.2 二期：用得顺、可扩展

| 内容 | 章节 | 估算 |
|---|---|---|
| 外部钩子 | §8.6 | 3 天 |
| 客户端工具 | §8.6 | 3 天 |
| `@finxwork/sdk` | §9.6 | 4 天 |
| 执行沙箱（先出设计） | §12.6 | 另估 |
| 交互模式打磨：`@` 文件补全、图片粘贴、会话搜索 | §5 | 3 天 |
| 真实使用中发现的问题 | — | — |

### 17.3 要同步改的文档

实现时一起改，这次只在总方案登记了指向本文的条目：

| 文档 | 改什么 |
|---|---|
| technical-design.md | §1.3 非目标里的交互界面；§1.4；§10.1 严格校验；§10.4 环境变量；§12 命令表和退出码；Q-12；§18 |
| protocol-design.md | §6.4 加 `tools/list` 和分档；§6.3 兼容规则；§7.1 认证；§7.2 |
| mcp-design.md | D-107、Q-110、§9 |
| model-catalog-design.md | `finx login`（默认模型已同步，§4.6、§6.5） |
| desktop-release.md | 指向本文，说明两个发布仓库的关系 |

## 18. 需要拍板的事

2026-11-05 按负责人的要求全部实施：下面每一项都先照文中的建议做了，可以再改。其中 §18.5 的许可证没有替你选，发布脚本在没有 `LICENSE` 时拒绝发布。

每一项都先按"现在按这个写"的方案写进了文档。前五项有实际影响，后面的可以直接按建议走。

### 18.1 交互界面做成什么样

**场景：** 用户在项目里输入 `finx`，要能对话、看工具调用、批准操作、随时打断、运行中继续打字。

| 选择 | 结果 |
|---|---|
| **保留终端滚动区，底部几行活动区（现在按这个写）** | 工作量约 10 天。滚动、搜索、复制都是终端原有的，SSH 和 tmux 里没问题。做不了分栏和面板 |
| 全屏界面 | 视觉上更完整，能做面板。工作量大得多，首发要推迟几周；滚动和复制要自己实现，经常被抱怨 |

**怎么判断：** 你想象中的用户是把 finx 当成"终端里的一个命令"，还是"住在终端里的一个应用"？前者选第一种。

**能不能改：** 能。两种都吃同一份事件，以后加全屏不用动内核。

### 18.2 首发支持哪些平台

**场景：** Windows 用户想用 finx。

| 选择 | 结果 |
|---|---|
| **只做 macOS 和 Linux（现在按这个写）** | Windows 用户可以先用 WSL。没有额外工作量 |
| 加 Windows | 没有任何适配：Unix socket 要换命名管道，`bash` 工具要有方案，进程组、权限、路径规则都要重做，32 个文件直接用 Unix API。至少多 3–4 周 |

**怎么判断：** 你的第一批用户里有多少人不能用 WSL？如果目标是 Windows 上的普通办公用户，就要提前排期；如果是开发者，可以先等。

**能不能改：** 能，以后随时加。

### 18.3 千问办公、Qoder 这类本机账号连接进不进公开版

**场景：** 用户电脑上装了千问办公或 Qoder，finx 借用它们的登录状态调模型，不用买 API。

| 选择 | 结果 |
|---|---|
| **公开版不带，只有桌面端带（现在按这个写）** | 少了一条免费的路，但不背风险。公开的只有 API Key、Token Plan、ChatGPT 订阅、本机模型、兼容服务 |
| 公开版也带 | 模型接入更"完整"，用户不用买 API。但这是用别家客户端的登录状态，公开分发可能违反对方条款，也可能被针对性地封；对方改接口就会失效 |

**怎么判断：** 先看两家的条款。如果公司愿意承担被对方投诉的风险，可以带；不确定就先不带。

**能不能改：** 不带之后再加很容易。带了之后再撤，已有用户会受影响。这件事也决定源码能不能公开这部分代码。

ChatGPT 订阅不在这一项：按 chatgpt-api-design，开源和本地使用可以走公开的注册流程，但**付费或远程托管分发要另外申请**，首发前再确认一次我们属于哪种。

### 18.4 MCP 工具要不要审批

**场景：** 用户配了一个能发邮件的 MCP 服务器，权限模式选的是"逐项确认"。模型决定发一封邮件。

| 选择 | 结果 |
|---|---|
| **声明为只读的不问，其他的问（现在按这个写）** | 符合"逐项确认"的字面意思。手动模式下连接器的询问会变多；桌面端也一样，界面上要有"这个工具别再问"。Bot 默认完全访问，不受影响 |
| 维持现状：都不问 | 没有额外打扰，但用户以为每步都要确认，实际发邮件不问。公开之后这是安全问题，出事很难解释 |

**怎么判断：** 问自己：一个陌生用户看到"逐项确认"，会不会认为发邮件之前一定会问？

**能不能改：** 能。但先放开再收紧比先严后松难得多。

### 18.5 源码什么时候公开，用什么许可证

**场景：** 一个开发者想看代码、提补丁，或者公司法务要看许可证才允许用。

| 选择 | 结果 |
|---|---|
| **先发二进制，源码之后公开（现在按这个写）** | 不用等清理和条款问题，发布方式已经支持。但缺了开源项目的信任和贡献；有些公司和发行版不接受闭源工具 |
| 首发就开源 | 信任更高，可以 `cargo install --git`，也能进更多渠道。要先解决 §13.11 的清单和 §18.3，并且要定许可证 |

许可证：**依赖没有限制**（§13.11）。Apache-2.0 带专利授权，企业更放心，是这类项目最常见的选择；MIT 更短但没有专利条款；如果担心被人直接拿去做托管服务，有 BSL、FSL 这类"源码可见"的许可，但它们不算开源，社区接受度也低一些。

**怎么判断：** 你开源是为了让更多人用，还是为了防止别人拿去商用？前者选 Apache-2.0。

**能不能改：** 时机能改。许可证放宽容易，收紧几乎不可能，已经发出去的版本收不回来。**这一项一旦做了就最难反悔。**

### 18.6 首发要真实验收哪些服务商

**场景：** 公开文档写着支持 OpenAI，用户一试，工具调用报错。

需要的资源：一级名单里 OpenAI、Anthropic、Gemini、OpenRouter 的密钥，每家几块钱额度就够。DeepSeek 的测试密钥 2026-11-05 余额不足，也要充值。国内几家（Kimi、智谱、火山、腾讯）有密钥就一起验，没有就在文档里标"未验证"。

**能不能改：** 名单随时能加。没有密钥的话，一级名单里的那一家只能标"未验证"发出去，或者往后排。

### 18.7 按建议走就行的

| 事 | 建议 | 什么时候值得改 |
|---|---|---|
| 退出码 3（§6.1） | 加 | 模型试错被拒很常见，导致脚本频繁误报时 |
| 发布仓库名 `finxwork/finx-releases` | 用这个 | 想要 `finxwork/finx` 这样更短的名字时 |
| 界面默认英文，中文系统显示中文 | 这样做 | 目标用户全在国内时，可以默认中文 |
| Bot 和定时任务不进公开版 | 不进 | 要在服务器上跑定时任务时，先重新决定 D-433 |
| PDF 按需安装，不随主程序 | 按需 | 大部分用户都要读 PDF 时，让安装脚本顺手装上 |
| 命令改名（§4.4）和 `--json` 改义（§4.6） | 第一个公开版之前改好 | 已经有人写了脚本依赖旧写法时 |
| 隐藏 `finx chat` | 隐藏 | 想保留一个不带工具、只测模型的公开入口时 |

## 19. 决策与待定问题

### 决策

| 编号 | 决策 | 理由 | 章节 |
|---|---|---|---|
| D-500 | CLI、ACP、JSON-RPC 三个入口都对外，都是同一个内核的投影 | 对应三类使用者：人和脚本、编辑器、程序。没有第二份运行时逻辑 | §3.1 |
| D-501 | 三个入口的能力不强求对等：JSON-RPC 最全，ACP 守标准，CLI 给人和脚本用 | 硬要对等只会把桌面专用的东西推给所有人 | §3.3 |
| D-502 | CLI 的管理命令在进程内调用服务层方法，`--json` 输出方法的结果 | 规则只有一份，不用搬代码，和桌面端不会分叉 | §3.2 |
| D-503 | 交互模式直接驱动 `Kernel`，不起服务 | 和 `exec` 一样启动快；一个前端一个会话用不上中枢 | §3.1 |
| D-504 | 交互模式是隐藏子命令，解析前改写参数 | 其他命令的解析开销不变 | §4 |
| D-505 | 交互界面保留终端滚动区，只自绘底部活动区；依赖只加 `crossterm`、`unicode-width` | 滚动、搜索、复制不用重新实现；SSH、tmux 里可靠；依赖少 | §5.2 |
| D-506 | 没写 `model` 时，用第一个能用的服务商声明的第一个模型；一家都没有时没有默认模型，提醒去设置。已实现 | 只设了 `ANTHROPIC_API_KEY` 不应该报缺 DeepSeek 的密钥；什么都没配时不该显示一个用户没选过、也用不了的模型（用户要求，2026-11-05） | §7.2 |
| D-507 | `exec`、`chat` 开始前预检凭据，没有就退出 2，不建会话 | 配置错误不算任务失败，也不该留下一个空会话 | §6.2 |
| D-508 | 新增退出码 3：跑完了，但有操作因为没人能批准被拒绝 | 假成功是脚本里最坏的失败（实测） | §6.1 |
| D-509 | `finx login` 是所有接入方式的统一入口，规则沿用 `auth/set` | 第一次使用的人只需要记一个命令 | §7.3 |
| D-510 | Gemini 走官方 OpenAI 兼容接口，`ToolCall` 加不透明字段保存厂商数据 | 改动最小，只差函数调用的签名；走不通再写原生适配器 | §7.5 |
| D-511 | `finx models check` 作为统一的验收手段，服务商分两级 | 用户和发版用同一个工具；不假装都测过 | §7.6 |
| D-512 | `finx tools --json` 与 `tools/list` 相同 | 延续 `models` 的约定；程序也要知道有哪些工具 | §8.3 |
| D-513 | 组件按需安装，按版本分目录，缺组件的提示写在工具结果里 | 主程序保持小而单一；不改提示词；不会半新半旧 | §8.4 |
| D-514 | MCP 工具按注解和服务器来源审批（待拍板，改 D-107） | 公开后"逐项确认"不能有例外 | §8.5 |
| D-515 | 不做配置文件定义的命令工具 | Skill 和 MCP 已经覆盖 | §8.6 |
| D-516 | JSON-RPC 方法分稳定、实验、内部三档，写进 Schema | 只对能负责的部分承诺 | §9.2 |
| D-517 | 稳定档同一版本内只增不改，CI 比较上一版 Schema | 规则要有机器把关 | §9.3 |
| D-518 | 不开端口，远程走 ssh | 不用新代码，认证和加密都有现成的；不暴露攻击面 | §9.5 |
| D-519 | ACP 走标准认证流程：agent 方法总是列，terminal 方法看客户端能力，缺凭据返回 `auth_required` | 编辑器才知道该引导登录；注册表也要求 | §10.1 |
| D-520 | 面向人的文案英文为主，按系统语言出中文；面向模型的文字一律英文，不翻译 | 公开产品不能写死中文；提示词要稳定 | §10.2 |
| D-521 | 配置读取时不认识的键降为警告，`rules`、`hooks`、写入、值不合法仍然严格 | 两个版本共用目录时不能互相弄坏；防拼写错误的目的还在。改总方案 §10.1 | §11.2 |
| D-522 | 密钥变化用 stamp 文件跨进程传递 | 修在拥有数据的地方；服务不在、版本不同都能用 | §11.3 |
| D-523 | 交互模式只在项目确实带了可信任的内容时询问 | 没东西可信任时打扰没有意义；`exec` 等不变 | §12.2 |
| D-524 | Bot 和定时任务不进 CLI 产品 | D-433 要求发布前重新决定；CLI 用户不需要它们才能用 | §12.4 |
| D-525 | 不做遥测；公开网络访问清单，并用测试核对 | 本地优先的产品要说得清 | §12.5 |
| D-526 | workspace 版本就是 CLI 版本，从 0.2.0 开始 | 现在一直是 0.1.0，无法判断升级 | §13.1 |
| D-527 | Linux 主程序用静态 musl | 不挑发行版；启动明显更快（实测） | §13.2 |
| D-528 | Linux 的 PDF 由动态链接的 `finx-doc-worker` 承担 | 静态程序不能 `dlopen`（实测）；worker 本来就是独立进程 | §13.3 |
| D-529 | macOS 产物 hardened runtime 签名并公证，钥匙不出本机 | 沿用 DQ-16；公证后浏览器下载也能跑 | §13.4 |
| D-530 | 新建公开的 `finxwork/finx-releases`，不和桌面端共用，不等源码公开 | `latest` 只有一个；节奏不同；注册表按它更新 | §13.5 |
| D-531 | 清单用 ed25519 签名，公钥编译进程序 | GitHub 账号失守也装不上别人的代码，Linux 上也一样 | §13.6 |
| D-532 | 安装脚本是发布仓库的一个文件，不用 sudo，不改 shell 配置 | 只依赖 GitHub；不做用户没要的事 | §13.7 |
| D-533 | `finx upgrade` 只升自己装的；更新检查只在交互模式 | 不和包管理器抢；脚本和编辑器里不能有意外的网络访问 | §13.9 |
| D-534 | 每家起步的模型就是它声明的第一个模型，不加 `default_model` 字段；声明过的模型总显示。没声明的退回最新显示的 | 字段更少；挑选由人负责，不会因为目录更新悄悄换成更贵的；用测试盯住下线 | §7.2 |
| D-535 | 新错误 −32046 `no_model`；`SessionDefaults.model` 改为可选。ACP 上是 `auth_required` | 客户端能分清"还没设置"和"这个模型不可用"（`model_unavailable`），并把人带到设置页 | §7.2 |
| D-536 | 会话用的模型的服务商没了、又没有默认模型时，用占位模型打开：历史能看，发送失败 | 去掉写死的默认模型后，这是打开旧会话唯一会失败的情况；看历史不需要模型 | §7.2 |
| D-537 | 默认模型每次算，不写进配置 | 接入、移除马上生效；密钥删了不会留下一个指向没密钥服务商的配置。代价见 Q-313 | §7.2 |
| D-538 | 一个概念一种控制方式、一个名字；运行选项一张表，写明各入口的名字 | 三个入口加配置和环境变量，名字很容易各长各的；懂 git 的人应该猜得到 | §4.2 |
| D-539 | 运行参数只影响这次；设置命令才保存，并打印一行写明值和文件；只看的命令不改东西 | 脚本和智能体可以放心调用；用户知道改了什么、改在哪 | §4.2 |
| D-540 | `finx config` 带 `--show-origin`；在智能体的环境里拒绝改权限类配置 | 五层配置要能查出处；"总是允许 `finx config`"不应该连带放开权限 | §4.2 |
| D-541 | 继续会话只留 `finx resume` 和 `finx exec --resume` 两种写法；动词和范围词统一；公开之前改名不留别名 | 写法放出去就收不回来；`show` 改东西、`--here` 自造词都是迟早的坑 | §4.4 |
| D-542 | 一个不是命令的参数才算提示词；多个裸词报错；接近命令名的词给提示 | 手误不该开一个会话、花一次模型请求 | §4.5 |
| D-543 | `--json` 总是一个 JSON 值，错误也是；`exec --json` 改义；没有终端不提问 | 一个参数一种意思；脚本不用分情况解析 | §4.6 |
| D-545 | OpenAI 先留在 `openai-chat`，有真实密钥再切 Responses | `openai_responses.rs` 是 ChatGPT 路线的适配器，没验证就切可能把能用的改坏 |
| D-546 | 公开版用 `--no-default-features` 构建，不带本机账号连接；不加 `finx connections` | §18.3 的建议；不带之后再加容易，带了再撤难 |
| D-547 | MCP 审批的判定放在 `Tool::runs_unasked`，规则按完整工具名匹配 | 复用现有的规则和"本会话不再问"，不多一种机制 |
| D-548 | `finx --help` 第一行："an AI agent for your terminal, your editor and your programs" | 面向用户，也符合基础提示词的能力范围（Q-308） |
| D-549 | 签名工具是 `finx-core` 的 example，不进 `finx` | 公开程序里不需要会签名的代码 |
| D-550 | 交互模式等 `Kernel::start` 走完再显示输入框 | 它不等 MCP，够快，放后台只会多状态 |
| D-551 | 交互模式的审批回答是一行字加回车 | 和 `exec` 共用判定，`1!` 这种答案也能打 |
| D-552 | Schema 兼容比较做成测试，基线是仓库里的 `schema-released.json` | 不依赖 CI 取上一版的文件，本地也能跑 |
| D-553 | `finx tools` 的清单来自会话实际运行的工具对象，只有"需要什么"是写的 | 清单不会和工具走样 |
| D-554 | 接受独立发布一期带来的启动回退（约 2–6%，每次 0.1–0.2 ms），不继续压 | 人感觉不到，主要来自新增功能和代码；负责人 2026-11-06 决定。规则本身不变，只是基线更新 |
| D-544 | 控制项分四档，废弃有期限且由测试执行；`cli_shape.rs` 检查命令树、环境变量和运行选项表 | 规则靠人记会走样（`FINX_DEBUG_HTTP` 就是例子）；旧写法不会被忘掉 | §4.7 |

### 待定问题

| 编号 | 问题 | 当前假设 | 章节 |
|---|---|---|---|
| Q-300 | 交互界面的形态 | 滚动区加活动区 | §18.1 |
| Q-301 | 首发平台 | macOS、Linux | §18.2 |
| Q-302 | 本机账号连接进不进公开版 | 不进 | §18.3 |
| Q-303 | MCP 审批规则 | D-514 | §18.4 |
| Q-304 | 源码公开的时机和许可证 | 先发二进制；公开时用 Apache-2.0 | §18.5 |
| Q-305 | 一级服务商名单和密钥 | §7.6 | §18.6 |
| Q-306 | 发布仓库名 | `finxwork/finx-releases` | §13.5 |
| Q-307 | ChatGPT 订阅登录在公开分发时是否要申请 | 首发前查清 | §18.3 |
| Q-308 | `finx --help` 第一行的产品描述 | 暂定 D-548，负责人可改 | §14 |
| Q-309 | 清单私钥怎么备份 | 已生成在钥匙串；离线备份由负责人做，方式待定 | §13.6 |
| Q-310 | `FINX_DEBUG_HTTP`、`FINX_DEBUG_RPC` 做不做 | 文档写了但没实现。不在一期，已从总方案和协议方案去掉；真要做时诊断类变量统一放在 `FINX_LOG` 这一组 | §6.4 |
| Q-311 | 文案表覆盖到哪一层：服务层的中文错误（`customize.rs` 等）是否也改 | 不改：这些是连接器流程，只有桌面端走得到。命令行开放连接器时再改 | §10.2 |
| Q-312 | 没有密钥时联网搜索默认把搜索词发给 Exa、Parallel，公开版是否改成默认关闭 | 保持开启，写进隐私说明 | §12.5 |
| Q-313 | 后接入的服务商排在前面时，没写 `model` 的默认模型会变。是否在第一次接入时把模型固定下来 | 不固定：模型按钮和 `finx status` 看得见，要固定就写 `model`。真有人因此多花钱或搞混时，再看第一次接入时写进配置，或者记住上次用的模型 | §7.2 |

## 20. 按需再加

| 内容 | 什么情况下做 | 做法 |
|---|---|---|
| 全屏界面 | 有明确的面板类需求，且活动区不够用 | 换展示层，事件不变 |
| Windows | §18.2 的判断变了 | 先做 stdio 和文件工具，socket 换命名管道 |
| WebSocket、HTTP | 真有远程客户端，ssh 不够 | protocol-design §8.3，跟随 ACP 远程工作组的规范 |
| Bedrock、Vertex 原生 | 企业用户要求，且网关不行 | 新适配器；Vertex 先试 `api_key_command` 配 `gcloud` |
| Gemini 原生适配器 | 兼容接口走不通，或者要 Google 专有能力 | `api/gemini.rs` |
| 再加内置服务商 | 有用户要，且 OpenRouter 和 `--base-url` 不够 | 写 `builtin.toml`，跑 `models check` |
| Python SDK | 有人在写 Python 客户端，示例不够 | `examples/rpc/minimal.py` 扩展成包 |
| 长驻进程工具 | 模型经常需要启动开发服务器又管不好 | 现在 `nohup … &` 能用：工具立刻返回，进程在 finx 退出后还在（实测）。基础提示词让它别这么做（`bash` 的 guideline），先调整措辞，再考虑新工具（Q-13） |
| 交互式命令 | 模型经常卡在需要输入的命令上 | 新工具配 pty |
| 待办清单工具 | 真实任务里模型经常丢步骤 | Q-16，先看数据 |
| `plan`、`auto` 权限模式 | 名字已预留（Q-29） | 需要只读规划流程；`auto` 需要判断风险的小模型 |
| grep、find 工具 | `bash` 不够好或有性能证据 | Q-09 |
| 常驻服务开机自启 | CLI 用户要跑常驻会话 | launchd、systemd 单元，Q-27 |
| Linux Secret Service | 桌面 Linux 用户要求 | `credentials.rs` 加一种 store，没有时退回文件 |
| Alpine 上的 PDF | 有 Alpine 用户要读 PDF | 组件加 musl 动态版 worker |
| 下载镜像 | 国内用户频繁装不上 | 清单和脚本支持换地址，要先重新看 RG1 |
| npm 包 | 要让 Node 用户 `npx finx` | 各平台一个可选依赖，主包只是启动器 |
| deb、rpm | 企业要求 | 发版脚本多打一种包 |
| Docker 镜像 | CI 用户要求 | `scratch` 加静态二进制 |
| GitHub Action | 用的人多了 | 包一层 `finx exec` |
| 用量汇总命令 | 用户想知道这个月花了多少 | `finx usage`，先看会话日志里的用量够不够 |
| `exec` 的 `--quiet`、`--system`、每条命令的超时 | 用户要求，且 `-c` 不够用 | 加参数，按 §4.2 的顺序判断 |
| 交互模式的会话选择器 | `/resume` 的列表不够用 | `finx resume` 不带参数时选，`last` 仍然是最近一个 |
| 应用里"安装命令行工具" | FinxWork 用户想直接用 `finx` | 链到应用里的 `finx`；和 `finx upgrade` 的判断一致 |

## 21. 实施现状（2026-11-05）

分支 `claude/cli-standalone-capabilities-bbc7da`，未合入 main，未推送。

### 21.1 自动测试

`cargo test --workspace`（带 PDFium）全过，92 个测试目标、1290 项；前端 121 项、桌面端 145 项也全过（桌面端有一次全量运行失败，失败详情没有留下，之后连续重跑都通过，没有查明原因）。新增的端到端测试：`e2e_login.rs`、`e2e_commands.rs`、`e2e_components.rs`（本地起一个 GitHub 形状的发布，走安装、升级、签名错误、摘要错误、`install.sh`）、`e2e_interactive.rs`（真实伪终端：发送、审批的回答、`/` 命令、恢复、取回排队、第一次运行登录、信任提问、非终端拒绝）、`e2e_examples.rs`（两个示例真跑）、`e2e_docs.rs`（文档里标了 `doc-test: run` 的命令真跑，链接不断）、`e2e_network.rs`（脚本、查看类命令和编辑器不访问模型之外的地址，常驻服务只访问公共目录）、`finx-core/tests/mcp.rs` 的审批表。

### 21.2 真实模型验收

`tools/acceptance/cli_acceptance.py`，干净的 `HOME`，百炼 Token Plan 的 `deepseek-v4.1-flash`，24 项全过：

| 场景 | 验过什么 |
|---|---|
| S2 | 没有模型时退出 2 并给出 `finx login`；真实密钥登录；错误密钥被拒且不保存；任务跑在保存的密钥上。交互式的选择流程在 pty 测试里用模拟模型走 |
| S3 | 真实模型改文件：问题里能看到改动，答 `y` 后文件改了；中文消息；`/rename`；退出提示；`finx resume` 显示之前的内容并接着聊 |
| S4 | 被拒退出 3 且 `refused` 有内容，设权限模式后退出 0；事件流；`exec --resume` |
| S5 | 只用 ACP 协议本身：三种登录方式、英文选项、跑任务、审批后写文件。**不是真实编辑器** |
| S6 | `minimal.py`、`minimal.mjs` 都跑通 |
| S8 | 这一个模型通过 `finx models check`；`doctor --online`；Parallel 真实搜索通过，Exa 这次被限流 |
| S9 | 没装 PDF 组件时，模型读到错误并告诉用户 |

打断、运行中插话、跟进、取回只用模拟模型测过，没有在真实模型上走。

**用发布产物验过（2026-11-05 干跑打出的文件）：**

- 公开版的 macOS 程序跑完上面 24 项，全过；
- x86-64 Linux 主机上，`install.sh` 从本机起的镜像装好；手动放好 PDF 组件后，静态主程序经 `finx-doc-worker` 真实读出 PDF 的内容；
- macOS 上，签过名、开了 hardened runtime 的主程序加载我们签名的 `libpdfium.dylib`，同样读出内容；
- `ssh host finx serve --stdio` 完成了初始化握手，后面的方法没有走。

### 21.3 性能棘轮（2026-11-06，没有过，负责人接受，D-554）

候选是这个分支的最终代码（合并了 `0c4b181`），基线是 `0c4b181`。macOS、Linux 启动和负载都跑了，**标出 15 项回退、1 项变好，棘轮没有通过。负责人 2026-11-06 决定接受这个代价（D-554）**。负载测试的任务时延和吞吐没有回退，这一轮也没有失败的运行。

| 指标 | 基线 | 候选 | 变化 |
|---|---|---|---|
| Linux `exec` 到第一个模型请求 | 5.217 ms | 5.426 ms | +4.0% |
| Linux ACP `initialize` | 3.166 ms | 3.309 ms | +4.5% |
| Linux socket `initialize` | 4.380 ms | 4.615 ms | +5.4% |
| macOS ACP 到第一个模型请求 | 9.322 ms | 9.524 ms | +2.2% |
| macOS ACP `session/new` | 1.183 ms | 1.253 ms | +5.9% |
| Linux ACP 复用进程新建会话到请求 | 1.942 ms | 2.051 ms | +5.6% |

**已经修掉的：** `finx status` 不再为了列组名而生成全部工具定义（缺页 +190 降到 +8）；每个配置文件只解析一次；ACP 的凭据检查不再多开一次工作区、不再绕线程、不再复制服务商配置。

**剩下的原因（`fault_trace.py`，Linux）：** `acp` 多 22 次缺页，其中 `.text` +15、匿名内存 +6；`--help` 多 17 次，其中匿名内存 +11，是新增子命令的解析器占用。主程序 `.text` 多 1.3 MB（+5%）。也就是说，大部分是多了功能和代码的代价，不是某一处写错了。ACP 的 `session/new` 还多一次凭据判断，原因没有再细分。

**预算：** `--help` 的缺页预算从 253 调到 272（`local-command-budget.json`，写了原因）。`status`、`doctor`、`sessions` 仍在预算内。这只是换算出来的，要等 CI 实测。

**一次偶发：** 第三轮的负载测试有一次运行失败，2 个会话报 `mcp_unavailable`（连不上模拟 MCP 服务器的本地地址）。第四轮没有再出现，也没有查出原因。

**决定（D-554）：** 接受每次启动多 0.1–0.2 ms，不为这些回退继续优化。之后还想压的话，可以试的方向是把交互模式的依赖和命令定义挪到冷路径、调整链接时的代码布局，效果没有估过。这次接受只针对这批功能带来的增长，棘轮规则本身不变；合入时基线随之更新，以后的改动按新基线比较。

### 21.4 没做或做不到的

| 内容 | 卡在哪 |
|---|---|
| 真正发布；S1 从 GitHub 安装 | 发布仓库没建，这是对外动作，等负责人。`install.sh` 和 `finx upgrade` 用本地发布测过 |
| `LICENSE` | §18.5 负责人决定。没有它发布脚本不放行 |
| 公证 | `FINXWORK_NOTARY_PROFILE` 没设。macOS 文件签了名，公证和 Gatekeeper 的表现（§13.4）都没验 |
| 私钥备份 | Q-309 |
| S5 真实编辑器（§10.4） | 这台机器没装 Zed |
| S7 和真实的 FinxWork 共存 | 没走；配置的新旧兼容有单元和端到端测试，但"上一个发布版"还不存在 |
| S8 其他服务商：OpenAI、Anthropic、Gemini、DeepSeek、OpenRouter、Ollama 等 | 没有可用的密钥；DeepSeek 的测试密钥余额不足。文档 `models.md` 如实标了未验证 |
| 多种终端、中文输入法（§16.2） | 只在伪终端里测过，没有在 Terminal.app、iTerm2、tmux、SSH 上看过 |
| `docs/cli` 的中文版 | 只写了英文 |
| 静态构建的容器矩阵（§16.1） | 只在一台 Debian 上跑过；Alpine、老 glibc、arm64 没跑 |
| 发布脚本的 Intel Mac、Linux arm64 冒烟 | 这两个平台的文件打出来了，没有实际运行过；真发布时脚本会因此拒绝，要先在对应系统上跑 |
| 从签名清单真实下载组件 | 发布构建只认 GitHub 地址，发布之前走不了；同样的流程用开发构建配本地发布测过 |
| 二期（§17.2） | 按计划不在这次 |
