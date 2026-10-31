# finx MCP 接入方案

| 项 | 内容 |
|---|---|
| 版本 | v1.4 |
| 日期 | 2026-10-31 |
| 状态 | 已定稿；一期已实现并通过验收（§16）。v1.1 记录实现中的调整（§16.1）；v1.2 把大服务器的列表改为只给名字（D-124），`call_tool` 整理以字符串发来的参数（§7.6）；v1.3 定下二期的远程鉴权与传输：OAuth、客户端身份、旧版 SSE、先探测后写入（§13.6–§13.8，D-180–D-187），已实现（§16.2）；v1.4 加上服务的 logo 和"同一个服务只连一次"（§13.9、§13.10，D-188–D-193），已实现（§16.2） |
| 关系 | 扩展 technical-design.md（下称总方案）的 §5 工具系统、§6 内核运行时、§8 对外协议、§10 配置、§11 安全；对外协议部分与 protocol-design.md（下称协议方案）的 §6、§7 衔接；子智能体部分与 subagent-design.md（下称子智能体方案）的 D-42 衔接 |

## 方案摘要

- **是什么**：finx 作为 MCP 客户端，连接用户配置的 MCP 服务器，把服务器提供的工具注册成内核里的普通工具。模型像调用 read、bash 一样调用它们。
- **内核只有一个入口**：会话启动时收到一份已经解析好的服务器列表。列表由前端从下面几个来源合并，内核不区分来源：
  - 用户配置 `~/.finx/config.toml` 的 `[mcp_servers.<name>]`；
  - 项目配置 `.finx/config.toml` 的同一段，只在受信任的项目中加载；项目根目录的 `.mcp.json`（别的工具约定的通用格式）默认不读，打开 `mcp.project_json` 后在受信任的项目中读取（D-118）；
  - 命令行：`-c` 覆盖和 `--mcp-config <file>`；
  - 客户端：ACP 在 `session/new`、`session/load` 里带来的 `mcpServers`，原生协议 `session/new`、`session/resume` 的 `mcp_servers`。
  - 同名时，后面的来源覆盖前面的。
- **注册**：服务器就绪后，它的每个工具包装成一个实现 `Tool` 的 `McpTool`，名字是 `mcp__<server>__<tool>`。从这里开始与内置工具走同一条路：钩子、审批、并发、裁切、事件、会话日志都不变。
- **渐进式加载（默认）**：MCP 工具默认不进工具列表，分三层按需展开（§7）：
  - 目录：系统提示词里每个服务器一行说明，整段最多 4 KB，上百个连接器也只占一千来个 token；
  - 定义：模型用 `tool_search` 搜到工具，拿到它的参数 schema，结果只追加在历史里；
  - 调用：经 `call_tool` 执行。工具列表和系统提示词在整个会话里不变，DeepSeek 这类不能中途增加工具的厂商也不会因为加载工具而丢缓存；
  - 工具很少、几乎每次都用的服务器可以设为 `direct`，工具直接进工具列表。
- **调用**：发 `tools/call`。默认 300 秒超时，服务器每报一次进度重新计时；用户中断或超时都通知服务器取消；服务器报的进度转成 `tool_progress`；结果转成文本和图片，之后照常裁切（D-36）。
- **不拖慢启动**：
  - 没有配置服务器时，没有任何额外开销；
  - 配置了服务器时，会话一创建就并行连接，不阻塞 `session/new`；
  - 按需加载的服务器不用等，第一次请求立即发出，搜索或调用时才等它；
  - direct 服务器在第一次模型请求之前等待，最多 10 秒；没等到的在后台继续连接（单个服务器最多 30 秒），就绪后再加入；
  - 二期缓存服务器的工具目录，按需加载的服务器在用到之前不必启动。
- **缓存**：按需加载的服务器不改动请求前缀；direct 服务器的工具集合只在两次模型请求之间变化（迟到的服务器、服务器通知工具列表变了），每次变化付出一次缓存未命中。
- **故障**：一个服务器出问题只影响它自己的工具，调用得到说明原因的错误；崩溃或断线后，下一次调用它的工具时自动重连一次。
- **权限**：
  - 一期 MCP 工具不审批：所有权限模式下直接运行，子智能体和 `finx exec` 里同样可用；
  - 服务器自称只读（`readOnlyHint`）只让它可以与其他只读工具并行；
  - 未受信任的项目不加载项目里的服务器；
  - 本地服务器只拿到白名单里的环境变量（基本、代理、证书）和配置里写明的变量，环境里的其他密钥不会交给它。
- **子智能体**：拿到父的全部工具，只去掉 `spawn_agent` 和 `send_message`；与根会话共用 MCP 连接。
- **协议**：新增 `mcp_server_status` 事件，快照带上各服务器的状态；ACP 声明支持 http 传输。
- **实现**：新 crate finx-mcp，自研最小客户端，基于 finx-rpc 和 finx-llm 的 HTTP 客户端，支持 stdio 和 Streamable HTTP 两种传输；二期加上旧版 SSE（§13.7）。
- **远程鉴权（二期，§13.6–§13.8）**：
  - 三种方式：OAuth 登录、令牌（写在请求头里）、不需要鉴权。添加时先不带凭据探测一次，按服务器公布的设置选好默认值。
  - OAuth：授权码加 PKCE，回调在本机 127.0.0.1 的随机端口，令牌存系统钥匙串并自动续期。
  - 客户端身份的顺序：用户配置的应用 → finx 公布的身份（客户端元数据文档）→ 动态注册（注册结果在本地复用）→ 请用户填。
  - 先探测、后写入：检查通过才写配置；失败时由用户决定是否仍然添加。
- **分期**：
  - 一期：注册、按需加载与调用的完整链路，约 2.5 周；
  - 二期：工具目录缓存与按需启动、OAuth、旧版 SSE、探测、`finx mcp add`、手动重连、resources、elicitation；
  - 三期：厂商原生的中途声明工具、常驻服务里多个会话共用服务器进程。

## 目录

- 方案摘要
- 0. 阅读说明
- 1. 目标与原则
- 2. 现状盘点
- 3. 总体设计
- 4. 服务器从哪里来
- 5. 连接与生命周期
- 6. 注册：MCP 工具变成内核工具
- 7. 渐进式加载
- 8. 调用
- 9. 权限
- 10. 子智能体
- 11. 对外协议
- 12. 配置与命令行
- 13. 客户端实现（finx-mcp）
- 14. 性能与资源
- 15. 代码落点
- 16. 分期实施与验收
- 17. 测试
- 18. 备选方案与取舍
- 19. 决策与待定问题
- 附录 A：配置示例
- 附录 B：事件流示例
- 附录 C：给模型的文本

## 0. 阅读说明

- **章节引用**：§x 指本文；"总方案 §x"指 technical-design.md；"协议方案 §x"指 protocol-design.md；"子智能体方案 §x"指 subagent-design.md。
- **术语**：沿用总方案 §2，新增的如下。

| 术语 | 定义 |
|---|---|
| MCP | Model Context Protocol。客户端（finx）通过 JSON-RPC 2.0 连接服务器，使用服务器提供的工具、资源和提示词 |
| 服务器 Server | 一个 MCP 服务器。本地的是 finx 启动的子进程（stdio 传输），远程的是一个 URL（Streamable HTTP 传输） |
| 服务器配置 McpServerConfig | 一个服务器的名字、传输方式和选项，已经展开了环境变量。内核只认这一种形式 |
| 连接 Connection | finx 与一个服务器之间完成了初始化握手的会话 |
| 就绪 Ready | 连接已经建立，工具列表已经取回 |
| MCP 工具 | 服务器在 `tools/list` 里列出的一个工具；注册进 finx 以后叫 `McpTool` |
| 限定名 | MCP 工具在 finx 里的名字 `mcp__<server>__<tool>`，也是模型看到的名字 |
| 工具集合 | 一次模型请求带上的全部工具：内置工具、智能体工具、MCP 工具 |
| 确定 Settle | 第一次模型请求之前，等待每个服务器就绪、失败或等待超时 |

- **编号**：决策从 D-100 起，待定问题从 Q-100 起，避开并行分支正在使用的编号。并入总方案时保持不变。D-100–D-125 已用完，二期的鉴权与传输用 D-180–D-189（D-126–D-179 已被其他方案占用）；待定问题接着用 Q-118、Q-119。
- **给模型的文本**：错误说明、占位文字按 D-16 使用英文。
- **代码块**：Rust 定义只是接口草图，用来说明字段与语义。

变更记录：

| 版本 | 日期 | 说明 |
|---|---|---|
| v0.1 | 2026-10-29 | 初稿：服务器的来源与合并、内核入口、连接与生命周期、注册、调用、权限、子智能体、对外协议、配置与命令行、客户端实现、分期与测试 |
| v0.2 | 2026-10-29 | 按评审意见修改：MCP 调用一期不审批（§9、D-107）；子智能体拿到父的全部工具，只去掉两个智能体工具（§10、D-110）；子进程环境用白名单（D-112，确认）；`.mcp.json` 默认不读（D-118）。新增第 7 章渐进式加载：默认按需加载，分目录、`tool_search`、`call_tool` 三层，工具列表与系统提示词整个会话不变（D-119–D-123）；原第 7 章起的章节号顺延 |
| v1.0 | 2026-10-29 | 定稿：确认 MCP 工具默认按需加载、不按工具数量自动切换（D-119），DeepSeek 等没有原生能力的厂商上经 `call_tool` 调用搜到的工具（D-122） |
| v1.3 | 2026-10-31 | 二期的远程鉴权与传输定稿（随桌面端添加连接器的新流程，customize-design §10.9）：新增 §13.6 探测、§13.7 旧版 SSE、§13.8 OAuth；配置新增 `transport`、`auth`、`oauth`（§4.3、§12.1）；命令行新增 `finx mcp login/logout`，`finx mcp add` 先探测后写入（§12.2）。调研了其他产品的做法并实测了几个服务器公布的登录设置（§13.8.6）。新增决策 D-180–D-187、待定问题 Q-118、Q-119；Q-102 已定 |

## 1. 目标与原则

### 1.1 目标

| 编号 | 目标 | 章节 |
|---|---|---|
| G1 | 支持 MCP：stdio 与 Streamable HTTP 两种传输，工具的注册与调用完整可用 | §5 §6 §8 |
| G2 | 用户在惯用的地方配置服务器：finx 配置文件、项目的 `.mcp.json`、命令行；编辑器和桌面端可以按会话带来服务器 | §4 |
| G3 | MCP 工具与内置工具同等对待：同一个注册表、同一套钩子与审批、同样的裁切、事件和日志 | §6 §8 §9 |
| G4 | 没有配置服务器时零开销；配置了也不阻塞会话创建；按需加载的服务器不让第一次请求等待 | §5.3 §7.8 §14 |
| G5 | 请求前缀稳定：工具集合只在两次请求之间变化，而且只在确实变了的时候 | §5.4 §6.7 |
| G6 | 安全：项目里的服务器需要信任；本地服务器拿不到环境里的其他密钥；密钥不进日志、不进事件 | §4.4 §5.7 |
| G7 | 编辑器（ACP）和桌面端看得到服务器的状态，能在会话里带来自己的服务器 | §11 |
| G8 | 依赖少：复用 finx-rpc 和 finx-llm 的 HTTP 客户端，不引入完整的 SDK | §13 |
| G9 | 工具再多也不占满窗口：MCP 工具默认按需加载，上百个连接器的目录也只占一千来个 token，加载工具不破坏请求前缀 | §7 |

### 1.2 原则

- **MCP 是工具来源，不是新的执行路径**：MCP 工具进入会话的工具注册表以后，内核按名字查到它、交给钩子、审批、执行、裁切、记录，与内置工具没有区别。MCP 相关的代码只在两头：连接管理和 `McpTool` 适配器。
- **内核只认一种输入**：配置文件、`.mcp.json`、命令行、ACP、原生协议各有各的格式，都在前端换成 `McpServerConfig`。内核不读这些文件，也不知道服务器从哪里来。
- **只追加**：工具集合与系统提示词一样冻结在请求前缀里，只在确实变化时、在两次请求之间替换，并记入会话日志。历史本身从不改写（总方案 §7.7）。
- **按名查表，不解析名字**：限定名只是注册表里的键，调用时查表拿到服务器和原始工具名。名字的截断、加后缀都不影响路由。
- **服务器的自我声明只是提示**：工具的注解（只读、破坏性等）是服务器自己声明的，内核不能验证，所以只用来改善并发。
- **失败可见、不连坐**：一个服务器起不来或中途崩溃，只影响它自己的工具：发出状态事件，调用返回说明原因的错误结果，其他工具照常工作。

## 2. 现状盘点

| 现状 | 位置 | 对 MCP 的影响 |
|---|---|---|
| 工具注册表有序、每个会话固定；名字限定为 1–64 个字母、数字、`_`、`-`，重名报错 | finx-tools `registry.rs` | 注册表要能在两次请求之间整体替换（§6.7）；限定名必须满足这个格式（§6.2） |
| `Tool` 接口：`spec`、`kind`、`guidelines`、`describe`、`execute` | finx-tools `tool.rs` | `McpTool` 直接实现它；新增 `origin()` 区分工具来源（§6.1） |
| `kind` 同时决定并发（只读并行、修改独占）和默认审批（只读放行） | finx-tools `tool.rs`、finx-core `approval.rs` | MCP 工具把两件事分开：只读注解只决定并发；一期 MCP 工具不审批（§9） |
| 系统提示词在会话启动时生成一次，记成 `system_prompt` 条目，恢复时沿用 | finx-core `prompt.rs`、`kernel.rs` | 服务器的 instructions 要等连接就绪才知道；工具集合变化时重记一条（§6.6） |
| 固定部分（系统提示词加工具定义）的 token 估算只算一次 | finx-core `budget.rs` 的 `fixed_tokens` | 工具集合变化后要重算（§6.7） |
| 配置分三层：用户 < 项目 < `-c`；未受信任的项目会去掉放松安全的配置项 | finx-core `config.rs`、总方案 §11.7 | 项目里的服务器等于在本机执行代码，未受信任时整体去掉（§4.4） |
| ACP `session/new` 收到 `mcpServers` 时忽略，`mcpCapabilities` 两项都是 false | finx-acp `lib.rs` | 改为接受 stdio 和 http 两种服务器（§11.3） |
| finx-rpc 提供按行分帧的 JSON-RPC 2.0 和通用客户端，协议方案 §2.3 已预留给 MCP 客户端 | finx-rpc | stdio 传输直接复用（§13） |
| finx-llm 有进程共享的 reqwest 客户端（连接池、系统证书、代理）和 SSE 解析 | finx-llm | Streamable HTTP 传输直接复用（§13） |
| `.mcp.json` 已在受保护文件列表里 | finx-core `protected.rs` | 模型改它要经过审批，不能悄悄给项目加服务器 |
| 子智能体只有父的基础工具，不含智能体工具 | 子智能体方案 D-42、D-53 | MCP 工具算基础工具，子智能体共用（§10） |
| Q-17：联网工具以后经 MCP 接入 | 总方案 §20 | 本方案落地后，网页抓取、搜索这类能力由用户配置的服务器提供 |

## 3. 总体设计

### 3.1 分层

```
来源    ~/.finx/config.toml   .finx/config.toml   .mcp.json   -c / --mcp-config   ACP / 原生协议
          └──────────────── 前端与 Workspace 合并、展开环境变量、检查信任 ───────────────┘
                                         │ Vec<McpServerConfig>
内核    finx-core   McpManager（每棵智能体树一个）：启动、确定、状态事件、工具集合、关闭
                      │ McpTool（实现 Tool）进入会话的 ToolRegistry
                      │ 钩子 → 审批 → 执行 → 裁切 → 事件 → 日志（与内置工具相同）
客户端  finx-mcp    McpClient：初始化、工具列表、调用、取消、进度、服务器发来的请求
                      │
传输                  stdio（finx-rpc 分帧 + 子进程）   Streamable HTTP（finx-llm 的 reqwest + SSE）
                      │
外部                  本地 MCP 服务器进程                远程 MCP 服务
```

### 3.2 crate 划分

| crate | 变化 |
|---|---|
| finx-mcp（新） | MCP 协议的本地最小类型、`McpClient`、两种传输、`McpTool` 适配器、限定名、schema 修正、结果转换。依赖 finx-rpc、finx-tools、finx-llm，不依赖 finx-core |
| finx-protocol | `McpServerConfig`；`mcp_server_status` 事件；规则新增 `tool` 字段；原生协议参数新增 `mcp_servers` |
| finx-core | 配置段 `[mcp]`、`[mcp_servers.*]` 与 `.mcp.json` 的解析、信任检查；`McpManager`；注册表在请求之间替换；审批策略放行 MCP 工具 |
| finx-server | 透传客户端带来的服务器；镜像维护服务器状态 |
| finx-acp | 解析 ACP 的 `mcpServers`；声明 `mcpCapabilities.http` |
| finx-cli | `finx mcp list/get`、`--mcp-config`；渲染服务器状态 |

依赖仍然只能自上而下：finx-mcp 处在 finx-tools 与 finx-core 之间，与内核无关，也可以单独作为 MCP 客户端库使用。

### 3.3 一次调用的流程

1. 会话启动：`Kernel::start` 拿到服务器列表，交给新建的 `McpManager`。每个服务器一个后台任务开始连接，`session_started` 照常立即发出。
2. 第一个任务的第一次模型请求之前：按需加载的服务器不等，只在目录里占一行（§7.4）；direct 服务器等它就绪或失败，最多 10 秒（§5.3），它们的工具组成 `McpTool` 进入工具列表。系统提示词补上 MCP 段，记一条 `system_prompt` 条目（§6.6）。
3. 模型先用 `tool_search` 找到 `mcp__github__create_issue` 和它的参数 schema（§7.5），再用 `call_tool` 调用它（§7.6）；direct 服务器的工具则直接调用。之后与其他工具一样预检：查到工具，发出 `tool_started`，经过钩子；内置审批策略直接放行（§9）。
4. 执行：`McpTool` 取得服务器的当前连接，发送 `tools/call`，带上原始工具名和参数。等待期间，进度转成 `tool_progress`，中断转成取消通知（§8）。
5. 结果：MCP 的内容块转成文本和图片，`isError` 转成 `is_error`。内核照常裁切、发出 `tool_completed`、写入历史。
6. 之后每次请求之前：如果某个服务器迟到就绪，或者工具列表变了，就替换工具集合再发请求（§5.4）。
7. 会话关闭：`McpManager` 关闭全部连接，结束子进程（§5.6）。

## 4. 服务器从哪里来

### 4.1 来源与优先级

| 序 | 来源 | 位置 | 作用范围 | 条件 |
|---|---|---|---|---|
| 1 | 用户配置 | `~/.finx/config.toml` 的 `[mcp_servers.<name>]` | 所有项目 | — |
| 2 | 项目的 `.mcp.json` | 项目根目录 | 本项目 | 打开了 `mcp.project_json`，并且项目受信任（默认不读，D-118） |
| 3 | 项目配置 | `<project>/.finx/config.toml` 的 `[mcp_servers.<name>]` | 本项目 | 受信任的项目 |
| 4 | 命令行 | `-c mcp_servers.<name>.<key>=<value>`、`--mcp-config <file>` | 本次运行 | — |
| 5 | 客户端 | ACP `session/new`、`session/load`、`session/resume` 的 `mcpServers`；原生协议 `session/new`、`session/resume` 的 `mcp_servers` | 本会话 | — |

- **合并**：同名时按下面的规则（D-102）：
  - 1、3、4 的 `-c` 是配置文件的三层，沿用现有的逐表合并（总方案 §10.1），后者覆盖前者，所以可以只改一个字段，例如 `-c mcp_servers.github.enabled=false`。
  - 2 只补充配置文件里没有的名字，不覆盖 1、3、4：配置文件是 finx 自己的，`.mcp.json` 属于别的工具。
  - `--mcp-config` 和 5 按整个服务器替换：给的是完整定义。
  - 被禁用（`enabled = false`）的服务器留在合并结果里，`finx mcp list` 能看到它，会话不启动它；它不做校验，因为关掉一个服务器时可能只写了这一个字段。
- **合并完成后再校验**：每个服务器必须恰好有 `command` 或 `url` 之一，名字合法（§4.3），数值在范围内。不合法的服务器不启动，给出 warning，不影响其他服务器和会话本身。
- **`--mcp-config <file>`**：读一个 `.mcp.json` 格式的文件，可以给多次，后给的覆盖先给的同名服务器。用于 CI 和脚本。
- **为什么客户端在最后**：编辑器和桌面端代表用户此刻的意图，例如 Zed 把用户在编辑器里配好的服务器带过来；与配置同名时，以它为准。
- **以后的来源**：扩展包（插件）可以带上自己的服务器，作为又一个来源在前端合并进来，内核不用改（D-101）。合并时要保证：被禁用或被拒绝的名字，不能换一个来源重新登记回来。

### 4.2 内核的入口

前端（`finx exec`、`finx chat`、服务层、ACP）用 `Workspace` 解析出配置层的服务器，再追加客户端带来的服务器，得到最终列表，放进 `KernelDeps`：

```rust
pub struct KernelDeps {
    pub llm: Arc<ModelRegistry>,
    pub tools: Arc<ToolRegistry>,       // 内置工具，与现在相同
    pub env: Arc<dyn Environment>,
    pub store: Arc<dyn SessionStore>,
    pub hooks: Vec<Arc<dyn Hooks>>,
    /// 合并、展开、校验之后的服务器，按名字排序；空表示不用 MCP
    pub mcp_servers: Vec<McpServerConfig>,
}
```

`McpServerConfig` 定义在 finx-protocol，配置文件、原生协议共用同一个形状（ACP 有自己的格式，见 §11.3）：

```rust
pub struct McpServerConfig {
    pub name: String,
    #[serde(flatten)]
    pub transport: McpTransport,
    /// deferred（默认，按需加载）或 direct（工具直接进工具列表），§7.3
    pub exposure: Option<Exposure>,
    /// 目录里的一句话说明，§7.4
    pub description: Option<String>,
    /// deferred 服务器里直接进工具列表的少数常用工具（原始名），§7.3
    pub direct_tools: Vec<String>,
    /// 只暴露这些工具（服务器上的原始名）；不写表示全部
    pub enabled_tools: Option<Vec<String>>,
    /// 去掉这些工具；在 enabled_tools 之后应用
    pub disabled_tools: Vec<String>,
    pub startup_timeout_secs: Option<u64>,   // 连接的上限，默认 30
    pub tool_timeout_secs: Option<u64>,      // 默认 300，有进度时重新计时
    /// 这个服务器的工具都可以与其他只读工具并行（没有 readOnlyHint 也一样）
    pub parallel_tools: bool,
    /// 第一次请求一定等它；它起不来时任务失败，而不是不带它继续
    pub required: bool,
}

/// 按字段区分：有 command 是 stdio，有 url 是 Streamable HTTP
pub enum McpTransport {
    Stdio {
        command: String,
        args: Vec<String>,
        /// 从 finx 的环境里原样传过去的变量名，在默认的白名单之外（§5.7）
        env_vars: Vec<String>,
        env: BTreeMap<String, String>,   // 字面值，可以写 ${VAR}
        cwd: Option<PathBuf>,            // 相对路径相对项目根目录；默认会话工作目录
    },
    Http {
        url: String,
        headers: BTreeMap<String, String>,
    },
}
```

- `enabled = false` 的服务器在合并时就去掉，不进入这个列表。
- `bearer_token_env_var`（§4.3）在解析时变成 `Authorization` 头，内核只看到 `headers`。
- `Debug` 和日志只输出名字、传输方式和 URL 的主机名，`env`、`headers` 的值一律隐去。

### 4.3 config.toml

```toml
[mcp]
enabled = true                       # 总开关；false 时不读取、不启动任何服务器
project_json = false                 # 受信任的项目里是否读取 .mcp.json（D-118）
startup_wait_secs = 10               # 第一次请求最多等 direct 服务器多久（§5.3）
exposure = "deferred"                # 默认按需加载；direct 表示工具直接进工具列表（§7.3）

[mcp_servers.everything]             # 本地服务器（stdio）
description = "Demo tools for testing MCP clients"   # 目录里的一句话说明（§7.4）
exposure = "direct"                  # 可选：这个服务器的工具直接进工具列表
command = "npx"
args = ["-y", "@modelcontextprotocol/server-everything"]
env = { LOG_LEVEL = "warn", API_TOKEN = "${EVERYTHING_TOKEN}" }
env_vars = ["NPM_CONFIG_REGISTRY"]   # 可选：在白名单之外原样传过去的变量（§5.7）
cwd = "."                            # 可选
startup_timeout_secs = 30            # 连接（启动、握手、取工具列表）的上限
tool_timeout_secs = 300              # 单次调用的超时，有进度时重新计时
enabled_tools = ["echo", "add"]      # 可选：只暴露这些
disabled_tools = []                  # 可选：去掉这些
parallel_tools = false               # 可选：这个服务器的工具都可以并行
required = false

[mcp_servers.docs]                   # 远程服务器（Streamable HTTP）
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "EXAMPLE_TOKEN"   # Authorization: Bearer $EXAMPLE_TOKEN
headers = { "X-Team" = "core" }
enabled = true

[mcp_servers.linear]                 # 二期：用 OAuth 登录的远程服务器（§13.8）
url = "https://mcp.linear.app/mcp"
auth = "oauth"                       # 省略时不做 OAuth；令牌写在 headers 或 bearer_token_env_var
transport = "streamable_http"        # 二期：或 "sse"（旧版，§13.7）；省略时按地址和探测结果

[mcp_servers.github]                 # 二期：用自己的 OAuth 应用
url = "https://api.githubcopilot.com/mcp/"
auth = "oauth"
oauth = { client_id = "Iv23li…", client_secret = "${credential:mcp.github.oauth_secret}", scopes = ["repo", "read:org"] }
```

- **服务器名**：1–32 个字母、数字、`_`、`-`。它出现在限定名里，所以限制得比工具名严。
- **环境变量展开**：`command`、`args`、`env` 的值、`cwd`、`url`、`headers` 的值里支持 `${VAR}` 和 `${VAR:-default}`。变量不存在又没有默认值时，这个服务器不启动，状态为失败，错误里给出变量名。
  - 这是为了与 `.mcp.json` 的写法一致，也让密钥不必写进配置文件。
- **未知字段**报错并指出文件和行号，与其他配置项相同。

### 4.4 信任与安全

- **未受信任的项目**：`.finx/config.toml` 里的 `[mcp_servers]` 整段去掉，`.mcp.json` 不读；warning 列出被忽略的服务器名，并提示 `finx trust`。
  - 原因：stdio 服务器在会话启动时就会执行，早于任何审批。项目里写一个服务器，等于让打开它的人执行任意命令，风险高于 allow 规则（总方案 §11.7 已经去掉 allow 规则）。
- **受信任的项目**：项目配置照常加载，不再逐个确认；`.mcp.json` 在打开 `mcp.project_json` 时加载。信任本身就是用户对这个项目的明确授权，与现有的信任语义一致。
- **模型不能悄悄加服务器**：`.mcp.json` 和 `.finx/config.toml` 都是受保护文件（总方案 §11.5），修改要经过审批。
- **客户端带来的服务器**：来自用户自己的编辑器或桌面端，连接本身已经受本机权限保护（stdio、权限为 0600 的 Unix socket），不另做检查。
- **密钥**：不写进会话日志、事件和快照。客户端带来的服务器也不写进会话日志，所以 `finx resume` 不会恢复它们（Q-106）。

### 4.5 `.mcp.json`

格式与业界通用的写法一致：

```json
{
  "mcpServers": {
    "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"], "env": {} },
    "docs": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
  }
}
```

- `type` 为 `stdio` 或省略且有 `command`：stdio；`http`（也接受 `streamable-http`）：Streamable HTTP；`sse`：旧版传输，不支持，给出 warning 后跳过。
- 不认识的字段忽略：这个文件由多个工具共用，可能带有别的工具的字段。
- 只读不写：finx 从不修改 `.mcp.json`。

## 5. 连接与生命周期

### 5.1 谁持有连接

- **每棵智能体树一个 `McpManager`**：根会话启动时创建；子智能体共用根的（§10）；根会话关闭时关闭。
- **常驻服务里每个会话各自连接**。多个会话共用同一个服务器进程能省下不少内存，但有状态的服务器（例如持有浏览器的服务器）会被多个会话同时操作，工作目录和 roots 也各不相同。先按会话隔离，共用以后再定（Q-100）。

```rust
pub struct McpManager {
    servers: Vec<Arc<ServerSlot>>,       // 按名字排序
    /// 任何服务器的工具列表或 instructions 变化时加一
    generation: AtomicU64,
    emitter: Arc<Emitter>,
}

struct ServerSlot {
    config: McpServerConfig,
    state: Mutex<ServerState>,           // 不跨 await 持有
    changed: tokio::sync::watch::Sender<u64>,
}

enum ServerState {
    Starting { since: Instant },
    Ready { client: McpClient, tools: Arc<[McpToolInfo]>, instructions: Option<String> },
    /// permanent：配置错误，不重连；否则 last_attempt 之后 30 秒才再试（D-115）
    Failed { error: String, permanent: bool, last_attempt: Instant },
    Closed,
}
```

### 5.2 启动与握手

1. `Kernel::start` 和 `Kernel::resume` 在 `mcp_servers` 非空时创建 `McpManager`，每个服务器启动一个连接任务，然后照常返回。`mcp_servers` 为空时什么也不创建。
2. 连接任务：
   - 打开传输：stdio 启动子进程；HTTP 不需要预先建立连接。
   - 发送 `initialize`：`clientInfo` 为 `{name: "finx", version}`，`capabilities` 只声明 `roots`（§5.8）；协议版本见 §13.2。
   - 收到结果后发送 `notifications/initialized`，记下服务器的 `instructions` 和能力。
   - 服务器声明了 tools 能力时，用 `tools/list` 取回全部工具，按 `nextCursor` 翻页：`nextCursor` 为空字符串或 null 表示结束，同一个游标出现两次或超过 1000 页视为服务器出错。没有声明 tools 能力的服务器不发这个请求。
   - 格式不对的单个工具（没有名字、`inputSchema` 不是对象）跳过并记 warning，不连累同一服务器的其他工具。
   - 进入 Ready，发出 `mcp_server_status { state: ready, tools }`。
3. 任何一步失败都进入 Failed，发出带原因的 `mcp_server_status`。原因里带上 stderr 的最后几行（§5.7）。
4. 开始连接时发出一次 `mcp_server_status { state: starting }`。

### 5.3 第一次请求之前的确定

- **只等有工具要直接进工具列表的服务器**：即 direct 服务器和配置了 `direct_tools` 的服务器（§7.3）。其余按需加载的服务器不进工具列表，第一次请求不需要它们的工具，所以不等；搜索或调用要用到它们时才等（§7.5、§8.1）。下面说的 direct 服务器都包括这两种。
- **时机**：会话的第一个任务（以及第一次手动压缩、`continue`）发出第一个模型请求之前，在任务里等待，而不是在 `Kernel::start` 里等。这样 `session/new` 立即返回，用户输入第一句话的时间正好用来连接。
- **两个时限**：
  - `mcp.startup_wait_secs`（默认 10 秒，从会话启动算起）：第一次请求最多等多久。所有服务器并行连接，全部就绪或失败就不再等。
  - `startup_timeout_secs`（每个服务器，默认 30 秒）：一次连接（启动进程、握手、取工具列表）最多用多久，超过算失败。本地服务器经 `npx` 启动、第一次还要下载包时，10 秒常常不够，所以这个上限要比第一次请求的等待长。
- **等不到的服务器**：不带它继续；它在后台继续连接，就绪以后按 §5.4 在下一次请求之前加入，这次替换会让缓存失效一次。
- **为什么第一次请求要等**：direct 服务器的工具直接写在请求里（§6.8），迟到的服务器每加入一次就要多一次缓存未命中；而第一次请求往往就要用到工具。交互使用时，这段等待大多藏在用户输入第一句话的时间里。
- **`required = true`**：一定等到它就绪或失败（受它自己的 `startup_timeout_secs` 约束），不受 `startup_wait_secs` 限制。失败时任务失败，错误说明是哪个服务器、为什么。
- **可以中断**：等待期间用户中断，任务照常以 interrupted 结束。
- **只等一次**：确定之后的任务不再等待，迟到的服务器就绪后在下一次请求之前加入。
- **二期去掉这段等待**：把每个服务器的工具目录缓存在本地（Q-112），之后的会话第一次请求直接用缓存的目录，服务器在后台启动，调用时才等它；按需加载的服务器还可以等到用到时才启动（§7.9）。

### 5.4 工具集合的变化

工具集合只在两次模型请求之间变化，而且只在确实变了的时候：

| 触发 | 处理 |
|---|---|
| 迟到的服务器就绪 | 它的工具加入 |
| 服务器发来 `notifications/tools/list_changed` | 重新 `tools/list`；同一个服务器一次请求间隔里最多重取一次 |
| 服务器崩溃 | 工具保留，调用返回错误（§5.5）；工具集合不变 |
| 断线后重连成功 | 工具列表与之前相同时什么也不变；不同时替换 |

- **检查点**：每次模型请求之前（轮次边界，与插话、待生效的模型切换同一处），比较 `McpManager.generation` 与当前工具集合的代数；相同就什么也不做，开销是一次原子读。
- **替换**：重建注册表的 MCP 部分、重新生成系统提示词的 MCP 段、重算固定部分的 token 估算，记一条 `system_prompt` 条目（§6.6）。
- **代价**：工具定义位于请求前缀的最前面，替换以后这一次请求的缓存全部失效，之后恢复正常。这类变化很少发生，而且都是用户或服务器主动带来的。
- **不在一个工具批次的中途替换**：一个批次里的调用都在同一个注册表里查找。

### 5.5 故障

- **启动失败**：Failed，带原因；第一次确定时把失败汇总成一条 warning。不影响其他服务器。
- **运行中崩溃**（stdio 子进程退出、HTTP 连续失败）：
  - 状态改为 Failed，发出事件；
  - 正在进行的调用立即返回错误结果，例如 `MCP server 'github' exited (status 1). Its tools are unavailable until it is reconnected.`；
  - 工具不从工具集合里删除：删掉会让请求前缀变化，模型也可能凭历史继续调用它；保留它，调用时得到明确的错误更好。
- **HTTP 会话过期**：服务器对带 `Mcp-Session-Id` 的请求回 404 时，按协议用新会话重新初始化；`tools/list` 这类只读请求在新会话上重试一次，`tools/call` 不重试（§8.2），返回错误让模型决定。
- **重连**：断开或崩溃之后不立即重启，等到下一次调用这个服务器的工具时再重连一次：
  - 重连成功就继续这次调用；工具列表变了，按 §5.4 在下一次请求之前替换；
  - 重连失败，这次调用返回错误；同一个服务器两次重连至少间隔 30 秒，期间的调用直接返回错误，不会每次都等一遍启动超时；
  - 配置错误（例如命令不存在、环境变量缺失）不重连，直到配置改了、会话重新打开。
  - 二期再提供手动的 `Op::McpReconnect { server }`（Q-103）。

### 5.6 关闭

- **时机**：根会话关闭（`Op::Shutdown`、`session/close`、空闲卸载、进程退出）时，在子智能体关闭之后。
- **stdio**：关闭子进程的 stdin，等待最多 2 秒；还没退出就向它的进程组发 SIGTERM，再等 1 秒后发 SIGKILL。
  - 子进程用独立的进程组启动。`npx`、`uvx` 这类包装命令会再派生出真正的服务器进程，只结束直接子进程会把它留下，所以信号一律发给整个进程组；直接子进程已经正常退出时，也给进程组补发一次 SIGTERM。
  - finx 自己异常退出时，句柄被释放的路径上同样结束整个进程组，不只是 `kill_on_drop` 管到的直接子进程。
- **HTTP**：有 `Mcp-Session-Id` 时发一个 DELETE，最多等 1 秒，失败忽略。
- 关闭完成后发出 `mcp_server_status { state: closed }`。

### 5.7 stdio 子进程

- **命令**：按 `PATH` 查找 `command`，传入 `args`，不经过 shell。
- **环境**：从空环境开始，依次加入：
  1. 白名单里的变量（存在时）：
     - 基本：`HOME`、`USER`、`LOGNAME`、`SHELL`、`PATH`、`TMPDIR`、`TERM`、`LANG`、`LC_ALL`、`LC_CTYPE`、`TZ`、`XDG_*`，macOS 上加 `__CF_USER_TEXT_ENCODING`；
     - 代理：`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及其小写形式；
     - 证书：`SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_EXTRA_CA_CERTS`、`REQUESTS_CA_BUNDLE`；
  2. `env_vars` 列出的变量，原样传过去；
  3. `env` 里的值（展开 `${VAR}` 之后）。
  - **理由**：stdio 服务器在会话启动时就运行，没有任何审批；它们往往是运行时才下载的第三方包（`npx -y`）。环境变量里常有密钥，CI 里尤其如此，不应该默认交给每一个服务器。bash 不同：它的每条命令都经过权限判断，而且需要和用户的终端一样的环境。
  - 需要令牌的服务器照惯例在 `env` 里写明，例如 `GITHUB_TOKEN = "${GITHUB_TOKEN}"`；`.mcp.json` 的通行写法本来就是这样。
- **工作目录**：`cwd`，默认会话的工作目录。
- **stdout**：只承载 MCP 消息，按行分帧（finx-rpc）。不是 JSON 的行记入日志后丢弃。
- **stderr**：必须一直读：管道写满以后，服务器会卡在写 stderr 上。逐行写入运行日志（目标 `finx_mcp::stderr`，带服务器名），同时保留最后 8 KB，用于启动失败或崩溃时的错误说明。不发给界面。
- **文件描述符**：子进程只继承 stdin、stdout、stderr，不继承 finx 打开的其他文件（会话日志、socket）。

### 5.8 roots

- `initialize` 声明 `roots` 能力，`listChanged` 为 false：会话的工作区根目录在会话期间不变。
- 服务器请求 `roots/list` 时，返回会话的工作区根目录（项目根目录和额外根目录），格式为 `file://` URI。文件系统类的服务器会据此限制自己能访问的范围。

## 6. 注册：MCP 工具变成内核工具

### 6.1 `McpTool`

```rust
pub struct McpTool {
    spec: ToolSpec,             // 限定名、描述、修正后的 schema
    server: Arc<ServerSlot>,    // 调用时取当前连接，重连之后同一个对象继续可用
    tool: String,               // 服务器上的原始工具名
    title: String,              // 显示用
    parallel: bool,             // annotations.readOnlyHint，或服务器配置了 parallel_tools
    timeout: Duration,
}

impl Tool for McpTool {
    fn spec(&self) -> &ToolSpec { &self.spec }
    fn kind(&self) -> ToolKind { if self.parallel { ToolKind::ReadOnly } else { ToolKind::Mutating } }
    fn origin(&self) -> ToolOrigin { ToolOrigin::Mcp { server: ... } }
    fn describe(&self, _args: &Value, _env: &dyn Environment) -> ToolDescription { ... }  // §11.2
    async fn execute(&self, args: Value, ctx: ToolCtx) -> Result<ToolOutput, ToolError> { ... } // §8
}
```

- `Tool` 接口新增 `fn origin(&self) -> ToolOrigin`，默认 `Builtin`。审批策略据此放行 MCP 工具（§9.1），以后加审批也只看它；界面也可以据此显示来源。
- `kind` 只决定并发：标了 `readOnlyHint` 的工具，以及配置了 `parallel_tools = true` 的服务器的全部工具，与其他只读工具并行；其余的独占执行（总方案 §5.4）。审批不看 `kind`（§9.1）。

### 6.2 限定名

`mcp__<server>__<tool>`，算法：

1. 服务器名和工具名里不属于字母、数字、`_` 的字符都换成 `_`，`-` 也换。
   - 厂商允许 `-`，但以后如果让模型在脚本里调用工具，名字要能直接当标识符用；现在就换掉，以后不必改名，历史和缓存都不受影响。
   - 两个服务器名替换后相同（例如 `my-server` 和 `my_server`）时，后加入的那个不启动，给出 warning。ACP 带来的名字可能含空格等字符，同样先替换，重名时加 `_2`、`_3`。
2. 拼成 `mcp__<server>__<tool>`。不超过 64 个字符就用它。
3. 超过 64 个字符：保留前 55 个字符，加上 `_` 和哈希后缀，共 64 个字符。哈希后缀是原始服务器名与原始工具名（中间用 `\0` 隔开）的 64 位 FNV-1a 哈希的前 8 位十六进制。FNV-1a 几行代码就能实现，不引入新依赖；标准库的 `DefaultHasher` 不保证跨版本稳定，不能用。
4. 与本会话已有的名字冲突（两个原始名替换字符后相同，例如 `get-issue` 和 `get_issue`）：冲突的每一个都加哈希后缀，而不是只给后来的那个加。这样结果与服务器返回工具的顺序无关。
- **稳定**：同样的服务器名和工具名，每次得到同样的限定名。重启、恢复会话之后名字不变，历史里的调用和请求前缀都对得上。
- **不解析**：路由靠注册表查表，不需要从名字里拆出服务器和工具，所以服务器名或工具名里有 `__` 也没有关系。
- `mcp__` 前缀保证不会与内置工具、智能体工具重名。

### 6.3 描述

- 用服务器给的 `description`；没有时用 `title`，再没有就用工具名。
- 去掉首尾空白；超过 4 KB 的截断并加 `…`。个别服务器的描述非常长，每个请求都要带上。

### 6.4 参数 schema

只做与模型厂商无关的修正：

| 情况 | 处理 |
|---|---|
| 顶层缺少 `type` | 补 `"type": "object"` |
| 顶层缺少 `properties` | 补 `"properties": {}`，有的厂商拒绝没有 properties 的对象 |
| `$schema`、`$id` | 去掉 |
| 子 schema 写成布尔值 `true` | 换成 `{}` |
| 没有被任何 `$ref` 引用的 `$defs`、`definitions` 条目 | 去掉：每次请求都要为它们付 token |
| 顶层 `type` 不是 object，或者 schema 不是 JSON 对象 | 这个工具不注册，给出 warning |
| 其他关键字（`$ref`、`anyOf`、`const`、`format`、`pattern` 等） | 原样保留 |

- **一个坏 schema 会让每次请求都失败**：厂商拒绝请求里的任何一个工具定义，整个请求就失败，而工具定义每次都带着，于是这个会话每次请求都会失败。所以：
  - 修不好的 schema 不注册，而不是带病发出去；
  - 一期用 DeepSeek 的两种线协议实测常见服务器（server-everything、filesystem、GitHub、Playwright）的 schema；
  - 某个厂商拒绝某种写法时（例如不接受 `$ref` 或 `const`），在它的适配器里按 Compat 标志转换（总方案 §4.7）。这样内置工具和 MCP 工具在同一处适配，MCP 层不需要知道厂商。
- **不压缩 schema**：一期不为节省 token 改写服务器给的 schema（例如去掉描述、展开引用）。token 的问题由按需加载解决（§7）。
- **不在本地校验参数**：服务器自己校验，校验失败时它返回的错误原样交给模型。
- `outputSchema`、注解、`title` 不发给模型；结构化结果按 §8.4 转成文本。

### 6.5 顺序与过滤

- **过滤**：先按 `enabled_tools` 保留，再按 `disabled_tools` 去掉，都按服务器上的原始名匹配。
- **只给界面用的工具不注册**：工具的 `_meta.ui.visibility` 存在、却不包含 `model` 时，它是给界面应用调用的，不交给模型。
- **顺序**：内置工具（按 `tools.enabled`）→ 智能体工具（只有根会话有）→ `tool_search`、`call_tool`（有 deferred 服务器时）→ direct 服务器的 MCP 工具：服务器按名字排序，每个服务器内按原始工具名排序。
  - 排序而不是沿用服务器的返回顺序：有的服务器每次返回的顺序不同，排序后同样的工具集合总是得到同样的请求前缀。

### 6.6 系统提示词

- MCP 段放在系统提示词的最后，由两部分组成：deferred 服务器的目录 `<mcp_servers>`（§7.4），以及 direct 服务器的 instructions。deferred 服务器的 instructions 不在这里，在搜索结果里给出（§7.5）。
- direct 服务器在 `initialize` 结果里给了 `instructions` 时，每个服务器一个标签：

```
<mcp_instructions server="github">
...服务器给的原文...
</mcp_instructions>
```

- 每个服务器最多 16 KB，超出截断并给出 warning；没有给的服务器不加任何文字。上限不能太小：真实服务器的说明常有数 KB，截得太短会丢掉关键的用法。
- finx 自己不为 MCP 添加任何说明：工具的名字、描述、schema 已经足够模型使用。
- **与冻结的基础提示词分开存**：会话启动时生成的系统提示词（总方案 §7.2）保持冻结，恢复会话时照旧沿用；MCP 段单独存放，实际发送的系统提示词是"基础提示词 + 空行 + MCP 段"，MCP 段放在最后。
  - `system_prompt` 条目新增可选字段 `mcp`：`{ text, tools, mcp? }`。`text` 仍然是基础提示词，`mcp` 是 MCP 段，没有时省略。旧日志没有这个字段，读法不变。
  - 恢复会话时，基础提示词取最后一条的 `text`；MCP 段等这次连接确定之后重新生成，与日志里的相同就不再记一条。
  - 这样 MCP 段的变化不会让基础提示词被重新生成，项目指令文件在会话中途改了也不会混进来。
- 工具集合第一次确定、以后每次替换时，MCP 段或工具列表变了才记一条 `system_prompt` 条目，`tools` 列出全部限定名。
- 第一次确定发生在第一次请求之前，没有缓存损失。

### 6.7 注册表的替换

- `Session.tools` 从固定的 `Arc<ToolRegistry>` 改为放在会话状态里的 `Arc<ToolRegistry>`，读取时克隆 `Arc`。工具批次在开始时取一次，整个批次用同一个。
- `fixed_tokens` 从 `OnceLock` 改为随工具集合的代数缓存。
- 内置工具和智能体工具部分保持不变，只有 MCP 部分重建。

### 6.8 工具太多时

- 本章说的是工具直接进工具列表（direct）时的做法。MCP 工具默认不这样暴露，而是按需加载（§7）。
- direct 服务器的工具定义每次请求都要带上。工具集合确定或替换后，如果 direct 的 MCP 工具定义估算超过可用窗口的 10%，发出 warning，建议改回按需加载或用 `enabled_tools` 精简。上下文用量里本来就包含这部分（总方案 §7.5）。

## 7. 渐进式加载

### 7.1 问题

- 一个工具的定义（名字、描述、参数 schema）通常要几百个 token，一个连接器常有几十到上百个工具。公开的测算里，5 个常用服务器、58 个工具的定义就要约 5.5 万 token；接上百个连接器能把窗口占满。
- 这些定义每次请求都要带上：即使命中缓存也一直占着窗口，压缩来得更早。
- 工具一多，模型也更容易选错：公开的经验是工具超过三五十个之后，选择的准确率明显下降；按需加载之后，同样的评测里准确率反而上升。
- 因此 MCP 工具默认不放进工具列表，而是分层、按需展开。思路与 Skill 的渐进式披露相同：先只给目录，用到时再给细节。

### 7.2 三层

| 层 | 模型看到什么 | 放在哪里 | 什么时候 |
|---|---|---|---|
| 目录 | 每个服务器一行：名字和一句话说明 | 系统提示词最后的 `<mcp_servers>` 段 | 一直在，会话内不变 |
| 定义 | 匹配工具的限定名、描述和参数 schema；服务器第一次出现时附上它的 instructions | `tool_search` 的结果，进入历史 | 模型要用时 |
| 调用 | 执行这个工具 | `call_tool`；厂商原生支持时直接调用（§7.7） | 模型要用时 |

### 7.3 暴露方式

- 每个服务器二选一：
  - `deferred`（默认）：工具不进工具列表，服务器只在目录里占一行；
  - `direct`：工具直接进工具列表（§6），instructions 放进 MCP 段（§6.6）。适合工具很少、几乎每次都用的服务器。
- 全局默认 `mcp.exposure = "deferred"`，单个服务器用 `exposure = "direct"` 覆盖。
- **常用工具常驻**：deferred 服务器可以用 `direct_tools = ["search_code"]`（原始工具名）让少数最常用的工具直接进工具列表，其余照旧按需加载。一般三到五个就够；工具不到十个的服务器，整体设为 direct 更省事，省掉每次先搜索的那一轮。这些工具要随第一次请求发送，所以配置了 `direct_tools` 的服务器也按 §5.3 等它连上。
- **不按工具数量自动切换**：
  - 按数量切换，就得在第一次请求之前连上所有服务器、拿到全部工具列表才能决定，等待省不掉；
  - 模型的行为也会随装了几个服务器而变：同样的任务，这次直接调用，下次要先搜索。
- 只要有一个 deferred 服务器，工具列表里就固定加上 `tool_search` 和 `call_tool` 两个工具；全部是 direct 时不加。

### 7.4 目录

```
<mcp_servers>
Tools of these MCP servers are not in your tool list. Find them with tool_search, then run them with call_tool.
- github: Issues, pull requests and code search on GitHub
- docs: Internal API documentation
</mcp_servers>
```

- **一句话说明的来源**：配置里的 `description`（新增配置项）；二期起，没有配置时取工具目录缓存里服务器 instructions 的第一行（Q-112）；都没有就只写名字。每个服务器最多 250 个字符。
- **整段最多 4 KB**：先保证每个服务器的名字都在，剩下的空间由各服务器的说明平均分；连名字都放不下时，末尾写 `- … and N more servers; tool_search finds their tools too.`。上百个连接器也只占一千来个 token。
- **只依赖配置，不依赖连接**：deferred 服务器不用连上就能列进目录。所以第一次请求不必等它们（§5.3 的等待只针对 direct 服务器），目录从第一次请求起就固定，请求前缀稳定。
- **会话中途不改**：服务器连上以后拿到的 instructions 不回填目录，改在搜索结果里给出（§7.5）。改目录就要改系统提示词，缓存会失效一次。

### 7.5 tool_search

| 参数 | 说明 |
|---|---|
| `query` | 关键词。其中每个完整的限定名（或限定名里服务器名之后的部分）都算精确匹配，排在最前面；一次可以写几个名字，同时取回它们的定义 |
| `server` | 可选，只在这个服务器里找。只给 `server`、不给 `query` 时，列出这个服务器的 instructions 和它的工具（每个一行：名字和描述的第一句），不带 schema；超过 100 个时只列名字（去掉共同的 `mcp__<server>__` 前缀，逗号分隔），提示用完整名字或 `query` 取定义（D-124） |
| `limit` | 可选，默认 5，最多 20 |

结果是按服务器分组的纯文本：每个工具一行限定名和描述，下一行是它的参数 schema（紧凑 JSON）。

- **排序**：BM25。字段为限定名、原始工具名（按 `_`、`-`、大小写拆词）、标题、描述、参数名和参数描述。只搜按需加载的工具；已经在工具列表里的（direct 服务器的、`direct_tools` 列出的）不在其中。
- **索引**：每个服务器的工具列表变化时（就绪、`list_changed`、重连）重建这个服务器的那部分，其余时候复用，搜索本身只是一次内存里的打分。
- **服务器的 instructions**：服务器第一次出现在本会话的搜索结果里时附上，最多 16 KB。
- **不重复给定义**：自上次压缩以来已经给过定义的工具，只列名字并注明定义见前文。压缩之后重新计算；恢复会话后从零开始，最多重复一次。
- **还在连接的服务器**：搜索先等它们，最多 10 秒（与 §5.3 同一个上限）。仍未就绪或已经失败的，在结果末尾列出名字和原因。
- **没有匹配**：说明没找到，并列出全部 deferred 服务器的名字，提示换个说法或者指定 `server`。
- **参数不对**（例如 `query` 和 `server` 都没给）时返回说明原因的错误结果，而不是空结果。
- 结果照常裁切（D-36）。

### 7.6 call_tool

| 参数 | 说明 |
|---|---|
| `name` | 工具的限定名 |
| `arguments` | 对象，按这个工具的参数 schema 填写 |

- **执行**：按限定名查到 MCP 工具，按 §8 执行，结果原样返回。不要求先搜索：模型已经从历史里知道名字和参数时可以直接调用。
- **参数整理**：`arguments` 以 JSON 字符串发来时先解析成对象，与内置工具整理参数的做法相同（总方案的 `prepare_arguments`）。
- **名字不存在**：先等还在连接的服务器（与搜索同一个上限，例如恢复会话后模型直接调用历史里的工具），仍然没有时返回 `Unknown MCP tool '<name>'. Use tool_search to find tools.`。
- **显示**：`tool_started` 的 title 是 `<server>: <tool>`，界面上看到的是目标工具，不是 call_tool。
- **并发跟随目标工具**：只读的可以并行。为此 `Tool` 接口新增 `kind_for(args)`，默认返回 `kind()`；call_tool 按参数里的工具名返回目标工具的 kind。
- **为什么需要 call_tool**：
  - openai-chat 线协议（DeepSeek 用的就是它）没有在对话中途增加工具的办法。要让模型直接调用搜到的工具，只能把它加进工具列表再整个重发；工具定义在请求的最前面，每加载一次，整个前缀的缓存就失效一次。
  - 经 call_tool 调用，工具列表和系统提示词在整个会话里都不变，搜到的定义只追加在历史里。MCP 官方的客户端实践指南为保住提示缓存给出的两种做法之一，就是所有调用都经一个固定的 `call_tool` 走。
  - 代价：参数不受厂商一侧按 schema 约束的解码，由服务器在执行时校验。finx 本来就不用严格模式，影响不大。

### 7.7 厂商原生支持时（三期）

- 有的厂商支持在对话中途声明工具、而不改动请求前缀，搜到的工具在对话里正式声明，模型可以直接调用，缓存也不受影响：
  - Anthropic：工具定义随请求发送但标为 `defer_loading`，不进上下文；自己实现的搜索工具在结果里返回 `tool_reference`，由厂商展开成完整定义（4.5 代及以后的模型）。较新的模型还能用对话中途的系统消息直接加入工具定义；
  - OpenAI Responses：`tool_search`（由客户端执行）加上 `defer_loading` 和 namespace（GPT-5.4 及以后），或者 `additional_tools`；
  - DeepSeek：两种端点都没有。它的 Anthropic 兼容端点只认工具的名字、描述和 schema，`defer_loading`、`tool_reference` 都会被忽略；它的 Responses 接口也没有 tool_search。
- 适配器声明支持时，tool_search 的结果在请求里换成厂商的原生格式，模型直接调用搜到的工具，不必经过 call_tool。三层结构不变，只是第三层换了实现，改动都在 finx-llm 的适配器里（按 Compat 标志）。
- 一期的两个适配器接的都是 DeepSeek，只能走通用做法；原生做法随 openai-responses 适配器和 Anthropic 官方端点的实测再加（Q-117）。
- 厂商拒绝原生字段时（例如某个代理不认 `defer_loading`），适配器退回通用做法，而不是让请求失败。

### 7.8 与其他机制的关系

- **缓存**：工具列表和系统提示词在整个会话里不变，目录也不随连接状态变化；搜索结果和调用只追加到历史。
- **第一次请求**：§5.3 的等待只针对 direct 服务器。只有 deferred 服务器时不等，第一次请求立即发出。
- **工具列表变化**（`list_changed`）：deferred 服务器只更新搜索索引，不改动请求；direct 服务器按 §5.4。
- **压缩**：搜到的定义在压缩之后不在上下文里，模型需要时再搜一次；"已经给过定义"的记录随之清空。
- **恢复会话**：历史原样沿用，call_tool 照常可用。
- **子智能体**：拿到父的全部工具，包括 tool_search 和 call_tool，目录也相同。

### 7.9 上百个连接器（二期）

- **按需启动**：有工具目录缓存的 deferred 服务器在会话开始时不启动，第一次搜索或调用要用到它时才连接；搜索直接用缓存的目录。接 100 个本地服务器，启动时也不会拉起 100 个进程。
- **第一次用的服务器**没有缓存，仍在会话开始时连接，取回工具列表后写入缓存。
- **远程（HTTP）服务器**没有进程开销，照常在开始时连接。

### 7.10 以后再考虑

- **让模型写脚本调用工具**（Q-116）：模型写一段程序，在沙箱里批量调用、过滤、组合工具结果，只有脚本的输出回到上下文。它最省 token，工具列表也完全不变；但需要内置一个沙箱化的脚本运行时，模型还得写对代码。等通用做法跑起来、看到瓶颈再定。

## 8. 调用

### 8.1 流程

`McpTool::execute(args, ctx)`：

1. 取服务器的当前状态。正在连接时等它（受 `startup_timeout_secs` 约束）；断开或失败时按 D-115 重连一次；仍然不可用就返回错误结果，说明服务器的状态和原因。
2. 确认这个工具还在服务器的当前工具列表里。服务器的列表可能已经变了，而工具集合要到下一次请求之前才替换（§5.4）；不在了就返回 `The MCP tool '<name>' is no longer offered by server '<server>'.`。
3. 参数为 null 或缺省时按空对象 `{}` 发送；是数组、字符串之类的非对象时返回错误结果，不发给服务器。
4. 发送 `tools/call`：`{ name: <原始工具名>, arguments, _meta: { progressToken: <这次请求的 id> } }`。用请求 id 而不是 call_id：根会话和子智能体共用一个连接，各自的 call_id 可能相同，请求 id 在连接内唯一。
5. 等待响应，同时监听取消和超时（§8.2）。
6. 把结果转成 `ToolOutput`（§8.4）。

之后的事情与所有工具相同：`after_tool` 钩子、`cap_result` 裁切并保存完整内容、`tool_completed` 事件、写入历史。

### 8.2 超时、取消与进度

- **超时**：`tool_timeout_secs`，默认 300 秒。
  - 比 bash 的 120 秒长：MCP 工具常常代替用户做一整件事（跑一组浏览器操作、等一次构建），一两分钟内做不完很常见，而且很多服务器不报进度。
  - 服务器每报一次进度，超时重新计时：还在报进度的长任务不会被误杀。
  - 超时后发送 `notifications/cancelled`，返回错误结果 `MCP tool timed out after 300 s without progress.`。用户随时可以中断。
- **不重试**：`tools/call` 失败（包括连接中断）时不自动重发，避免有副作用的操作执行两次。
- **取消**：用户中断时（`ctx.cancel`），发送 `notifications/cancelled { requestId, reason: "interrupted by the user" }`，不再等待响应，返回 `ToolError::Cancelled`（结果为 "Cancelled by user."，与其他工具相同）。之后到达的响应丢弃。
- **进度**：服务器发来 `notifications/progress` 时，`message` 存在就转发它，否则转发 `progress/total`，经 `ToolProgress` 发出。ACP 投影已有的合并间隔照常生效。

### 8.3 错误

| 情况 | 返回给模型 |
|---|---|
| 结果里 `isError: true` | 结果内容，`is_error = true` |
| JSON-RPC 错误（参数不对、工具不存在等） | `MCP error <code>: <message>`，`is_error = true` |
| 服务器不可用 | 状态和原因，`is_error = true`（§5.5） |
| 结果无法解析 | `The MCP server returned an invalid result: <简述>`，`is_error = true` |

### 8.4 结果转换

| MCP 内容 | 给模型的内容 |
|---|---|
| `text` | 文本 |
| `image` | 图片 |
| `audio` | 保存成文件，给出说明：`[Audio (audio/wav, 120 KB) saved to <path>.]` |
| `resource_link` | `[Resource: <name> <uri> (<mimeType>)]` |
| `resource`，带 `text` | 文本，前面一行 `Resource <uri>:` |
| `resource`，带 `blob`，图片类型 | 图片 |
| `resource`，带 `blob`，文本类型（`text/*`、JSON、XML） | 按 UTF-8 解码成文本 |
| `resource`，带 `blob`，其他类型 | 保存成文件：`[Binary resource <uri> (<mimeType>, 2 MB) saved to <path>.]` |
| 未知类型 | `[Unsupported content type '<type>' omitted.]` |
| 没有内容但有 `structuredContent` | 它的 JSON 文本 |
| 有内容也有 `structuredContent` | 只用内容（协议要求服务器同时给出序列化后的文本） |
| 什么都没有 | `(no output)` |

- **模型拿不了的内容存成文件**：音频、非文本的二进制资源，以及当前模型不接收的图片和超过 5 MB（与 read 相同）的图片，都保存到会话数据目录的 `tool-output/` 下，结果里给出路径，模型可以用 bash 处理。与裁切后的完整输出放在同一处（总方案 §9.1）。
- **错误一定带文字**：`isError` 为 true 却没有文本时，补一行 `The MCP tool reported an error without a message.`。openai-chat 线协议的工具结果没有错误标记，模型只能从文字里看出这是错误。
- `details` 写 `{ "server": ..., "tool": ... }`，供界面显示；不放结构化结果，避免每个结果在历史里多存一份。
- 裁切交给内核：超过限制时保留首尾、保存完整内容，模型可以用 read 取回（总方案 §5.7、D-36）。

## 9. 权限

### 9.1 一期不审批

- **MCP 工具在所有权限模式下直接运行**：不询问，也不受命令规则约束。
- **实现**：内置审批策略遇到 `origin()` 为 MCP 的工具直接放行。`before_tool` 钩子链照常执行，所以以后的外部命令钩子仍然可以拦截 MCP 调用。
- **子智能体和非交互运行照常可用**：子智能体不发起审批、`finx exec` 没有审批通道，这两处都不会因为"没人能审批"而拒绝 MCP 调用。
- **代价**：模型可以不经确认调用任何已配置服务器的任何工具，包括有副作用的（发消息、改远程数据）。约束只剩三处：
  - 用户配置了哪些服务器；
  - 暴露了哪些工具（`enabled_tools`、`disabled_tools`）；
  - 项目里的服务器需要信任（§4.4）。
- `readOnlyHint` 和 `parallel_tools` 只决定并发（§6.1），与权限无关。

### 9.2 以后需要审批时

一期不做，只保证以后加上时内核的其他部分不用改：`Tool::origin()` 已经能区分 MCP 工具，审批只需要改 `approval.rs`。届时的候选做法：

- 规则新增 `tool` 字段，按工具名 allow、ask、deny，例如 `tool = "mcp__github__*"`；
- "本会话总是允许"只放行被问到的这一个工具（与 D-34 的窄授权一致）；
- 是否按注解免审批：标了只读的不问，标了破坏性的总问（Q-110）；
- 跨会话的"以后都不再问"，与 bash 的三档审批一并决定（Q-111）。

## 10. 子智能体

- **工具**：子智能体拿到父的全部工具，只去掉两个智能体工具 `spawn_agent` 和 `send_message`，顺序与父相同。MCP 工具、以后新增的工具都自动继承，不维护白名单。
  - 子智能体方案 D-42 的"父的基础工具"按这个意思理解；它的方案摘要里"只有 read、write、edit、bash"一句，届时改成"父的全部工具，去掉两个智能体工具"。
- **连接**：子智能体使用根会话的 `McpManager`，不再启动自己的服务器进程。`McpTool` 只持有服务器槽位，同一个连接可以同时处理多个会话的请求（JSON-RPC 按 id 对应响应）。
  - 好处：子智能体创建时不用等服务器启动，进程数也不会随子智能体的数量成倍增加（每个 `npx` 启动的服务器要占几十到上百 MB 内存）。
  - 代价：有状态的服务器（例如持有一个浏览器的服务器）会被根和子同时操作。大多数服务器是无状态的请求与应答，先共用；真遇到问题，再给服务器加"每个会话一份"的选项（Q-114）。
- **确定与变化**：子智能体由运行中的任务创建，这时根会话已经确定过，不需要再等。工具集合的变化在子智能体自己的请求之间生效，规则与 §5.4 相同。
- **关闭**：根会话关闭时，先关子智能体，再关 `McpManager`。

## 11. 对外协议

### 11.1 事件

```rust
EventMsg::McpServerStatus {
    server: String,
    state: McpServerState,            // starting | ready | failed | closed
    /// 就绪时注册的工具数（过滤之后）
    #[serde(default)]
    tools: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// 从开始连接到这个状态用了多久
    #[serde(default, skip_serializing_if = "Option::is_none")]
    elapsed_ms: Option<u64>,
}
```

- 服务层的会话镜像记录每个服务器的最新状态，快照新增 `mcp_servers: Vec<McpServerInfo>`（名字、状态、工具数、错误），中途接入的客户端也能看到。
- 第一次确定时（§5.3）仍然有失败的服务器，或者还在连接的 direct 服务器，另外发一条 warning 汇总，`code` 为 `mcp_servers_not_ready`（D-125）：不支持 MCP 状态的客户端（例如 ACP）也能看到；显示服务器状态的客户端（命令行、桌面端）按 code 不重复显示。

### 11.2 工具调用的显示

- `tool_started` 的 `category` 为 `other`，`title` 为 `<server>: <工具的 title 或原始名>`，没有 `locations`。
- 历史和日志里，MCP 调用就是普通的工具调用和工具结果，格式不变。
- 恢复会话时服务器重新连接，历史原样沿用，不做对账。历史里调用过、现在已经没有的工具，模型再调用时得到"未知工具"的错误结果（总方案 §5.9）。

### 11.3 ACP

- `initialize` 回复 `mcpCapabilities: { http: true, sse: false }`。
- `session/new`、`session/load`、`session/resume` 的 `mcpServers` 换成 `McpServerConfig`，作为第 5 层来源（§4.1）：

| ACP 格式 | finx |
|---|---|
| `{ name, command, args, env: [{name, value}] }` | Stdio，`env` 转成表 |
| `{ type: "http", name, url, headers: [{name, value}] }` | Http，`headers` 转成表 |
| `{ type: "sse", ... }` | 不支持：跳过，在客户端支持 notice 时发一条 |
| `{ type: "acp", ... }`（不稳定扩展，MCP 消息走 ACP 连接） | 一期不支持，处理同 sse（Q-109） |

- 跳过的服务器各记一条日志；客户端支持 notice 时，在 `session/new`（或 load、resume）的回复之后各发一条 notice。
- `session/load`、`session/resume` 指向已经加载的会话时，忽略带来的 `mcpServers`：会话沿用已经启动的服务器。
- ACP 没有 MCP 状态的更新类型。失败通过 warning 汇总（§11.1），在客户端支持 notice 时以 notice 发出。

### 11.4 原生协议

- `session/new` 和 `session/resume` 新增可选参数 `mcp_servers: Vec<McpServerConfig>`，作为第 5 层来源。
  - `session/resume` 指向一个已经加载的会话时，与其他覆盖参数一样不允许带它（协议方案 §6.4）。
- `mcp_server_status` 是普通的会话事件，经 `session/event` 送达；事件过滤器可以选择接收或不接收。
- 一期不提供列出工具、增删服务器的方法；桌面端怎么管理服务器，随桌面端的设计再定（Q-107）。

## 12. 配置与命令行

### 12.1 配置项

见 §4.3。全部新增项：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `mcp.enabled` | true | 总开关 |
| `mcp.project_json` | false | 受信任的项目里是否读取 `.mcp.json`（D-118） |
| `mcp.startup_wait_secs` | 10 | 第一次请求最多等 direct 服务器多久（§5.3） |
| `mcp.exposure` | deferred | 默认的暴露方式：deferred 按需加载，direct 直接进工具列表（§7.3） |
| `mcp_servers.<name>.exposure` | 同 `mcp.exposure` | 单个服务器的暴露方式 |
| `mcp_servers.<name>.description` | — | 目录里的一句话说明（§7.4） |
| `mcp_servers.<name>.direct_tools` | 无 | deferred 服务器里直接进工具列表的常用工具（§7.3） |
| `mcp_servers.<name>.command` / `args` / `env` / `env_vars` / `cwd` | — | stdio 服务器（§5.7） |
| `mcp_servers.<name>.url` / `headers` / `bearer_token_env_var` | — | 远程服务器 |
| `mcp_servers.<name>.transport` | 按地址 | 二期：`streamable_http` 或 `sse`；省略时地址以 `/sse` 结尾为 `sse`，否则 `streamable_http`（§13.7） |
| `mcp_servers.<name>.auth` | 不做 OAuth | 二期：`oauth` 表示用 OAuth 登录（§13.8）；令牌方式不需要这一项，写在 `headers` 里 |
| `mcp_servers.<name>.oauth` | — | 二期：自己的 OAuth 应用：`client_id`、`client_secret`（写凭据引用）、`scopes` |
| `mcp.client_metadata_url` | finx 公布的地址 | 二期：客户端元数据文档的地址，只给自建分支和测试改用（§13.8.3） |
| `mcp_servers.<name>.enabled` | true | |
| `mcp_servers.<name>.startup_timeout_secs` | 30 | 一次连接的上限 |
| `mcp_servers.<name>.tool_timeout_secs` | 300 | 单次调用的超时，有进度时重新计时 |
| `mcp_servers.<name>.enabled_tools` / `disabled_tools` | 全部 / 无 | 工具过滤 |
| `mcp_servers.<name>.parallel_tools` | false | 这个服务器的工具都可以并行（§6.1） |
| `mcp_servers.<name>.required` | false | §5.3 |

### 12.2 命令行

| 命令 | 说明 |
|---|---|
| `finx mcp list [--json]` | 合并后的服务器：名字、传输方式、暴露方式（禁用的显示 disabled）、命令行或去掉查询串的 URL、来源（`user config`、`project config`、`-c`、`.mcp.json`、`--mcp-config <file>`）。不连接 |
| `finx mcp list --check` | 同时连接所有启用的服务器，列出状态、耗时和工具的限定名，然后断开；有服务器连不上时退出码为 1 |
| `finx mcp get <name> [--json]` | 一个服务器的完整定义和它的来源；`env`、`headers` 的值隐去，只有恰好是一个 `${VAR}` 引用的值照常显示 |
| `--mcp-config <file>` | 全局参数，所有命令都接受（§4.1）；`chat` 不带工具，忽略它 |
| `finx status` | 增加一行：会话会启动的服务器个数和名字 |

- `finx exec` 和 `finx resume` 在终端显示服务器状态，例如 `mcp: github ready (12 tools, 640 ms)`、`mcp: docs failed: connection refused`；回复正在输出一行时，状态行等这一行结束再显示，不把回复拆开；`--output stream-json` 时作为事件输出。
- `finx mcp add/remove` 放到二期：要在保留注释和格式的前提下修改 config.toml，需要引入 toml_edit。
- **二期**：
  - `finx mcp add` 先探测（§13.6），通过了才写配置；失败时退出码为 1，不写任何文件，加 `--force` 才在失败时照样写入。远程服务器探测到要 OAuth 时，写入前先登录（同 `finx mcp login`）；`--no-login` 只写配置、以后再登录。
  - `finx mcp login <name>`：在终端打印授权链接并尝试打开浏览器，在本机回调上等待，最多 5 分钟。
  - `finx mcp logout <name>`：服务器支持撤销就先撤销，再删除钥匙串里的令牌。

## 13. 客户端实现（finx-mcp）

### 13.1 为什么自研

- **客户端要做的事很少**：初始化、翻页取工具列表、调用、取消、进度、ping，加上应答 `roots/list`。按行分帧的 JSON-RPC 已经有 finx-rpc，HTTP 和 SSE 已经有 finx-llm。
- **与 D-28 一致**：ACP 用本地最小类型，官方 schema crate 只作测试依赖。MCP 同样只定义要用到的类型，官方 Rust SDK 只用作测试里的对照服务器和一致性校验。
- **少一层转换**：工具结果直接从 JSON 解析成 finx 的内容类型，不经过 SDK 的中间类型。
- **SDK 也要包一层**：要控制进程组的清理、请求的发送顺序、连接关闭的通知、HTTP 走 finx 自己的客户端，SDK 的默认行为都得改；它的版本又跟着协议频繁变化。包装和跟版本的成本，不比自己实现客户端需要的这一小部分低。
- **代价**：OAuth 和新版协议（Q-113）要自己实现，这是工作量最大的两块。二期做 OAuth 时，如果自己实现的成本明显过高，再评估只引入 SDK 的鉴权部分。

### 13.2 协议版本

- `initialize` 给出 `2025-11-25`；服务器回复它支持的版本，finx 接受 2025-11-25、2025-06-18、2025-03-26、2024-11-05，其余报错并断开。
- HTTP 传输在初始化之后的每个请求带 `MCP-Protocol-Version` 头。
- 不用 JSON-RPC 批量消息。
- **2026-07-28 版本**：这一版用 `server/discover` 代替 `initialize` 握手，调用中途需要用户输入时由调用结果带回（多轮调用），而不是由服务器另发请求。它让一个服务器进程同时服务多个会话成为可能（Q-100），但目前支持它的服务器还很少。一期不实现，见 Q-113。

### 13.3 类型

只定义用到的字段，其余忽略：

```rust
pub struct ToolInfo {             // tools/list 的一项
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub input_schema: Value,
    pub annotations: Option<ToolAnnotations>,   // 只读 readOnlyHint；其余注解一期不用
}

pub struct CallToolResult {
    pub content: Vec<Content>,
    pub structured_content: Option<Value>,
    pub is_error: bool,
}

pub enum Content {                // 按 type 区分；不认识的类型保留类型名
    Text { text: String },
    Image { data: String, mime_type: String },
    Audio { data: String, mime_type: String },
    ResourceLink { uri: String, name: Option<String>, mime_type: Option<String> },
    Resource { uri: String, mime_type: Option<String>, text: Option<String>, blob: Option<String> },
    Unknown { kind: String },
}
```

### 13.4 连接

```rust
pub struct McpClient { /* 便宜的克隆，共享一条连接 */ }

impl McpClient {
    pub async fn connect(transport: Transport, init: InitOptions) -> Result<(McpClient, InitResult), McpError>;
    pub async fn list_tools(&self) -> Result<Vec<ToolInfo>, McpError>;           // 自动翻页
    pub async fn call_tool(&self, name: &str, args: Value, opts: CallOptions) -> Result<CallToolResult, McpError>;
    pub fn events(&self) -> broadcast::Receiver<ServerEvent>;                     // list_changed、退出
    pub async fn close(self);
}
```

- **服务器发来的请求**：`ping` 回 `{}`；`roots/list` 回工作区根目录；其他一律回 -32601（方法不存在）。一期不声明 sampling 和 elicitation，服务器不应发来这两类请求。
- **服务器发来的通知**：`tools/list_changed` 交给 `McpManager`；`progress` 按 token 转给对应的调用；`message`（日志）写入运行日志；其他忽略。
- **请求超时**：初始化和 `tools/list` 受启动超时约束，调用受工具超时约束；ping 只在需要时使用，一期不做心跳。
- **取消**：超时和中断都发送 `notifications/cancelled`，只有 `initialize` 例外（协议不允许取消它，超时时直接断开连接）。一个请求一旦有了结果（成功、失败、取消），传输层就不会再发送它。
- **容错**：id 对不上的响应、无法解析的行只记日志，不断开连接；`content` 缺失按空数组处理，`structuredContent` 可以是任意 JSON 值。

### 13.5 传输

**stdio**：子进程的 stdin、stdout 交给 finx-rpc 的分帧读写，每行一条消息（§5.7）。行尾的 `\r` 去掉，空行跳过，单行最多 16 MB。

**Streamable HTTP**：

- 每条客户端消息一个 POST，`Accept: application/json, text/event-stream`。
  - 响应是 `application/json`：一条消息，也接受数组；
  - 响应是 `text/event-stream`：读到这个请求的响应为止，途中的通知和服务器请求照常分发；流在响应到达之前断开，只让这一个请求失败；
  - 通知和响应的 POST 回 202 是正常的；请求的 POST 回 202 视为服务器出错。
- 任何响应带 `Mcp-Session-Id` 时记下，之后的请求都带上它；404 时换新会话（§5.5）。
- 发出 `notifications/initialized` 之后，尝试用 GET 打开服务器推送的 SSE 流，收 `list_changed` 之类的通知；服务器回 405 就不用；断开后按 1 秒起、最长 30 秒的退避重连，服务器给了 `retry` 时照它。
- 401 时状态为失败，原因写明需要登录；一期没有 OAuth，二期在这里接入（§13.8）。
- 使用 finx-llm 的共享 reqwest 客户端：同一套连接池、系统证书校验和代理设置（总方案 §4.14）。

### 13.6 探测（二期，D-185）

添加一个服务器之前先检查它，检查通过才写配置。探测不写任何文件，也不缓存结果。

- **远程服务器**，三步：
  1. **连接**：不带凭据发 `initialize`。
     - 200：握手成功，再取工具列表，结论是不需要鉴权；
     - 401：要鉴权，记下 `WWW-Authenticate` 里的 `resource_metadata`；
     - 400、404、405：按 §13.7 试旧版 SSE；
     - 连不上、TLS 错误、超时：探测失败，给出原因。
  2. **查找登录设置**：读受保护资源的元数据（RFC 9728）。先用 `resource_metadata` 给的地址，没有就依次试 `/.well-known/oauth-protected-resource<路径>` 和根路径。取得 `authorization_servers` 和 `scopes_supported`。找不到时结论是"要鉴权，但不是 OAuth"，多半用 API Key。
  3. **检查登录服务**：读授权服务器的元数据，依次试 `/.well-known/oauth-authorization-server<路径>`、`/.well-known/openid-configuration`。记下：
     - `code_challenge_methods_supported` 有没有 `S256`，没有就不能登录（D-181）；
     - `client_id_metadata_document_supported` 是否为 true；
     - 有没有 `registration_endpoint`。
- **本地服务器**，三步：启动命令、握手、列出工具。时限同 `startup_timeout_secs`，结束时结束整个进程组（§5.6）。
- **带凭据的复查**：用户选了令牌、填好以后，再带着它探测一次，通过才写配置；回 401 就提示令牌无效。
- **结果**：每一步的状态（通过、失败、跳过）和说明、HTTP 状态码、传输方式、登录设置、建议的鉴权方式和客户端身份（§13.8.2 的顺序）、工具列表。
- **进度**：每一步开始和结束都通知调用方，界面按真实的步骤画进度，而不是假的动画（customize-design §6.3）。
- **密钥**：探测用的凭据与正式连接一样写成引用。界面先用 `credentials/set` 存进钥匙串，用户放弃添加时再删掉，所以密钥仍然只经过 `credentials/set` 这一个入口（desktop-kernel-integration IG6）。

### 13.7 旧版 SSE（二期，D-184）

2024-11-05 版的 HTTP+SSE 传输：客户端先用 GET 打开一个 SSE 流，服务器在流里发一个 `endpoint` 事件，给出发消息用的地址；之后客户端的每条消息都 POST 到那个地址，服务器的响应和通知都从 SSE 流里回来。

- **何时用**：
  - 配置写了 `transport = "sse"`；
  - 没写时，地址以 `/sse` 结尾就直接用；
  - 探测时 POST `initialize` 回 400、404 或 405，就改用 GET 打开流，收到 `endpoint` 事件即判为旧版（规范的向后兼容规则）。探测把结论写进配置的 `transport`，正式连接不再猜。
- **实现**：finx-mcp 的第三种传输 `transport/sse.rs`。
  - 一条长连接的 GET 流读所有消息，按 JSON-RPC 的 id 交给等待的请求；
  - `endpoint` 可以是相对地址，按 GET 的地址解析；指向别的主机时拒绝，防止把请求和令牌送去别处；
  - POST 回 202 是正常的；
  - 流断开时，正在等的请求全部失败，下一次调用按 §5.5 重连并重新握手。
- **鉴权**：请求头和 OAuth 令牌在 GET 和 POST 上都带。
- **超时与取消**：与 Streamable HTTP 相同（§8.2）。

### 13.8 OAuth（二期，D-181–D-183、D-186）

#### 13.8.1 登录

1. **发现**：同 §13.6 的第 2、3 步。授权服务器不支持 `S256` 就不登录，提示用户改用令牌。
2. **客户端身份**：按 §13.8.2 取得 `client_id`。
3. **授权**：
   - 生成 PKCE（S256）和 state，在 127.0.0.1 的随机端口上监听回调，回调地址形如 `http://127.0.0.1:<端口>/callback`。本机回调的端口不固定是 RFC 8252 对原生应用的要求，授权服务器按它比较时忽略端口；
   - 授权地址带上 `resource`（服务器地址，RFC 8707），请求的 scope 依次取：配置的 `oauth.scopes` → `WWW-Authenticate` 里的 `scope` → 受保护资源元数据的 `scopes_supported` → 不带。
4. **打开浏览器**：常驻服务把授权地址交给桌面端，由主进程用系统浏览器打开；命令行自己打开，并把地址打印出来。
5. **回调**：校验 state 和 `iss`（授权服务器支持时），用授权码加 `code_verifier` 换令牌，请求里同样带 `resource`。回调页显示"已登录，可以回到 FinxWork"，不显示任何令牌。
6. **保存**：令牌响应、过期时间、授权服务器和服务器地址存进钥匙串的 `mcp-oauth.<名字>`。地址变了令牌就作废；同名服务器删掉再加回来，也不继承旧令牌。
7. **时限**：5 分钟没有回调就放弃，关闭监听。

#### 13.8.2 客户端身份的顺序（D-182）

1. **用户配置的应用**：`oauth.client_id`，以及可选的 `client_secret`。用于 GitHub 这类既不支持元数据文档、也不支持动态注册的登录服务。
2. **finx 公布的身份**：授权服务器公布 `client_id_metadata_document_supported: true` 时，`client_id` 就是 finx 的客户端元数据文档的地址（§13.8.3），不需要注册。所有用户共用一个身份，登录服务看到的是 finx 的域名。
3. **动态注册**（RFC 7591）：授权服务器有 `registration_endpoint` 时，以公开客户端注册（`token_endpoint_auth_method: none`）。
   - **注册一次，以后复用**：结果按"授权服务器的 issuer"存在 `~/.finx/mcp/oauth-clients.json`（0600），有 `client_secret` 的放钥匙串。同一个登录服务后来的登录、重新登录、别的同源服务器都用它；只有授权服务器回 `invalid_client` 时才重新注册。不这样做，每次重连都会多出一条注册，一些登录服务的应用数额度很快会被用光（§13.8.6）。
4. **都不支持**：登录失败，提示用户填自己的应用，或者改用令牌。

这与 MCP 授权规范（2025-11-25）给客户端的顺序一致。

#### 13.8.3 finx 的客户端元数据文档（D-183）

- **是什么**：一个放在固定 https 地址上的静态 JSON。地址本身就是 `client_id`，授权服务器用到时去读它。
- **内容**：
  ```json
  {
    "client_id": "https://<finx 的域名>/oauth/client.json",
    "client_name": "FinxWork",
    "client_uri": "https://<finx 的域名>",
    "logo_uri": "https://<finx 的域名>/oauth/logo.png",
    "redirect_uris": ["http://127.0.0.1/callback", "http://localhost/callback"],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "token_endpoint_auth_method": "none"
  }
  ```
- **地址永远不变**：地址就是身份，换了就等于换了一个应用，所有用户都要重新授权。所以放在 finx 自己的域名下，不放在第三方托管服务的子域名上。具体地址见 Q-119。
- **不含密钥**：公开客户端，公开放着就行。
- **能防什么、不能防什么**：它省掉注册，给出稳定、可核实的身份；但桌面应用的回调在本机，本机的其他程序理论上也能用这个 `client_id` 发起登录，所以对桌面应用来说，它防冒充的作用不如对网页应用。真正的保护仍然是 PKCE 和用户在授权页上的确认。
- **测试与自建分支**：`mcp.client_metadata_url` 可以改成别的地址。

#### 13.8.4 使用与续期

- **连接时**：`auth = "oauth"` 的服务器，从 `mcp-oauth.<名字>` 取访问令牌，放进 `Authorization: Bearer`。
  - 没有令牌：状态为 `needs_login`，不发请求；
  - 快过期（剩不到 60 秒）：先刷新再连。
- **收到 401**：用刷新令牌刷新一次再重发；刷新失败或没有刷新令牌，状态改为 `needs_login`，这次调用给模型一个说明需要用户登录的错误。
- **跨进程锁**：刷新时取 `~/.finx/run/locks/mcp-oauth-<名字>.lock`，命令行、常驻服务和各个会话不会同时刷新、互相覆盖。刷新完再读一次钥匙串，别的进程已经刷新过就直接用。
- **服务器要求更多权限**（403 带 `insufficient_scope`）：状态改为 `needs_login`，并记下要的 scope，下次登录时带上。
- **退出**：授权服务器有 `revocation_endpoint` 就先撤销刷新令牌，再删除钥匙串条目。

#### 13.8.5 不做的

- **"用到时再登录"**：先不带凭据连接，模型用到需要登录的工具时再请用户登录。这要求会话在任务中途停下来等用户，与审批通道相似，等有服务器真的需要时再做（Q-118）。
- **把令牌放在远端**：有的产品把令牌放在自己的服务端，智能体调工具时拿不到令牌。finx 的令牌在用户自己电脑的钥匙串里，连接也从本机发起，不经过任何 finx 的服务器。

#### 13.8.6 调研与实测（2026-10-31）

- **其他产品**：
  - 有一个面向大众的聊天产品，自定义连接器只能连公网地址，走动态注册。社区的实测反馈是每次重连都会新注册一个客户端，一次连接尝试注册了 3 个，用光了一个用户在登录服务上的应用数额度。是否支持元数据文档没有公开资料。
  - 有一个编程工具的做法：授权码加 PKCE，按 RFC 9728 发现，动态注册为公开客户端，也可以在配置里写固定的 `CLIENT_ID`、`CLIENT_SECRET`、`scopes`；回调地址写死（桌面 `http://localhost:8787/callback`）；云端运行时令牌放在它自己的服务端。文档没有提元数据文档。
  - 它们的大厂连接器（Google、Microsoft 等）用预先登记的应用，回调地址写死，所以出现过"回调地址不匹配"一类的问题。
- **几个服务器公布的登录设置**（直接读取 `/.well-known/oauth-authorization-server`）：

| 登录服务 | 元数据文档 | 动态注册 | S256 |
|---|---|---|---|
| hermesh.io | 支持 | 支持 | 支持 |
| mcp.linear.app | 支持 | 支持 | 支持 |
| mcp.notion.com | 支持 | 支持 | 支持 |
| mcp.sentry.dev | 支持 | 支持 | 支持 |
| github.com/login/oauth | 不支持 | 不支持 | 支持 |

- **结论**：主流服务器已经同时支持元数据文档和动态注册，优先用前者；GitHub 只能用预先登记的应用，或者改用个人访问令牌。

### 13.9 服务的 logo（D-188–D-191）

连接器列表、详情页和添加流程用服务自己的 logo，找不到才退回名字的首字母。

**从哪里来**，按顺序，找到就停：

1. **服务器声明的图标**：MCP 2025-11-25 在握手的 `serverInfo` 里加了 `icons`（每项有 `src`、`mimeType`、`sizes`、`theme`）和 `websiteUrl`。远程和本地服务器都适用。按尺寸挑：接近 180 px 的位图最好，可缩放的 SVG 其次；`theme` 为 `dark` 的排在后面，因为图块是浅色底。
2. **网站的图标**：服务器没有声明、或声明的都不能用时，按浏览器找网站图标的标准做法：
   - 依次看这些站点：`websiteUrl` 的主机；服务器地址的主机（`mcp.hermesh.io`）；主机第一段是 `mcp`、`api`、`www`、`server`、`gateway`、`app` 一类时，再看它所属的站点（`hermesh.io`，取主机最后两段，`.co.uk` 这类取三段）及其 `www.`。`my-tools.vercel.app` 这类托管平台的子域名不往上找，免得显示平台的 logo。
   - 远程服务器的 `websiteUrl` 只有在服务器自己的站点内才算（MCP 要求图标来自服务器所在的源）；本地服务器没有地址，`websiteUrl` 就是唯一的线索。
   - 每个站点读首页的前 512 KB，取 `<link rel="icon">`、`rel="apple-touch-icon"`，以及 `rel="manifest"` 指向的网页应用清单里的 `icons`（只取用途含 `any` 的）；按尺寸排序，最后试 `/favicon.ico`。
3. **都没有**：显示首字母。本机地址（`localhost`、IP）不找网站图标。

**安全**（MCP 规范对图标的要求，finx 全部照做）：

- 只接受 https 和 `data:` 地址；跳转只能留在上面那几个站点内、最多 3 次，不能换协议。
- 不带 Cookie、令牌或任何凭据：用单独的 HTTP 客户端，不用连接服务器的那一个。
- 服务器声明的 https 图标也必须在这几个站点内；本地服务器没有地址，只接受 `data:` 图标或 `websiteUrl` 站点上的图标。
- 类型按文件内容判断，只认 PNG、JPEG、WebP、ICO、SVG；不超过 256 KB；PNG 宽高不超过 2048。
- SVG 里不能有 `<script>`、`<foreignObject>`、`on…=` 事件属性、`javascript:`、实体声明，也不能引用外部文件（`href`、`url(…)` 只能指向图内的 `#id` 或内嵌的位图）。桌面端只用 `<img>` 显示，图里的脚本本来也不会运行，这是第二道防线。
- 每个服务最多试 6 个候选，单个请求 5 秒，整个查找 12 秒。

**什么时候找，存在哪里**：

- 探测（`mcp/probe`、`finx mcp add`）成功时找一次，最多等 2 秒，没找完就先回答、在后台接着找：需要登录的服务器握手不了，此时用网站的图标。`mcp/check`（添加后的检查）连上以后在后台再找一次，服务器声明了图标就换成声明的，有变化时发 `mcp/changed`。探测和检查都不因为找图标而变慢。
- 结果按服务的标识（§13.10）存在 `~/.finx/mcp/icons/<标识的 SHA-256 前 8 字节>.json`，内容是图片的 base64、类型、来源和时间；没找到也记下，免得每次都去找。一周后过期，下次检查时重找；最多留 200 个，多了删最旧的。网站的图标不会覆盖服务器声明的。
- logo 是取来的，不是用户的设置，所以不写进 `config.toml`。会话启动不找图标，列表也只读本地文件，不发任何请求。
- 协议：`McpServerView.icon` 和 `McpProbeResult.icon`，都是 `data:` URI。

### 13.10 同一个服务只连一次（D-192、D-193）

同一个服务连两次，模型会看到两份一模一样的工具，只是前缀不同，不知道该用哪个。所以 finx 按"连到哪里"判断是不是同一个服务，与名字无关。

- **标识**（`finx-mcp/src/identity.rs`，桌面端 `apps/desktop/src/shared/identity.ts` 算法相同）：
  - 远程：地址的协议和主机转小写，去掉默认端口、末尾的 `/` 和 `#…`，保留路径和查询参数（`?team=b` 可能是另一个工作区）。
  - 本地：命令行，`npx`、`bunx`、`pnpx`、`uvx` 的 `-y`、`--yes` 不算。
  - 环境变量、请求头、凭据都不算：同一个地址换个令牌，仍然是同一个服务。
- **在哪里拦**：
  - 桌面端：地址框里一出现已有服务的地址，立刻在下面提示"X 已经连着这个服务了"，带"打开 X"，"连接"按钮不可用。编辑已有连接器时改成别的连接器的地址，保存时同样提示。
  - 命令行：`finx mcp add` 发现重复就不写，提示已有的那个名字；`--force` 可以照样添加（例如同一个服务的两个账号）。
  - 各层的服务器都算，包括已停用的和仓库里的。
- **视图**：`McpServerView.identity`，页面拿它和正在添加的地址比较。

## 14. 性能与资源

| 场景 | 预算 |
|---|---|
| 没有配置服务器 | 与现在完全相同：不创建 `McpManager`、不启动任务，`bench_startup.py` 的数字不变 |
| 有服务器，`session/new` | 不等待连接，响应时间不变 |
| 有服务器，第一次请求 | 只有按需加载的服务器时不等；有 direct 服务器时，多出的等待等于其中最慢的就绪时间，上限为 `mcp.startup_wait_secs`（10 秒）；二期有了工具目录缓存后接近 0 |
| 窗口占用 | 按需加载时，固定部分只有目录段（最多 4 KB）和两个工具的定义；搜到的定义按用到的多少进入历史 |
| 每次请求的检查 | 一次原子读（§5.4） |
| 每次调用的额外开销 | 一次 JSON 编码、一次解码；文本内容直接移进 `UserContent`，不再复制 |
| 内存 | 每个工具的定义只存一份（注册表里的 `Arc`）；结果与其他工具结果一样裁切后进入历史 |

- **本地服务器的启动时间主要在服务器自己**：`npx` 启动的服务器通常要几百毫秒到数秒，第一次运行还要下载包。§5.3 的并行连接和"不阻塞会话创建"就是为了把这部分藏在用户输入的时间里。
- **常驻服务**：每个会话各自启动服务器进程，会话多时进程也多。空闲卸载（协议方案 §3.8）会一并关闭这些进程。共用进程见 Q-100。
- **验收时实测**：第一次请求的等待时间、单次调用的往返开销、空闲时的内存。

## 15. 代码落点

| 位置 | 内容 |
|---|---|
| `crates/finx-mcp/src/types.rs` | §13.3 的类型 |
| `crates/finx-mcp/src/client.rs` | `McpClient`：初始化、列表、调用、取消、进度、服务器请求 |
| `crates/finx-mcp/src/transport/{stdio,http}.rs` | 两种传输 |
| `crates/finx-mcp/src/tool.rs` | `McpTool`、限定名（§6.2）、描述与 schema 修正（§6.3、§6.4） |
| `crates/finx-mcp/src/content.rs` | 结果转换（§8.4） |
| `crates/finx-mcp/src/search.rs` | 工具目录的 BM25 索引（§7.5），与内核无关 |
| `crates/finx-core/src/mcp/manager.rs` | `McpManager`：启动、确定、状态事件、代数、关闭 |
| `crates/finx-core/src/mcp/tools.rs` | `tool_search`、`call_tool`（§7.5、§7.6）；目录段的生成（§7.4） |
| `crates/finx-core/src/config.rs` | `[mcp]`、`[mcp_servers]`、`.mcp.json`、环境变量展开、信任检查 |
| `crates/finx-core/src/approval.rs` | MCP 工具直接放行 |
| `crates/finx-core/src/{kernel,session,task,budget,prompt}.rs` | 创建 `McpManager`；注册表放进会话状态；第一次请求前确定、每次请求前检查；系统提示词的 MCP 段；固定 token 重算 |
| `crates/finx-tools/src/tool.rs` | `Tool::origin()`；`Tool::kind_for(args)`（§7.6） |
| `crates/finx-protocol/src/{op,event,api}.rs` | `McpServerConfig`（含 `exposure`、`description`）、`McpServerStatus`、`mcp_servers` 参数；重新生成 schema.json |
| `crates/finx-server/src/{server,mirror}.rs` | 透传 `mcp_servers`；镜像与快照里的服务器状态 |
| `crates/finx-acp/src/{lib,schema,encoder}.rs` | `mcpServers` 的解析与转换；能力声明；失败的 notice |
| `crates/finx-cli/src/` | `finx mcp`、`--mcp-config`、状态显示 |
| `crates/finx-mcp/src/transport/sse.rs` | 二期：旧版 SSE（§13.7） |
| `crates/finx-mcp/src/probe.rs` | 二期：探测（§13.6） |
| `crates/finx-mcp/src/oauth/` | 二期：发现、客户端身份、授权与回调、换取与刷新、撤销（§13.8） |
| `crates/finx-core/src/config.rs` | 二期：`transport`、`auth`、`oauth`、`mcp.client_metadata_url` |
| `crates/finx-server/src/customize.rs` | 二期：`mcp/probe`、`mcp/login`、`mcp/logout`（customize-design §6.3） |

**与并行分支的关系**：feat/agents 正在修改 kernel.rs、session.rs、task.rs、tool_exec.rs、config.rs、event.rs 和 finx-tools 的 tool.rs，与本方案的改动重叠较多。建议等它合入 main 之后再开始一期的内核部分；finx-mcp 这个新 crate 不碰任何现有文件，可以先做。

## 16. 分期实施与验收

### 一期：注册、按需加载与调用（约 2.5 周）

**范围**
- finx-mcp：类型、客户端、stdio 与 Streamable HTTP（静态头和 bearer token，不含 OAuth）、`McpTool`、结果转换；
- 来源：用户配置、项目配置、`.mcp.json`（开关打开时）、`-c`、`--mcp-config`、ACP、原生协议；信任检查；环境变量展开；
- 内核：`McpManager`、第一次请求前的确定、请求之间替换工具集合、系统提示词的 MCP 段、状态事件、关闭；
- 按需加载：两种暴露方式、目录段、`tool_search`（BM25、按服务器列出、不重复给定义）、`call_tool`、`Tool::kind_for`；
- 权限：MCP 工具不审批，内置审批策略按来源放行；
- 子智能体共用连接（feat/agents 合入之后）；
- 命令行：`finx mcp list`、`finx mcp get`、状态显示。

**验收标准**
1. 用 `@modelcontextprotocol/server-everything`（stdio）和一个本地的 Streamable HTTP 测试服务器，`finx exec` 调用 DeepSeek，模型调用 MCP 工具完成任务；结果进入历史，`finx resume` 之后可以继续调用。
2. 长时间运行的 MCP 调用被中断时，服务器收到 `notifications/cancelled`，任务以 interrupted 结束，会话可以继续。
3. 未受信任的项目里，`.mcp.json` 和项目配置里的服务器不启动，并给出 warning。
4. 没有配置服务器时，`tools/bench/bench_startup.py` 的结果不变；有服务器时 `session/new` 的响应时间不变。
5. 在 Zed 中，编辑器配置的 MCP 服务器经 `session/new` 传给 `finx acp`，模型能调用它们。
6. 按需加载：配置 20 个以上的服务器、总共几百个工具（用测试服务器生成），DeepSeek 能经 `tool_search` 找到并经 `call_tool` 用对工具；目录段不超过 4 KB；整个任务里每次请求的工具列表和系统提示词逐字节相同，缓存命中率与不接 MCP 时相当。

### 16.1 一期实现记录（2026-10-29）

**落点**
- finx-mcp（新 crate）：类型与版本协商、stdio 与 Streamable HTTP 两种传输、客户端（分页、进度、取消、ping、roots）、服务器槽位（状态、懒重连、`list_changed`）、限定名、schema 修正、结果转换、BM25 索引、`McpTool`。
- finx-protocol：`McpServerConfig` 及相关类型、`mcp_server_status` 事件、快照的 `mcp_servers`、`session/new` 与 `session/resume` 的 `mcp_servers`、warning code `mcp_servers_not_ready`；schema.json 已重新生成。
- finx-tools：`Tool::kind_for`、`Tool::origin`（`ToolOrigin::Mcp`）。
- finx-core：`[mcp]`、`[mcp_servers]` 配置与信任剥离、`.mcp.json`、合并与来源记录；`McpManager`、目录段、`tool_search`、`call_tool`、请求之间替换工具集合、第一次确定与 `required`、MCP 工具免审批、子智能体共用连接、压缩后重新计算已给的定义、恢复会话。
- finx-server、finx-acp、finx-cli：服务层合并 `--mcp-config` 与客户端带来的服务器；ACP 的 `mcpServers` 与 `mcpCapabilities.http`；`finx mcp list/get`、`--mcp-config`、`finx status` 的一行、终端状态行。
- finx-mock：MCP 测试服务器 `finx-mcp-server`（stdio 或 HTTP；脚本化工具、生成的工具、`--domain`），模拟模型新增 `mcp`、`mcp_direct` 场景。

**验收结果**

| 项 | 结果 |
|---|---|
| 1 | 用 finx 自带的测试服务器代替 `server-everything`（验收时不下载第三方包），stdio 与 Streamable HTTP 两种传输都有集成测试。DeepSeek（deepseek-flash）实测：`finx exec` 里模型先 `tool_search`，再经 `call_tool` 取回发布码，与独立算出的值一致；`finx exec --continue` 恢复会话后服务器重新连接，模型直接调用历史里已经搜到的两个工具（同一批），结果正确 |
| 2 | 内核测试：慢工具的进度到达会话后中断，服务器收到 `notifications/cancelled`，任务以 interrupted 结束，会话可以继续；客户端测试另外覆盖超时与进度重新计时 |
| 3 | 配置测试：未受信任的项目去掉 `[mcp_servers]` 和 `mcp.project_json`，warning 列出被忽略的服务器名；受信任时项目可以关掉用户配置里的服务器 |
| 4 | 见下方启动基准 |
| 5 | 未在 Zed 中实测。端到端测试按 ACP 官方 schema 类型校验每条消息：`session/new` 带来的 stdio 服务器可用，sse 服务器跳过并发 notice，会话关闭后 `session/load` 再次带来的服务器可用，调用不发权限请求 |
| 6 | DeepSeek 实测：20 个服务器共 460 个工具，目录段 743 字节，工具列表 8 个工具；模型按目录里的说明并行搜索两个服务器，调用的工具正确。3 个服务器共 939 个工具时同样正确。每个会话只记一条 `system_prompt`，各轮请求的缓存命中逐轮增长 |

**启动基准**（`tools/bench/bench_startup.py`，release 构建，同一台机器，各 30–40 次，取 p50；配置服务器用新增的 `--config`）：

| 配置 | 第一次请求 | 进程退出 |
|---|---|---|
| main（e64f113），不配服务器 | 6.00 ms | 10.78 ms |
| feat/mcp，不配服务器 | 6.06 ms | 10.71 ms |
| feat/mcp，一个按需加载的服务器（313 个工具） | 6.35 ms | 10.91 ms |
| feat/mcp，同一个服务器设为 direct | 14.04 ms | 20.33 ms |

不配服务器时与 main 相同；按需加载的服务器不推迟第一次请求；direct 服务器的第一次请求要等它连上（启动、握手、取工具列表，本地测试服务器约 8 ms）。

**与 §17 的差异**
- HTTP 传输用 finx-mock 里的 Streamable HTTP 测试服务器测试（JSON 与 SSE 响应、会话 id、405 的 GET、关闭时 DELETE），没有用 wiremock。
- MCP 官方的一致性测试套件和官方 Rust SDK 还没有接入 CI，留到二期。

**测试**：finx-mcp 单元 14 个、集成 3 个；内核 MCP 测试 10 个；命令行端到端 4 个（`finx exec` 按需加载、`finx mcp list/get/--check`、原生协议带来 direct 服务器、ACP 新建与再次加载）。合并 main（b907ff1，含 Skill 一、二期、文件工具、本地模型连接与子智能体的显示）之后全量 452 个通过（含合并后补的两个测试），本方案的代码 clippy 无警告；合并后的版本再用 DeepSeek 实测，结果正确，`system_prompt` 条目同时带 `skills` 和 `mcp`。

### 16.2 二期实现记录：鉴权与传输（2026-10-31）

已实现，未提交。与上文不同、或上文没写到的地方：

- **代码**：
  - `finx-mcp/src/transport/sse.rs`（旧版 SSE）、`probe.rs`（探测）、`oauth/`（`discovery.rs`、`client.rs`、`login.rs`、`mod.rs` 里的 `TokenSource`）。
  - 两种 HTTP 传输都持有一个 `BearerSource`，每次请求取令牌，收到 401 刷新一次再重发。
  - `McpServerState` 新增 `NeedsLogin`。连接失败分三类：可重试、配置错误、需要登录。需要登录的服务器一旦钥匙串里有了这个地址的令牌，下一次调用就重连，不等 30 秒的重连间隔。
- **凭据缓存**：`finx_llm::credentials` 新增 `forget`。读令牌、刷新前后都先丢掉进程内的缓存再读，别的进程刷新过的令牌才看得到。
- **动态注册的回调地址带端口**：注册时登记的是带端口的 `http://127.0.0.1:<端口>/callback`，因为不少登录服务严格比较回调地址。复用注册时先尝试绑定同一个端口，端口被占用就重新注册。元数据文档里登记的仍是不带端口的本机地址，按 RFC 8252 由登录服务忽略端口。
- **元数据文档的地址**：`finx_core::mcp::CLIENT_METADATA_URL` 现在是 `None`（Q-119），所以登录走动态注册或用户自己的应用。地址定下来后改这一个常量即可，`mcp.client_metadata_url` 可以临时覆盖。
- **选择身份**：`mcp/login` 新增可选的 `client`。调用方指定了哪种身份，服务器允许就用那一种，否则按 D-182 的顺序。桌面端不再指定，由内核按顺序选（customize-design DD-59）；`client` 留给命令行和以后的调用方。
- **新错误码**：−32031 `mcp_login_failed`，表示服务器没有可用的登录方式，或者登录没能开始。
- **打开浏览器**：
  - 命令行打印授权地址并尝试打开浏览器，设了 `FINX_NO_BROWSER` 时不打开；
  - 桌面主进程只打开 https 地址和本机的 http 地址，设了 `FINXWORK_NO_BROWSER` 时不打开；
  - 这两个环境变量供测试使用，测试自己扮演浏览器。
- **`finx mcp add`**：
  - 先探测并逐步打印结果；失败时退出码为 1，并删掉为探测存下的凭据；
  - 探测出 OAuth 时先登录再写配置；
  - 探测出旧版 SSE 时把 `transport = "sse"` 写进配置。
- **测试用的服务器**：finx-mock 新增 `mcp_auth.rs`，作为测试服务器旁边的授权服务器。它提供：
  - 受保护资源和授权服务器的元数据；
  - 动态注册、授权（立即同意并重定向）、PKCE 校验、`resource` 校验、续期、撤销；
  - 固定令牌模式；
  - 旧版 SSE（`/sse` 和 `/stream`，POST 这两个地址回 405）。

  `finx-mcp-server` 新增 `--oauth`、`--token`、`--sse`、`--no-metadata-document`、`--no-registration`、`--token-ttl`。`browse()` 跟随重定向，用来扮演浏览器。
- **测试**：
  - `finx-mcp/tests/oauth.rs`，4 个：
    - 旧版 SSE 按地址连接，也能经探测发现；
    - 探测的各种结论；
    - 动态注册只做一次、令牌过期前自动刷新、撤销；
    - 元数据文档、用户自己的应用、两者都不支持时的提示。
  - `finx-cli/tests/e2e_mcp_auth.rs`，2 个：
    - 原生协议：探测 → 写入前登录 → 写入 → 检测 → 会话调用 → 退出 → 取消探测；
    - 命令行：连不上不写、`--force`、OAuth 添加、再次登录复用注册、退出、自动识别旧版 SSE。
  - 单元测试：`WWW-Authenticate` 解析、well-known 地址、表单编码、SSE 的端点不能跨主机。
  - 全部 Rust 测试 557 个通过；clippy 只剩 main 原有的警告。
- **logo 与去重（v1.4）**：
  - 代码：`finx-mcp/src/icon.rs`（查找、校验、存取）、`identity.rs`（标识）；`Implementation` 多了 `icons` 和 `websiteUrl`，`McpServer::info()` 留着最近一次握手的内容；`ServerCheck.info`；`FinxHome::mcp_icons_dir()`。
  - 图标用的 HTTP 客户端与模型连接共用同一套 TLS 设置（`finx_llm::tls_client_config`），另配自己的跳转规则，不带任何凭据。
  - 首页超过 512 KB 时只读前 512 KB：图标链接都在 `<head>` 里。不截断的话，Linear 这类首页很大的站点只能拿到 `/favicon.ico`。
  - 测试服务器在握手里声明一个 `data:` 图标。测试：`icon.rs` 和 `identity.rs` 的单元测试 6 个（类型判断、SVG 的各种危险写法、页面里的图标、站点推算、声明的不被网站的覆盖、标识）；`e2e_mcp_auth.rs` 新增"同一个服务只加一次，并留下它的 logo"；桌面端 `identity.test.ts` 与 Rust 用同一组例子。全部 Rust 测试 564 个通过。
  - 真实站点实测（2026-10-31，经 `finx mcp add` 的探测）：Notion、Linear、hermesh 取到 apple-touch-icon 一类的大图标，Sentry 取到 `favicon.ico`；`api.githubcopilot.com` 所属站点没有图标，显示首字母。
- **没做的**：
  - 真实服务（Linear、Sentry、GitHub）上的登录验收；
  - "用到时再登录"（Q-118）。

### 二期：完善

- 工具目录缓存：按"服务器配置的指纹 + 工作区 + 协议版本"把工具列表和 instructions 存在本地；之后的会话第一次请求直接用它，服务器在后台启动，调用时才等（Q-112）。
- 按需启动：有缓存的 deferred 服务器等到搜索或调用用到时才启动（§7.9）。
- OAuth：`finx mcp login/logout`，授权码加 PKCE，本机回调，令牌存钥匙串，客户端身份按"自己的应用 → 元数据文档 → 动态注册"（§13.8）。
- 旧版 SSE 传输（§13.7）。
- 探测：添加前检查，通过才写配置（§13.6）。
- 公布 finx 的客户端元数据文档（§13.8.3，地址见 Q-119）。
- `finx mcp add/remove`（引入 toml_edit）。
- 重连：`Op::McpReconnect`，以及是否自动重启（Q-103）。
- resources：服务器声明了 resources 能力时，提供列出和读取资源的工具（Q-105）。
- elicitation：服务器向用户要信息时，经与审批相同的通道交给界面（Q-104）。
- 桌面端的服务器状态与管理界面（Q-107）。

### 三期：规模

- 厂商原生的中途声明工具：适配器支持时，搜到的工具在对话里正式声明，模型直接调用，不再经过 `call_tool`（§7.7、Q-117）。
- 常驻服务里多个会话共用服务器进程（Q-100）。
- prompts：作为界面里的命令提供。

## 17. 测试

| 层 | 内容 |
|---|---|
| finx-mcp 单元 | 限定名（替换字符、超长截断与哈希、冲突、稳定性）；schema 修正；各种内容块的转换；版本协商；子进程环境只含白名单与配置的变量 |
| 测试服务器 | 用 Rust 写一个 stdio 测试服务器（finx-mock 的一个新入口），按脚本提供工具：echo、返回图片、返回错误、只返回 structuredContent、超大输出、慢工具（检查是否收到取消）、发进度（检查超时重新计时）、发 `list_changed`、中途退出、派生孙进程（检查关闭时整个进程组都结束）、大量写 stderr（检查不会卡住）、分页的工具列表 |
| HTTP | 用 wiremock 模拟 Streamable HTTP：JSON 响应、SSE 响应、会话 id、404 后重新初始化、405 的 GET |
| 旧版 SSE（二期） | wiremock：`endpoint` 事件、相对地址、指向别的主机时拒绝、POST 202、流断开时等待的请求失败；探测从 405 回退到 SSE |
| 探测（二期） | 200、401 带与不带 `resource_metadata`、元数据的两种位置、没有 S256、连不上；本地命令启动失败；每一步的进度通知；不写任何文件 |
| OAuth（二期） | 模拟授权服务器：三种客户端身份的选择顺序；动态注册的结果复用、`invalid_client` 后重新注册；state 和 `iss` 校验；`resource` 参数；回调超时；令牌快过期与 401 时刷新、两个进程同时刷新只刷新一次；`insufficient_scope`；撤销；令牌不进日志和事件 |
| 真实服务器（二期） | 用 Linear 或 Sentry 走元数据文档，用一个只支持动态注册的服务器走注册，用 GitHub 走自己的应用；各走一遍登录、调用、续期、退出 |
| 内核 | 基于 ScriptedApi：模型调用 MCP 工具；三种权限模式下都不询问；迟到的服务器在下一次请求前加入；`list_changed` 之后替换工具集合并记日志；`required` 服务器失败时任务失败；崩溃后的错误结果；中断；恢复会话 |
| 按需加载 | BM25 排序（精确名字排第一、拆词、只搜 deferred）；按服务器列出；服务器 instructions 只附一次；不重复给定义，压缩后重新计算；还在连接的服务器先等；目录 4 KB 上限与缩短规则；`call_tool` 的路由、未知名字、并发跟随目标；同一个任务里搜索和调用前后，请求的工具列表与系统提示词逐字节不变 |
| 子智能体 | 子拿到父的全部工具（不含两个智能体工具，含 `tool_search`、`call_tool`）；子共用根的连接并能直接调用 MCP 工具 |
| 端到端 | 真实 `finx` 进程，finx-mock 扮演模型，测试服务器扮演 MCP 服务器；原生协议与 ACP 两条路径都覆盖 |
| 一致性 | MCP 官方的客户端一致性测试套件在 CI 中运行，覆盖 finx 支持的各个协议版本；官方 Rust SDK 作为测试依赖，用它写的服务器与 finx-mcp 对接 |
| 真实 | DeepSeek 加 `server-everything`、`server-filesystem` 做验收；用测试服务器生成几百个工具，检查模型能否靠目录和搜索用对工具（§16） |

## 18. 备选方案与取舍

| 方案 | 不采用的原因 |
|---|---|
| 使用官方 Rust SDK | 客户端需要的部分很少，finx 已有 JSON-RPC 与 HTTP 基础设施；SDK 带来自己的中间类型，进程清理、发送顺序、HTTP 客户端等默认行为都要改，还要跟它的版本，与 D-28 的做法也不一致（§13.1）。SDK 保留为测试依赖；二期 OAuth 的成本过高时，再评估只用它的鉴权部分 |
| 前端连好服务器再调用 `Kernel::start` | 实现最简单，内核不用改；但 `session/new` 要等最慢的服务器，桌面端和编辑器打开会话时卡住；状态也无法通过会话事件告诉客户端 |
| direct 服务器也不等待，或者只等 1 秒左右，第一次请求直接发出，服务器就绪后再加入 | 启动最快，但第一次请求常常缺工具，紧接着又要替换工具集合，多一次缓存未命中。按需加载的服务器本来就不等（§7.8）；direct 服务器的提速靠二期的工具目录缓存 |
| 只在任务开始时替换工具集合 | 前缀更稳定，但服务器在任务中途通过 `list_changed` 开放的工具（例如按需启用一组工具的服务器）要等用户下一句话才能用 |
| 服务器崩溃时删除它的工具 | 请求前缀随之变化；模型看不到工具，却可能凭历史继续调用，得到的是"未知工具"，不如明确的"服务器已退出" |
| 一期就做审批（默认询问，加按工具名的规则和"本会话总是允许"） | 一期先不做：MCP 调用直接运行。`Tool::origin()` 已经留好，以后加审批只改审批策略（§9.2） |
| 全部 MCP 工具直接进工具列表 | 最简单，模型一步就能调用；但一个连接器就是几十上百个工具，上百个连接器能把窗口占满，工具一多模型也更容易选错。只留给工具很少的 direct 服务器 |
| 搜到的工具加进工具列表，模型按真名直接调用 | 调用最自然；但 openai-chat（DeepSeek）没有中途声明工具的办法，每加载一次就要重发整个工具列表，请求前缀的缓存失效一次。只在厂商原生支持中途声明时这样做（§7.7） |
| 按工具数量自动决定是否按需加载（例如定义超过窗口的 10% 时） | 小配置一步到位；但要先连上所有服务器、拿到工具列表才能决定，第一次请求的等待省不掉；模型的行为还会随装了几个服务器而变 |
| 目录里列出每个工具的名字 | 模型不用搜索就知道有什么；但上百个连接器就是几千个名字，目录本身又会占满窗口。按服务器列目录、按需搜索才能随规模增长 |
| 只给一个代理调用工具、不提供搜索 | 工具列表最稳定；但模型看不到参数 schema，只能猜参数，调用质量差 |
| 让模型写脚本调用工具 | 最省 token，工具列表也完全不变；但要内置沙箱化的脚本运行时，模型还得写对代码。以后再评估（Q-116） |
| 子进程继承 finx 的全部环境（去掉厂商密钥） | 与 bash 一致、兼容性最好；但服务器在启动时运行、不经审批，往往是运行时下载的第三方包，环境里的密钥（CI 里尤其多）不该默认交给它们。白名单加上代理和证书变量，能覆盖绝大多数服务器 |
| 为节省 token 压缩 schema（超过预算时去掉描述、展开或丢掉引用、只保留关键字的一个子集） | 一期不做：改写会丢掉服务器给的约束；token 的问题由按需加载解决（§7） |
| 默认读取 `.mcp.json` | 很多项目已经用它声明服务器，读了就不用在 finx 的配置里再写一遍；但这个文件属于别的工具，里面的服务器是为那个工具的用法挑的，finx 信任项目之后会在启动时自动运行它们、调用也不审批，用户未必想到；只想对 finx 关掉其中一个也不方便。默认不读，一个开关就能打开（D-118） |

## 19. 决策与待定问题

### 19.1 决策

| 编号 | 决策 | 理由 | 章节 |
|---|---|---|---|
| D-100 | MCP 工具就是内核工具：每个包装成实现 `Tool` 的 `McpTool`，进入会话的注册表；钩子、审批、并发、裁切、事件、日志全部复用 | 内核里只有一条执行路径；以后的工具来源也照此接入 | §1.2 §6.1 |
| D-101 | 内核只接收一份合并好的 `Vec<McpServerConfig>`；配置文件、`.mcp.json`、命令行、ACP、原生协议都在前端换成这种形式 | 内核与来源无关；新增来源不改内核 | §4.2 |
| D-102 | 来源的优先级为配置文件三层（用户配置 < 项目配置 < `-c`，逐表合并）< `--mcp-config` < 客户端，后两种按整个服务器替换；`.mcp.json`（默认不读）只补充配置文件里没有的名字；项目里的两种来源只在受信任的项目中加载（v1.1 调整：`.mcp.json` 不再覆盖用户配置） | 越具体、越接近此刻意图的来源越优先；`.mcp.json` 属于别的工具，不应改掉 finx 自己配置里的同名服务器；stdio 服务器在启动时即执行，必须先有信任 | §4.1 §4.4 |
| D-103 | 会话创建时并行连接、不阻塞；第一次模型请求之前只等 direct 服务器，最多 10 秒（`mcp.startup_wait_secs`），按需加载的服务器不等；单个服务器的连接上限 30 秒（`startup_timeout_secs`），没等到的在后台继续；`required` 的服务器一定等，失败则任务失败 | 连接时间藏在用户输入里；direct 服务器的工具第一次请求就要带上；经 `npx` 启动的服务器 10 秒常常连不上 | §5.3 §7.8 |
| D-104 | direct 服务器的工具集合只在两次模型请求之间、确实变化时替换（迟到的服务器、`list_changed`、重连后工具不同），每次替换记一条 `system_prompt` 条目；按需加载的服务器只更新搜索索引；崩溃不删工具 | 请求前缀平时稳定；动态开放工具的服务器在任务中也能用 | §5.4 §5.5 §7.8 |
| D-105 | 限定名为 `mcp__<server>__<tool>`；字母、数字、`_` 以外的字符（含 `-`）换成 `_`，超过 64 个字符或互相冲突时加原始名哈希的 8 位后缀；路由按名查表，不解析名字 | 满足各家厂商的名字限制，以后也能直接当脚本里的标识符；名字稳定，历史与前缀对得上 | §6.2 |
| D-106 | 参数 schema 只做与厂商无关的修正（顶层补 object 与 properties，去掉 `$schema`，布尔子 schema 换成 `{}`，去掉没被引用的定义）；修不好的工具不注册；厂商的限制在 finx-llm 的适配器里按 Compat 处理；不在本地校验参数 | 一个坏 schema 会让每次请求都失败；一处适配所有工具；服务器自己校验最准确 | §6.4 |
| D-107 | 一期 MCP 工具不审批：所有权限模式下直接运行，不受命令规则约束；内置审批策略按 `origin()` 放行，钩子链照常执行；`readOnlyHint` 和 `parallel_tools` 只用于并发 | 先把注册与调用做好；以后加审批只改审批策略，内核其余部分不动 | §9 |
| D-108 | 结果中文本和图片直通，其余内容换成简短说明，只有 `structuredContent` 时用它的 JSON；之后照常裁切 | 模型拿到能用的内容；大结果仍然可以取回 | §8.4 |
| D-109 | 工具调用默认超时 300 秒，服务器每报一次进度重新计时；中断和超时都向服务器发送取消通知 | MCP 工具常常代替用户做一整件事，很多服务器不报进度；服务器能及时停下工作 | §8.2 |
| D-110 | 子智能体拿到父的全部工具，只去掉 `spawn_agent`、`send_message`；每棵智能体树一个 `McpManager`，子智能体共用根的连接；常驻服务里每个会话各自连接 | 子智能体的能力与父相同（D-42），新增的工具自动继承，不维护白名单；会话之间隔离有状态的服务器 | §5.1 §10 |
| D-111 | 自研最小客户端 finx-mcp，复用 finx-rpc 和 finx-llm 的 HTTP 客户端；官方 SDK 只作测试依赖；一期只声明 roots 能力 | 客户端所需很少；与 D-28 一致；少一层类型转换 | §13 |
| D-112 | stdio 服务器从空环境开始，只加白名单里的基本、代理、证书变量，再加 `env_vars` 列出的和 `env` 里写明的；工作目录默认会话工作目录 | 服务器在启动时运行、不经审批，常是运行时下载的第三方包，环境里的密钥不该默认交给它们；需要的变量照惯例在 `env` 里写明 | §5.7 |
| D-113 | 服务器的 `instructions` 原文放在系统提示词最后的 MCP 段，每个服务器一段、最多 16 KB；MCP 段与冻结的基础提示词分开记录（`system_prompt` 条目的 `mcp` 字段）；finx 不为 MCP 添加其他提示词 | instructions 是服务器写给模型的使用说明，其余信息已经在工具定义里；分开记录让基础提示词在恢复时照旧沿用 | §6.6 |
| D-114 | 新增 `mcp_server_status` 事件，快照带服务器状态；ACP 接受 stdio 与 http 两种服务器，声明 `mcpCapabilities.http`；原生协议的 `session/new`、`session/resume` 新增 `mcp_servers` | 客户端能看到状态、能带来自己的服务器 | §11 |
| D-115 | 断开或崩溃的服务器在下一次调用它的工具时重连一次，同一服务器两次重连至少间隔 30 秒；配置错误不重连；`tools/call` 从不自动重发 | 不用常驻的重启逻辑也能从偶发的崩溃中恢复；有副作用的调用不会执行两次 | §5.5 §8.2 |
| D-116 | 模型拿不了的内容（音频、二进制资源、当前模型不接收或过大的图片）保存到会话数据目录并给出路径；错误结果一定带文字 | 内容不丢，模型还能用 bash 处理；没有错误标记的线协议上，模型也能看出这是错误 | §8.4 |
| D-117 | 调用前先确认：服务器正在连接就等它，断开就重连一次；工具仍在服务器的当前列表里；参数是对象（null 当作 `{}`） | 工具集合在请求之间才替换，期间服务器的列表可能已经变了；不合法的调用不发给服务器 | §8.1 |
| D-118 | 项目根目录的 `.mcp.json` 默认不读；`mcp.project_json = true` 时在受信任的项目中读取；`--mcp-config <file>` 可以单次显式加载任意同格式文件 | 这个文件属于别的工具，其中的服务器会在启动时自动运行、调用也不审批，不应默认生效；需要时一个开关即可 | §4.1 §4.5 |
| D-119 | MCP 工具默认按需加载（deferred），分目录、定义、调用三层；单个服务器可以设为 direct，也可以只让少数常用工具常驻（`direct_tools`）；不按工具数量自动切换 | 上百个连接器也不占满窗口；不用为了决定暴露方式先连上所有服务器；模型的行为不随装了几个服务器而变 | §7.1–§7.3 |
| D-120 | 目录是系统提示词里的 `<mcp_servers>` 段，每个服务器一行（名字和一句话说明），整段最多 4 KB；内容只来自配置（二期加上目录缓存），会话中途不改 | 不依赖连接状态，第一次请求不必等，请求前缀从第一次请求起就固定 | §7.4 |
| D-121 | `tool_search(query, server?, limit?)` 在本地用 BM25 搜 deferred 服务器的工具，结果给出限定名、描述和参数 schema，只追加在历史里；服务器的 instructions 只附一次；已经给过定义的不重复给 | 定义按需进入上下文，用过的才占 token；不改动请求前缀 | §7.5 |
| D-122 | `call_tool(name, arguments)` 执行搜到的工具；界面显示目标工具，并发跟随目标工具（`Tool::kind_for`） | openai-chat 没有中途声明工具的办法，把搜到的工具加进工具列表会让前缀的缓存每次都失效；经它调用，工具列表与系统提示词整个会话不变 | §7.6 |
| D-123 | 厂商原生支持中途声明工具时，由适配器把搜索结果换成原生格式，模型直接调用搜到的工具；内核的三层结构不变 | 有原生能力的厂商能得到更自然的调用和按 schema 约束的参数，且缓存不受影响；差异只在 finx-llm | §7.7 |
| D-124 | `tool_search` 只给 `server` 时，工具不超过 100 个就每个一行（名字和描述的第一句）；超过 100 个只给全部名字（去掉共同前缀，逗号分隔） | 实测中模型常先列出整个服务器：313 个工具带描述约 20 KB；起初只列前 100 个（约 6.6 KB），按名字排在后面的正确工具被截掉，模型先试了两个无关的工具；改为只给名字后约 4.8 KB，三次新会话都直接找到了正确的工具 | §7.5 |
| D-125 | 第一次确定时的 warning 汇总带 `code: mcp_servers_not_ready`，包括失败的 deferred 服务器 | 不显示服务器状态的客户端（ACP）也能知道哪个服务器不可用；显示状态的客户端按 code 去重 | §11.1 |
| D-180 | 远程服务器的鉴权分三种：OAuth 登录、令牌（写在请求头里）、不需要鉴权。令牌方式不另设配置项，就是 `headers` 加凭据引用（二期） | 用户看得懂：服务商给的是账号登录还是一串 API Key，选对应的一项；比"先选不登录、再去填请求头"直接 | §4.3 §13.6 |
| D-181 | OAuth 用授权码加 PKCE（只接受 S256），按 RFC 9728 和 RFC 8414 发现，请求带 `resource`；回调在 127.0.0.1 的随机端口；令牌存钥匙串的 `mcp-oauth.<名字>`，与服务器地址绑定（二期） | 这是 MCP 授权规范的要求；桌面应用没有服务端，本机回调是原生应用的标准做法；令牌留在用户自己的电脑上 | §13.8.1 |
| D-182 | 客户端身份的顺序：用户配置的应用 → finx 的客户端元数据文档 → 动态注册（结果按 issuer 存在本地复用，`invalid_client` 时才重新注册）→ 请用户填（二期） | 与 MCP 规范的顺序一致；实测主流服务器已经支持元数据文档，所有用户共用一个身份；动态注册不复用会在登录服务上堆出大量注册，已有产品因此用光了用户的应用数额度 | §13.8.2 §13.8.6 |
| D-183 | finx 在自己的域名下公布一份客户端元数据文档，地址永远不变，只登记本机回调；`mcp.client_metadata_url` 只给测试和自建分支改用（二期） | 地址就是身份，换了等于换应用；文档不含密钥，成本只有一个静态文件 | §13.8.3 |
| D-184 | 支持旧版 HTTP+SSE 传输：`transport = "sse"`、地址以 `/sse` 结尾、或探测时 POST 回 400/404/405 而 GET 收到 `endpoint` 事件；探测的结论写进配置；`endpoint` 不能指向别的主机（二期） | 还有不少服务器只支持旧版；写进配置之后正式连接不必每次都猜；限制主机防止把令牌送去别处 | §13.7 |
| D-185 | 添加服务器先探测、后写入：远程三步（连接、登录设置、登录服务），本地三步（启动、握手、列出工具），都有进度；探测不写文件；失败时由用户决定是否仍然添加。`finx mcp add` 同样先探测，`--force` 才在失败时写入（二期） | 不把连不上的服务器悄悄写进配置；默认值来自服务器公布的设置，用户不必知道它用哪种鉴权 | §13.6 §12.2 |
| D-186 | 令牌快过期或收到 401 时刷新一次；刷新取跨进程锁，刷新后再读一次钥匙串；403 `insufficient_scope` 改为需要登录并记下 scope（二期） | 命令行、常驻服务和多个会话可能同时用同一个令牌；与模型连接的刷新规则一致 | §13.8.4 |
| D-188 | 服务的 logo 先用服务器在握手里声明的 `icons`，再找网站的图标（首页的 `icon`、`apple-touch-icon`、网页应用清单、`/favicon.ico`），都没有就显示首字母（v1.4） | 声明的图标是 MCP 的标准做法，最准；还很少有服务器声明，网站图标几乎都有；按浏览器的标准做法找，不用猜文件名 | §13.9 |
| D-189 | 图标按 MCP 规范的安全要求处理：只接受 https 和 `data:`，跳转不离开服务所在的站点，不带凭据，按内容判断类型，限制大小和像素，SVG 不能含脚本、事件和外部引用（v1.4） | 图标来自不受信任的服务器和网站；不带凭据、不离开站点，就不会把用户的信息带给第三方 | §13.9 |
| D-190 | 图标在探测和检查时找，存在 `~/.finx/mcp/icons`，按服务的标识存，一周后重找；不写进配置，会话和列表都不发请求（v1.4） | 列表要快，也不该因为显示一个图标去联网；logo 是派生出来的，用户的配置里不该有它 | §13.9 |
| D-191 | 图标显示在白底图块上，深色和浅色主题都一样（v1.4） | 网站图标大多是为浅色页面画的，深色底上会看不见 | §13.9 |
| D-192 | 服务的标识：远程看规范化后的地址（含查询参数），本地看命令行（不算 `-y`）；环境变量、请求头、凭据不算。内核和桌面端用同一套规则（v1.4） | 用户关心的是"连的是不是同一个服务"，与名字和令牌无关；查询参数可能指向另一个工作区，所以保留 | §13.10 |
| D-193 | 同一个服务只连一次：桌面端一输入就提示并禁止连接，编辑时同样检查；`finx mcp add` 拒绝，`--force` 例外（v1.4） | 两份相同的工具只会让模型困惑；命令行给熟悉配置的人留一个出口，比如同一个服务的两个账号 | §13.10 |
| D-187 | 不把令牌放在远端，不做"用到时再登录"（二期） | finx 没有也不需要自己的服务端，令牌留在本机更简单也更可信；中途登录要会话停下等用户，等有需要时再做（Q-118） | §13.8.5 |

### 19.2 待定问题

| 编号 | 问题 | 当前倾向 | 章节 |
|---|---|---|---|
| Q-100 | 常驻服务里多个会话是否共用同一个服务器进程 | 暂不。共用能省内存，但有状态的服务器会被多个会话同时操作，工作目录和 roots 也不同；以后可以对声明为无状态的服务器按"配置相同、工作区相同"共用 | §5.1 |
| Q-101 | MCP 工具很多时是否延迟加载 | 已定：默认按需加载（D-119–D-122） | §7 |
| Q-102 | OAuth 令牌存放在哪里 | 已定（D-181）：钥匙串的 `mcp-oauth.<名字>`，与服务器地址绑定 | §13.8 |
| Q-103 | 是否提供手动重连 | 二期提供 `Op::McpReconnect { server }`，桌面端的"重新连接"按钮用它；一期靠下一次调用时的自动重连（D-115） | §5.5 |
| Q-104 | elicitation 怎么交给用户 | 二期；复用审批通道，事件带上表单的 schema | §16 |
| Q-105 | resources、prompts 是否提供给模型 | 二期提供列出和读取资源的两个工具，只在有服务器声明 resources 时出现；prompts 作为界面命令，三期 | §16 |
| Q-106 | 客户端带来的服务器是否写进会话日志，让 `finx resume` 也能恢复 | 否：可能带有密钥。ACP 的 `session/load` 会再次带来，原生协议的 `session/resume` 也可以带 | §4.4 |
| Q-107 | 桌面端如何管理服务器（增删改、启停、查看工具） | 随桌面端设计；一期桌面端可以按会话带来服务器，或者直接编辑配置文件 | §11.4 |
| Q-108 | 用户能否在自己的配置里关掉某个项目的服务器 | 暂不；可以用 `-c mcp_servers.<name>.enabled=false`，或者不信任这个项目 | §4.1 |
| Q-109 | 客户端能否经已有的连接提供 MCP 服务器（不另起进程） | 以后。ACP 已有一个不稳定的 `acp` 传输，MCP 消息走 ACP 连接本身；桌面端要把界面能力（例如在编辑器里打开文件）交给模型时，可以照此在原生协议上做，作为 finx-mcp 的第三种传输 | §11.3 |
| Q-110 | 以后给 MCP 加审批时，是否按工具注解决定（只读的不问，破坏性的总问，其余询问） | 一期不审批（D-107）。按注解能少问很多次，但审批的依据是服务器的自我声明 | §9.2 |
| Q-111 | 以后给 MCP 加审批时，能否"以后都不再问"（把 allow 规则写进配置文件） | 与 bash 的三档审批（这一次、本会话、以后都允许）一并决定：先定持久的规则写在哪里 | §9.2 |
| Q-112 | 是否缓存服务器的工具目录，让第一次请求不必等服务器启动 | 二期做。键为服务器配置的指纹、工作区和协议版本；用 OAuth 或动态请求头的远程服务器不缓存；缓存的目录不带只读注解，在实际连上之前这些工具不并行；实际的工具列表不同时，按 §5.4 替换 | §5.3 |
| Q-113 | 何时支持 MCP 的 2026-07-28 版本 | 等支持它的服务器多起来再做。它对注册和调用的流程没有影响，只改变握手和调用中途要用户输入的方式；常驻服务里共用服务器进程（Q-100）需要它 | §13.2 |
| Q-114 | 有状态的服务器能否给每个会话各开一份，而不是根和子智能体共用 | 先共用（§10）。遇到问题再加一个按服务器的选项 | §10 |
| Q-116 | 是否让模型写脚本调用工具（沙箱里批量调用、过滤结果，只把脚本输出交回上下文） | 以后再评估。它最省 token，但要内置沙箱化的脚本运行时，模型还得写对代码；先看通用做法跑起来之后的瓶颈 | §7.10 |
| Q-117 | 哪些厂商、哪些模型走原生的中途声明工具 | 随 openai-responses 适配器和 Anthropic 官方端点的实测确定。DeepSeek 的两种端点都不支持，一直走通用做法 | §7.7 |
| Q-118 | 是否支持"用到时再登录"：先不带凭据连接，用到需要登录的工具时再请用户登录 | 暂不（D-187）。等有服务器只对部分工具要求登录时，复用审批通道，让会话停下来等用户登录 | §13.8.5 |
| Q-119 | 客户端元数据文档放在哪个地址 | 用户有自己的域名，地址待定；定下来以后永远不改（D-183） | §13.8.3 |

## 附录 A：配置示例

`~/.finx/config.toml`：

```toml
[mcp_servers.everything]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-everything"]

[mcp_servers.docs]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "DOCS_TOKEN"
tool_timeout_secs = 900                  # 这个服务器的工具常要跑很久

```

命令行临时加一个服务器、关掉另一个：

```bash
finx exec --mcp-config ./ci-mcp.json -c mcp_servers.docs.enabled=false "..."
```

## 附录 B：事件流示例

一个配置了两个服务器的会话，`docs` 启动失败：

```
session_started
mcp_server_status   { server: "docs", state: "starting" }
mcp_server_status   { server: "everything", state: "starting" }
task_started        { task_id: "t1" }
message_completed   (user)
mcp_server_status   { server: "docs", state: "failed", error: "connection refused", elapsed_ms: 12 }
mcp_server_status   { server: "everything", state: "ready", tools: 11, elapsed_ms: 1840 }
warning             { message: "MCP server 'docs' is unavailable: connection refused" }
turn_started        { task_id: "t1", turn: 0 }
...
tool_started        { name: "mcp__everything__echo", category: "other", title: "everything: echo" }
tool_running
tool_completed
...
task_completed
```

## 附录 C：给模型的文本

按 D-16 使用英文。三段文本在整个会话里固定不变。

**目录段**（系统提示词最后，§7.4）：

```
<mcp_servers>
Tools of these MCP servers are not in your tool list. Find them with tool_search, then run them with call_tool.
- github: Issues, pull requests and code search on GitHub
- docs: Internal API documentation
</mcp_servers>
```

**tool_search**（§7.5）：

```json
{
  "name": "tool_search",
  "description": "Search the tools of the MCP servers listed in <mcp_servers> and return their definitions. Those tools are not in your tool list: run them with call_tool. With `server` and no `query`, lists all tools of that server.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Keywords, or a tool's full name." },
      "server": { "type": "string", "description": "Only search this server." },
      "limit": { "type": "integer", "description": "Maximum number of tools to return (default 5, at most 20)." }
    }
  }
}
```

**call_tool**（§7.6）：

```json
{
  "name": "call_tool",
  "description": "Run an MCP tool found with tool_search.",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "The tool's full name, e.g. mcp__github__create_issue." },
      "arguments": { "type": "object", "description": "Arguments matching the tool's parameters." }
    },
    "required": ["name", "arguments"]
  }
}
```

**一次搜索的结果**（示意）：

```
Server github: <这个服务器的 instructions，第一次出现时才有>
- mcp__github__create_issue: Create a new issue in a repository.
  {"type":"object","properties":{"owner":{"type":"string"},"repo":{"type":"string"},"title":{"type":"string"},"body":{"type":"string"}},"required":["owner","repo","title"]}
- mcp__github__search_issues: Search issues and pull requests.
  (definition shown earlier)
```
