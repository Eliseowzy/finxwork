# finx 通信协议设计

| 项 | 内容 |
|---|---|
| 版本 | v0.26 |
| 日期 | 2026-11-05 |
| 状态 | 三期均已实现，端到端测试与压测通过（§11.1） |
| 关系 | 扩展 technical-design.md §8（对外协议）。§8.1–§8.4 中 Op、Event 的定义继续有效，本文只做增量补充 |

## 目录

- 0. 阅读说明
- 1. 目标与原则
- 2. 总体架构
- 3. 服务层（finx-server）
- 4. 编解码与性能
- 5. 内核侧改动
- 6. 原生协议
- 7. ACP 兼容
- 8. 传输与常驻服务
- 9. 安全
- 10. 配置与命令行
- 11. 实施计划
- 12. 测试与基准
- 13. 备选方案与取舍
- 14. 决策与待定问题

## 0. 阅读说明

- **术语**：沿用 technical-design.md §2。本文新增的术语如下：

| 术语 | 定义 |
|---|---|
| 服务层 | 在一个进程里承载多个会话、多个客户端连接的一层，即新 crate finx-server |
| 连接 Connection | 一个客户端与服务层之间的消息通道。每个连接使用一种协议 |
| 投影 Projection | 把内核事件直接编码成某种协议消息的那一步。本文有两种投影：原生协议和 ACP |
| 会话中枢 SessionHub | 服务层里每个已加载会话对应的后台任务，负责分发事件、维护会话镜像 |
| 会话镜像 SessionMirror | 会话中枢根据事件流维护的会话当前状态，用来生成快照 |
| 接入 Attach / 断开 Detach | 连接开始 / 停止接收某个会话的事件。断开不影响会话本身 |
| 快照 Snapshot | 接入时拿到的会话当前状态，与之后的事件按 seq 严格衔接 |

- **编号**：本文的决策与待定问题接续总方案的编号（D-21 起、Q-22 起），并同步登记到 technical-design.md §19、§20。
- **代码块**：Rust 定义是接口草图，derive、可见性等细节在实现时补齐。

变更记录：

| 版本 | 日期 | 说明 |
|---|---|---|
| v0.1 | 2026-10-28 | 初稿：服务层、原生协议、ACP 兼容、传输与常驻服务、性能预算、实施计划 |
| v0.26 | 2026-11-05 | 超长消息（§4.4、§4.8，technical-design D-445）：一超过上限就报错，不再等这一行结束；错误带上请求的 `id`（认得出时）；`server.max_frame_bytes` 默认值由 32 MiB 提到 128 MiB，依据见 §4.4。长行的读缓冲不再靠 `realloc` 增长 |
| v0.25 | 2026-11-05 | 定时任务（routine-design.md §8，已实现），都在版本 2 之内、由 capabilities 的 `routines` 声明：方法 `bots/routine`、`bots/routine_runs`、`bots/routine_run`、`bots/routine_set_enabled`、`bots/routine_run_now`、`bots/routine_stop`、`bots/routine_delete`；`BotSummary` 增加 `routines`、`routines_error`；`MailKind` 增加 `routine`，`MailInfo` 增加 `routine_id`；错误码 −32043 `routine_not_found`、−32044 `routine_busy`、−32045 `routines_unavailable`。新建和修改只走对话，没有方法 |
| v0.24 | 2026-11-05 | 撤回重发（message-resend-design.md），版本 2 之内，由 capabilities 的 `message_resend` 声明：新 Op `resend`、新事件 `session_rewound`、warning code `resend_rejected`（§6.11）。ACP 不变 |
| v0.23 | 2026-11-05 | 联网搜索（web-search-design.md §6.4，已实现），都在版本 2 之内：方法 `web_search/status`（调用过的连接也会收到 `config/changed`）、`web_search/test`、`web_search/set_key`；`credentials/*` 接受 `web-search.` 前缀；`web_search` 工具结果的 `details` 见该文 §5.6 |
| v0.22 | 2026-11-04 | 子智能体的确认转给用户（subagent-design v2.3），版本 2 之内：`agent_event` 也转 `approval_requested`、`approval_resolved`；新 Op `agent_approval`；快照 `agents[].active_task.approvals`；列表的 `awaiting_approval` 和 Bot 的 `waiting` 算上子智能体的问题；ACP 转成 `session/request_permission`。`BotSummary.helpers` 改名 `agents_working` |
| v0.21 | 2026-11-04 | 通知（notification-design.md），都在版本 2 之内：`BotSummary` 增加 `failed`、`muted`，`bots/update` 增加 `muted`。没有新方法 |
| v0.20 | 2026-11-04 | Bot（bot-design.md §4，已实现），都在版本 2 之内、由 capabilities 的 `bots` 声明：方法 `bots/subscribe`、`bots/unsubscribe`、`bots/create`、`bots/update`、`bots/avatar`、`bots/open`、`bots/read`、`bots/unread`、`bots/clear`、`bots/delete`，通知 `bots/changed`；错误码 −32040 `bot_not_found`、−32041 `bot_default`、−32042 `bot_invalid`。Bot 的会话不进 `session/list`、`sessions/subscribe` 和 `sessions/changed` |
| v0.19 | 2026-11-02 | 两个浏览器并存（desktop/connectors-entry-design §3.4、§9），版本 2 之内：`approval_requested` 和快照里的待审批项（PendingApproval）新增可选的 `own_browser`，为 true 时这次调用落在用户自己的浏览器里（用的是用户的真实登录状态），桌面端据此写"在你的浏览器里"；为 false 时不出现在 JSON 里，旧客户端忽略即可 |
| v0.18 | 2026-10-30 | 模型不可用（desktop-design §7 P15），都在版本 2 之内：`session/new` 要的模型所属服务商不存在（例如本机连接已断开或删除）时，返回新错误码 −32022 `model_unavailable`，data 带 `provider`，不再是 invalid_params；引用格式不对仍是 invalid_params |
| v0.17 | 2026-10-30 | 无项目会话，都在版本 2 之内：`session/new` 的 `cwd` 改为可选，省略时会话没有项目，内核在 `~/.finx/chats/` 下为它新建一个空文件夹作为工作目录，不向上查找项目根、不读项目配置；SessionSummary 增加 `no_project`；`skills/list` 两个参数都不给时，返回无项目会话能找到的 Skill（§6.4） |
| v0.16 | 2026-10-30 | 上下文明细（technical-design §7.5.8），都在版本 2 之内：新增方法 `session/context`，返回已加载会话的 ContextReport；新增事件 `context_reported`（`/context` 的答复）；`skills/list` 的内置命令多了 `context`；ACP 把 `/context` 的明细作为 `agent_message_chunk` 发出 |
| v0.15 | 2026-10-30 | 思考强度（model-catalog-design §18）：`ThinkingLevel` 新增 `default`、`on`、`xhigh`，`default` 是默认值；`ModelSummary.thinking_levels` 是模型提供的服务商档位（不含 `default`，模型不能指定推理时为空），新增 `default_thinking`（这个模型的起始档位）；`set_model` 不带 `thinking` 时按切换规则决定档位，带了就记住它；ConnectionModel 新增 `thinking`、`default_thinking`（账号连接提供的档位与起始档位） |
| v0.14 | 2026-10-30 | 模型目录与发现（model-catalog-design.md §8，已实现），都在版本 2 之内、由 capabilities 的 `model_discovery` 声明：`models/list` 只列有凭据的服务商的模型（默认模型例外），ModelSummary 增加 `shown`、`known`、`deprecated`、`released`、`cost`，`thinking_levels` 按服务商取值去重；ProviderSummary 增加 `listing`；新增 `models/refresh`、`models/show`；`auth/set` 先验证密钥，返回 `verified`，被拒绝时返回新错误码 −32021 `key_rejected`；ACP 的模型选项只给菜单里显示的模型 |
| v0.13 | 2026-10-29 | Skill 2d（skill-design.md v1.5 §6.3.5），都在版本 2 之内：`message_completed` 与 TranscriptItem 的用户消息由 `skill` 改为 `skills: [SkillUse]`（SkillUse 是 `{name, path}`，替换 SkillInvocation），消息本身是用户的原话；`skills/list` 的 `commands` 里 Skill 的名字是 `skill:名字`，带 `cwd` 时也返回 `commands`；ACP 的 `available_commands_update` 同样列出 `skill:名字`，提及可以在 prompt 文本的任意位置，内嵌资源的文字不参与识别（§6、§7.4） |
| v0.12 | 2026-10-29 | 没有回复的子智能体汇报（§6.10）：MailInfo 新增 `no_reply`。这时汇报正文只是写给模型的一句说明，客户端改用自己的文字；这一轮的 `agent_status` 也不带 summary |
| v0.11 | 2026-10-29 | 复杂场景压测（technical-design §1.4）：§8.2 服务记录写进锁文件后不等落盘就开始监听，落盘改在监听之后进行，服务从启动到可以连接由约 9 ms 降到约 5 ms |
| v0.10 | 2026-10-29 | MCP 一期（mcp-design.md v1.1 §11），都在版本 2 之内：新事件 `mcp_server_status`，快照新增 `mcp_servers`（§3.3、§5.1、§6.6）；warning code 新增 `mcp_servers_not_ready`；`session/new`、`session/resume` 新增可选的 `mcp_servers`（§6.4）；ACP 声明 `mcpCapabilities.http`，接受 `session/new`、`session/load`、`session/resume` 带来的 stdio 与 http 服务器，其他传输跳过并发 notice（§7.2、§7.3） |
| v0.9 | 2026-10-29 | 子智能体（subagent-design §15 二期的一部分），版本 2 之内，由 capabilities 的 `agents` 声明：事件 `agent_event` 转发子智能体自己会话里改变对话的事件，`agent_status` 增加 `elapsed_ms`；快照增加 `agents`（AgentSnapshot：状态、用时、汇报开头、用量，以及它自己的对话与正在运行的任务）；TranscriptItem 的 message 增加 `mail`；Op `agent_interrupt`；会话镜像记下每个子智能体（§3.3）；子智能体工作期间 SessionSummary 的 state 为 running（§6.10） |
| v0.8 | 2026-10-29 | Skill 二期（skill-design.md v1.3），都在版本 2 之内：`Op::Prompt` 新增可选的 `commands`；`message_completed` 与 TranscriptItem 的用户消息带 `skill`，`compaction_completed` 带 `kept_skills`；新增方法 `skills/list`（§6）；ACP 打开会话后发 `available_commands_update`，`/compact` 与 `/名字` 由内核的命令表处理（§7.4） |
| v0.7 | 2026-10-29 | 服务并发压测与优化（technical-design §1.4）：§4.8 补充通道里的消息装箱、连接读缓冲按流量伸缩、服务空闲时归还内存；新会话的日志文件推迟到第一次有实际内容时创建，`session/list` 照常列出本服务中还没写出日志的会话（§6.4、§7.3）；常驻服务启动时提高打开文件数的软上限，监听时要系统允许的最长接收队列，客户端连接被拒时先退避重试（§8.2）；会话数达到上限时先卸载最久没用的会话，都在用才返回 `server_full`，默认上限由 64 提到 1000（§3.1、§6.7、§10.1）；§12.2 指向服务并发压测 |
| v0.6 | 2026-10-29 | 事件 `warning` 增加可选的 `code`（WarningCode，现有 `bypass_permissions`：会话以绕过权限开始、恢复或切换进去时发出），客户端按代码措辞与摆放，不认识的代码照旧显示 message（§5.1）。新增决策 D-55 |
| v0.5 | 2026-10-29 | 为桌面端集成补充（desktop-kernel-integration.md §9.3），都在版本 2 之内、由 capabilities 声明：会话列表推送 `sessions/subscribe` 与 `sessions/changed`，SessionSummary 增加 title、state、model、archived、task_started_at；`session/rename`、`session/archive`、`session/unarchive`，对应新 Op `set_title`、`set_archived` 与事件 `title_changed`、`archived_changed`；TranscriptItem 增加 `task_end`；`models/list` 增加 providers 与 defaults；`auth/set`、`auth/delete` 与凭据存储；常驻服务把服务记录写进锁文件（§8.2）。新增决策 D-37–D-39 |
| v0.4 | 2026-10-29 | 跟进权限模式改名（technical-design D-30，协议版本 2）：原生协议与 ACP 改用 PermissionMode（manual、accept-edits、bypass-permissions），参数与字段改名为 `permission_mode`，旧名作为输入别名；初始化只接受版本 2（§6.3）；ACP 配置项改为 `permission_mode`，"总是允许"按 proposed_rule 或 proposed_mode 生成（§7.6、§7.7）；快照的待审批项带上 proposed_mode |
| v0.3 | 2026-10-29 | 实现 `finx protocol schema`：协议类型派生 JSON Schema，导出文档的格式见 §6.9；仓库保存一份 `crates/finx-protocol/schema.json`，测试保证它与类型一致；端到端测试用它校验收发的每条原生协议消息 |
| v0.2 | 2026-10-28 | 按实现同步：发送队列在入队时就合并增量，溢出规则改为"单项计费有上限 + 持续 1 秒或超过 4 倍"（§3.6）；ACP 入站改用本地最小类型，官方 schema crate 只用于测试（§7.1、D-28）；新增测试用 crate finx-mock（§2.3）；补充实施状态与实测数据（§11.1、§12.2） |

## 1. 目标与原则

### 1.1 目标

| 编号 | 目标 | 含义 |
|---|---|---|
| G1 | 开放 | 兼容 ACP（Agent Client Protocol）。支持 ACP 的编辑器可以直接把 finx 当作 agent 使用 |
| G2 | 复用 | 自研客户端（包括以后的桌面端）通过协议使用同一个内核，不重新实现内核逻辑 |
| G3 | 性能 | 协议层不带来可感知的开销，每条使用途径都走最短的链路 |

### 1.2 原则

1. **内核契约不变**：进程内仍以 Op/Event 为唯一边界（D-02）。所有协议都建立在它之上，内核不感知协议的存在。
2. **投影，不是转换**（D-21）：协议消息直接从内核事件编码出来。
   - 每个事件在每种协议下最多序列化一次；
   - 不经过 `serde_json::Value` 之类的中间形式；
   - 不经过第二个进程。
3. **编码一次，多处复用**：同一事件的原生协议编码，由接入该会话的所有连接共享。
4. **按需编码**：没有连接需要的事件，不做编码。
5. **会话与连接解耦**：连接断开不影响会话。待审批项、正在生成的消息等状态属于会话，不属于连接。
6. **慢客户端只影响自己**：每个连接的发送缓冲都有明确上限，背压只作用在这一个连接上，内核和其他连接照常运行。
7. **可度量**：每条使用途径都有基准和预算（§12）。

### 1.3 不在本文范围

- 客户端（包括桌面端外壳）的技术选型。
- 网络传输（WebSocket）的细节，只预留位置（§8.3）。
- MCP 客户端本身（见 mcp-design.md；它在协议上的增量见 §3.3、§5.1、§6.4、§7.3）、远程鉴权。

## 2. 总体架构

### 2.1 使用途径

| 使用途径 | 链路 | 每个事件的序列化次数 | 额外进程 |
|---|---|---|---|
| `finx chat`、`finx exec`（文本） | 进程内 API | 0 | 无 |
| `finx exec --json` | 进程内 API → stdout | 1 | 无 |
| 编辑器 | stdio ⇄ `finx acp` → 服务层 → 内核 | 1（ACP） | 无 |
| 自研客户端，单连接 | stdio ⇄ `finx serve --stdio` → 服务层 → 内核 | 1（原生） | 无 |
| 自研客户端，常驻服务 | Unix socket ⇄ `finx serve --listen` → 服务层 → 内核 | 1（原生），所有连接共享 | 无 |
| 远程（以后） | WebSocket ⇄ `finx serve` | 同上 | 无 |

- 进程内路径完全不经过服务层，`finx chat`、`finx exec` 保持现状。
- `finx exec --json` 输出的每一行，与原生协议 `session/event` 通知里的 `event` 对象使用同一个序列化函数，内容逐字节相同。
- 两种协议都在内核所在的进程里编码。不存在"内核先输出一种 JSON，再由另一个进程翻译成另一种 JSON"的环节。

### 2.2 分层

```
客户端    finx chat/exec      编辑器              自研客户端                   脚本
            │                  │ ACP                │ 原生协议                    │ JSONL
传输      进程内           stdio（NDJSON）    stdio、Unix socket（NDJSON）     stdin/stdout
            │                  │                    │                            │
投影         —              ACP 投影            原生投影                     exec --json
            │                  └─────────┬──────────┘                            │
服务层       —                    finx-server                                    —
            │                            │                                       │
内核      ────────────── Kernel：Op 进，Event 出（finx-core）─────────────────────────
```

### 2.3 crate 划分

| crate | 职责 | 依赖 |
|---|---|---|
| finx-protocol | 已有的 Op、Event；新增事件字段（§5.1）、原生协议的方法参数与结果、快照类型（§6.6） | finx-llm |
| finx-rpc（新） | JSON-RPC 2.0 基础设施：消息类型、NDJSON 分帧读写、请求 id 与挂起表、取消、错误码。与具体协议无关，以后的 MCP 客户端也用它 | serde、serde_json、tokio、bytes |
| finx-server（新） | 服务层：会话管理、会话中枢与镜像、连接与发送队列、原生投影、stdio 与 Unix socket 传输 | finx-core、finx-protocol、finx-rpc |
| finx-acp（新） | ACP 投影：方法映射、事件编码、审批与停止原因的映射、配置项 | finx-server（官方 schema crate 只作测试依赖，§7.1） |
| finx-mock（新，只用于测试） | 可编排的模型服务：兼容 openai-chat 的流式接口，按提示词里的 `[[mock:场景]]` 指令回复，供端到端测试和压测使用 | tokio、serde_json |
| finx-core | 新增：按工作目录装配会话运行时（从命令行的 setup 迁入）；`Kernel::info`、`Kernel::transcript` | — |
| finx-cli | 新增 `finx serve`、`finx acp` | finx-server、finx-acp |

- 依赖仍然只能自上而下。finx-server 不依赖 finx-acp，ACP 通过 finx-server 提供的接口（§3.5）接入。
- 新代码只在 `finx serve`、`finx acp` 中运行，不做全局初始化，不影响本地命令的启动目标（technical-design §1.4）。二进制体积的增长在一期验收时测量。
- 对应 crate 落地时，同步更新总方案 §3.2 的 crate 表和 §17 的代码结构。

### 2.4 运行时模型

服务进程沿用每个进程一个 tokio 多线程运行时（technical-design §3.3）。在此之上：

| 对象 | 数量 | 职责 |
|---|---|---|
| Server | 每进程一个 | 会话表、连接表、共享的 ModelRegistry 与 ToolRegistry、服务配置 |
| 会话中枢 | 每个已加载的会话一个任务 | 消费内核事件，更新会话镜像，分发给接入的连接；串行处理接入、断开和 Op |
| 连接读任务 | 每个连接一个 | 解析入站消息并分发；耗时的请求另起任务处理 |
| 连接写任务 | 每个连接一个 | 独占协议状态，按队列顺序编码事件，写出响应与通知 |

通道：

| 通道 | 方向 | 容量 | 说明 |
|---|---|---|---|
| 内核事件通道 | 内核 → 会话中枢 | 无界 | 沿用 D-11，内核永远不会被阻塞 |
| 中枢控制通道 | 连接 → 会话中枢 | 有界，64 | 接入、断开、Op |
| 发送队列 | 会话中枢 → 连接 | 按字节设上限 | §3.6。中枢放入时从不等待 |
| Op 通道 | 会话中枢 → 内核 | 有界，64 | 沿用现有通道。中枢用 `try_send`，满了向客户端返回 overloaded |

## 3. 服务层（finx-server）

### 3.1 服务与会话管理

Server 维护一张已加载会话的表。

| 操作 | 做什么 |
|---|---|
| 新建 | 按工作目录装配运行时（§5.3），调用 `Kernel::start`，创建会话中枢，让发起请求的连接接入 |
| 恢复 | 会话未加载时调用 `Kernel::resume`；已加载时等同于接入。会话文件的独占锁保证一个会话同时只被一个进程打开（technical-design §9） |
| 接入 | 只对已加载的会话有效，不会触发加载 |
| 关闭 | 发送 `Op::Shutdown`，等内核把日志落盘、释放文件锁，再从表中移除 |
| 删除 | 会话必须未加载。会话日志移到 `~/.finx/sessions/.trash/`，可以手工恢复 |

- **会话表**：用同步锁保护，锁内不 await（technical-design §15）。同一会话的并发恢复只加载一次，后到的请求等加载完成后接入。
- **上限**：已加载的会话数达到 `server.max_sessions`（默认 1000）时，新建和恢复先卸载最久没用的会话，即没有连接接入、也没有运行中任务的会话；它的日志在磁盘上，之后可以再恢复。所有会话都在用时才返回 `server_full`（technical-design D-93）。
- **空闲卸载**：没有连接接入、也没有运行中任务的会话，空闲 `server.idle_session_secs` 秒后关闭，释放内存。日志留在磁盘上，之后可以再恢复。
- **审批**：服务层里的会话一律以 `interactive_approvals = true` 启动，由接入的客户端答复审批。没有客户端接入时的处理见 Q-22。

### 3.2 会话中枢

每个已加载的会话有一个中枢任务，它是这个会话在服务层里唯一的串行点：

```rust
loop {
    select! {
        Some(event) = kernel.next_event() => {
            mirror.apply(&event);                                  // 更新会话镜像
            let frame = Arc::new(EventFrame::new(&shared, event)); // 这里不编码
            for sub in &subscribers {
                if sub.filter.accepts(&frame.event) {
                    sub.queue.push_event(frame.clone());           // 从不等待
                }
            }
        }
        Some(cmd) = control.recv() => handle(cmd),                 // 接入、断开、Op
    }
}
```

- **接入在两个事件之间完成**：中枢根据镜像生成快照，把响应放进该连接的发送队列，再把连接加入订阅表。快照反映 seq ≤ S 的全部事件，之后这个连接只会收到 seq > S 的事件，不缺也不重。
- **新建与恢复**：发起方在中枢消费任何事件之前接入，快照的 last_seq 为 0，会话信息取自 `Kernel::info()`（§5.4）。发起方之后会收到包括 session_started 和启动警告在内的全部事件。
- **Op 也经过中枢**：中枢先做校验（连接是否已接入、审批是否仍在等待，§3.7），再用 `try_send` 交给内核。
- **编码不在中枢里做**：第一个需要原生编码的连接写任务完成编码，结果缓存在 EventFrame 上，其余连接直接复用（§4.2）。编码开销因此分散到各连接的写任务上，中枢只做分发。
- **会话结束**：内核事件流结束时，中枢通知所有接入的连接，然后退出。

### 3.3 会话镜像

镜像只根据事件流维护，不需要另外查询内核。恢复的会话另加加载时读到的历史（§5.4）。

```rust
pub struct SessionMirror {
    info: SessionInfo,                 // id、cwd、会话文件、模型、推理等级、权限模式、上下文窗口
    last_seq: u64,
    transcript: Vec<TranscriptItem>,   // 用户消息、助手消息、工具结果；内容是 Arc，与内核共享
    active_task: Option<ActiveTask>,   // 正在生成的消息、未完成的工具调用、待审批项
    usage: UsageTotals,
}
```

| 事件 | 镜像的变化 |
|---|---|
| session_started | 初始化会话信息与累计用量 |
| task_started、三种任务终止事件 | 建立、清除 active_task；累加用量 |
| turn_started | 更新轮次 |
| message_started、message_delta | 建立正在生成的消息，按 index 追加文本、推理、工具调用参数 |
| message_completed | 完整消息追加到 transcript，清掉正在生成的消息 |
| tool_started、tool_running、tool_progress | 登记工具调用，标记开始执行，保留最近 16 KiB 的进度输出 |
| tool_completed | 工具结果追加到 transcript，移出未完成列表 |
| approval_requested、approval_resolved | 登记、移除待审批项 |
| settings_changed | 更新模型、推理等级、权限模式、上下文窗口 |
| mcp_server_status | 更新这个 MCP 服务器的状态、工具数和错误 |

镜像里的消息与工具结果都是 `Arc` 克隆，不复制内容。额外的内存只有指针，以及正在生成的那一条消息。

### 3.4 接入与快照

接入的响应里带一个快照（类型见 §6.6）：

- **session**：会话元数据与当前设置；
- **last_seq**：快照对应的最后一个事件的 seq；
- **transcript**：最近 N 条记录（默认 100，用 `history_limit` 调整，最多 1000），附带向前翻页的游标；
- **active_task**：正在运行的任务，包括正在生成的消息（已收到的部分）、未完成的工具调用、待审批项；
- **usage**：累计用量；
- **mcp_servers**：各 MCP 服务器的最新状态（mcp-design §11.1）。

规则：

1. 客户端先应用快照，再按顺序应用之后的事件。
2. 更早的记录用 `session/history` 分页读取。中枢从镜像中提供，与快照保持一致。
3. **seq 的作用域是会话的一次加载**。会话被卸载后再恢复，seq 重新从 1 开始，session_started 标志新的一次加载。客户端重新接入时一律以新快照为准。
   `compaction_completed` 的压缩计数使用 `compaction_seq`；顶层 `seq` 始终是事件流水号，不能被压缩计数覆盖。

### 3.5 连接

连接建立时就确定了协议（原生或 ACP）。协议相关的逻辑分成读、写两半接入：

```rust
/// 读任务：解析入站消息并分发。不持有协议状态
pub trait Inbound: Send + Sync + 'static {
    fn dispatch(&self, msg: Incoming<'_>, ctx: &ConnCtx);
}

/// 写任务：独占协议状态，按队列顺序编码
pub trait Outbound: Send + 'static {
    fn encode(&mut self, item: &Outgoing, batch: &mut WriteBatch);
}

pub enum Outgoing {
    Event(Arc<EventFrame>),   // 会话事件
    Frame(Bytes),             // 已编码的响应、通知或出站请求
    Control(ControlItem),     // 只给写任务看的内部指令，例如 ACP 登记一个等待任务结束的提问
}
```

- **读写分离**：读任务和写任务各自运行，避免两端同时写满缓冲时互相等待。
- **协议状态只归写任务**：读任务不直接修改协议状态，而是把需要的变化作为 `Control` 放进同一个发送队列。这样状态变化与事件严格保持队列顺序，也不需要锁。
  - 例如 ACP 收到 `session/prompt` 时，读任务先放入"登记这个请求 id"，再把 Op 交给中枢。任务产生的事件因此一定排在登记之后。
- **耗时请求**（新建、恢复会话，ACP 的 `session/load` 回放）另起任务处理，结果作为 `Frame` 放回队列，读任务继续读下一条。

### 3.6 发送队列、合并与背压

每个连接一个发送队列。中枢放入时从不等待。写任务的循环是：

1. 等队列非空，一次取出当前所有项（上限 128 项或 256 KiB）。
2. **合并**：这一批里相邻且可以合并的事件合成一条（规则见下）。
3. **编码**：原生事件直接使用 EventFrame 上缓存的字节；合并产生的新事件就地编码。
4. 用一次 vectored write 写出整批，然后 flush。

**合并规则**：

- 可以合并的事件：
  - 同一会话、同一 message_id、同一种类、同一 index 的 message_delta（text、thinking、tool_call_args）；
  - 同一会话、同一 call_id 的 tool_progress。
- 只合并**相邻**的项，不跨越其他事件，所以任何两类事件之间的相对顺序都不变。
- 合并后的事件取最后一条的 seq 和 ts，文本按顺序拼接。**seq 仍然严格递增，但可能不连续**，客户端不能假设 seq 连续（technical-design §8.3 只保证严格递增）。
- 客户端初始化时声明 `coalesce: false` 的，不合并（例如需要逐条记录的调试工具）。

这个设计不需要定时器：

- 客户端跟得上时，写任务每次只取到一条，立即写出，不增加延迟；
- 客户端跟不上时，队列里自然积压，写任务一次取出多条并合并，写出的条数和字节都会减少。

**入队时合并**：除了写任务在一批之内合并，增量入队时如果能接上队尾那条增量，就直接追加到队尾，不新增一项。合并出的文本由这个队列独占，原地追加，一段很长的输出也只是逐次追加，不会反复复制。这样读得慢的客户端，积压只占文本本身的字节，收到的也是更少、更大的事件，解析起来更快，会自己追上。

**上限**：

- **计费**：积压按字节估算。单个事件最多按上限的 1/4 计费，所以一条很长的完整消息（例如 message_completed）不会让读得跟得上的客户端被误判；合并进队尾的文本按实际字节全额计入。
- **断开条件**：积压持续超过 `server.queue_hard_bytes`（默认 16 MiB）1 秒，或超过上限的 4 倍时，中枢把这个连接从该会话的订阅中移除，并发送 `session/detached`（reason 为 overflow）。
- 客户端重新接入即可拿到新快照。
- 只影响这一个连接对这一个会话的接入；内核、会话和其他连接都不受影响。

### 3.7 多客户端与审批

- 接入同一会话的任何连接都可以提交 Op，包括审批。
- **先答复者生效**：中枢收到某个 call_id 的审批后，把它记为"已答复、等待内核确认"。同一 call_id 再来的审批直接返回 `approval_not_pending`，不交给内核。
- 内核确认后发出 approval_resolved，所有接入的连接都会收到，各自关闭审批界面。
- **待审批项属于会话**：客户端断开后再接入，或者另一个客户端后来接入，都能在快照的 `active_task.approvals` 里看到并答复。子智能体的问题在 `agents[].active_task.approvals`，用 `agent_approval` 答复，规则相同；整棵树同一时刻只有一个问题（subagent-design §10.1）。
- 原生协议不使用服务端请求来做审批（D-24）。ACP 是单客户端、请求式的协议，由 ACP 投影转换成 `session/request_permission`（§7.6）。

### 3.8 会话生命周期

| 场景 | 行为 |
|---|---|
| `finx serve --stdio` 或 `finx acp` 的 stdin 关闭 | 关闭本进程的全部会话（日志落盘），然后退出 |
| 常驻服务的连接断开 | 只移除订阅，会话和任务继续运行 |
| 常驻服务收到 `server/shutdown` 或 SIGTERM | 不再接受新连接；向全部会话发送 shutdown（中断运行中的任务）；每个会话最多等 5 秒落盘（与 `Kernel::shutdown` 一致）；退出 |
| 会话空闲 | 见 §3.1 的空闲卸载 |

## 4. 编解码与性能

### 4.1 序列化规则

- **原生协议**：每个事件最多编码一次，与接入的连接数无关。合并产生的事件除外：它只在积压时出现，并且用 1 次编码替代了多次。
- **ACP**：每个事件在每个 ACP 连接上最多编码一次。ACP 连接通常只有一个（编辑器），不做跨连接缓存。
- **入站**：每条消息解析一次，不构造 `serde_json::Value`。
- 任何路径都不经过第二个进程。

### 4.2 原生事件帧

原生协议的事件通知是一行：

```
{"jsonrpc":"2.0","method":"session/event","params":{"session_id":"<id>","event":<EVENT>}}\n
```

- `<EVENT>` 就是 Event 的 JSON，与 `finx exec --json` 输出的一行相同。
- 每个会话预先算好前缀 `{"jsonrpc":"2.0","method":"session/event","params":{"session_id":"<id>","event":` 和后缀 `}}\n`。
- 编码一个事件：把 Event 序列化进可复用的缓冲区，再按精确长度一次分配出"前缀 + 事件 + 后缀"，存成 `Bytes` 缓存在 EventFrame 上（`OnceLock`）。
- 各连接的写任务直接写出这份 `Bytes`，没有任何按连接的编码工作。

```rust
pub struct EventFrame {
    pub session: Arc<SessionShared>,   // 会话 id 与预先算好的帧前缀
    pub event: Event,
    native: OnceLock<Bytes>,           // 原生协议的完整一行，第一次需要时编码
}
```

### 4.3 ACP 编码

- **出站热路径**（agent_message_chunk、agent_thought_chunk、tool_call_update）用借用视图直接序列化。例如 `AgentChunk<'a> { session_id: &'a str, message_id: &'a str, text: &'a str }` 直接从事件里借用字符串，写进发送缓冲，不构造 ACP 的所有权类型，也不复制字符串。
- **入站**请求量很小，直接反序列化成 agent-client-protocol-schema 中的类型。
- **一致性**：测试把每一种出站消息反序列化成 schema crate 的类型，必须成功，并且语义不变（§12.1）。借用视图因此不会偏离规范。
- ACP 需要的信息都在事件里（§5.1）。写任务只保存少量状态（例如各工具调用的标题），不读取会话镜像。

### 4.4 入站解码

- **两步解析**：先把一行解析成借用形式的信封 `RawMessage<'a> { id, method: Option<&'a str>, params: Option<&'a RawValue>, result, error }`，按 method 分发，再把 params 反序列化成具体类型。params 在分发之前不分配内存。
- 读缓冲按连接复用。
- 单条消息不能超过 `server.max_frame_bytes`（默认 128 MiB）。stdio 和 Unix socket、两种协议读的是同一段代码（`finx_rpc::FrameReader`），超过时：
  - 一过上限就返回 -32600，不等这一行结束。不写换行、一直写下去的客户端也能马上收到错误。
  - 这一行已读入的部分当即释放，后面到达的内容边读边丢，不占内存，也不再报错。读到换行后照常读下一行，连接继续可用。
  - 超限的消息不解析，也不会被截断后当成一条消息。错误的 `id` 取自行首 1 KiB：里面已经有 `id` 和 `method` 时（常见的 JSON-RPC 库都写在 `params` 前面）就是这条请求的 id，否则客户端只能一直等它的回复。认不出时为 null；通知和响应也是 null。
- 无法解析的行返回 -32700（id 为 null），连接继续可用。

**上限为什么是 128 MiB**（2026-11-05 查证）。入站消息里能变大的只有下面这些，其余都在 1 KiB 上下。恢复长会话的请求只带会话 id，大的是回复，这个上限只管入站。

| 消息 | 最大的合法大小 | 依据 |
|---|---|---|
| 带图片的提示词 | 每张图 6.67 MiB，张数不限 | 桌面端每张图原始大小不超过 5 MiB，base64 之后 6.67 MiB；其他文件只传路径。5 张满尺寸的图就是 33.3 MiB，原来的 32 MiB 放不下 |
| 同上，服务商的限制 | Claude API 128 MB，OpenAI 512 MB，Gemini 内联 20 MB | 各家文档（[Claude](https://platform.claude.com/docs/en/build-with-claude/vision)、[OpenAI](https://developers.openai.com/docs/guides/images-vision)、[Gemini](https://firebase.google.com/docs/ai-logic/input-file-requirements)）说的是一次请求的总量，历史也算在内 |
| `browser/cdp`：全页截图 | 文字页几 MiB；图片为主的长页约 50～130 MiB（估算） | PNG，区域限制在 4000×16000 CSS 像素（`finx-browser` 的 `screenshot`）。最坏 256 MiB 只出现在满屏噪点、宽 4000 的页面上 |
| `browser/extension` | 64 MiB | 本机程序收扩展消息的上限（`cmd_browser.rs` 的 `MAX_INBOUND`） |
| `files/write` | 30 MiB，一般 5 MiB 出头 | 文件面板只打开 5 MiB 以内的文本（`MAX_TEXT`）；JSON 转义最坏 6 倍（全是控制字符） |
| Bot 头像 | 1.4 MiB | PNG 不超过 1 MiB（`PNG_MAX`），base64 之后 |

128 MiB 放得下 Claude API 接受的最大请求（128 MB，即 122 MiB），约 19 张满尺寸的图，也放得下本表其余各项的常见情况。OpenAI 接受的更大的提示词和最坏情况的截图放不下，它们会收到明确的错误（截图是工具调用超时失败），需要时可调大这个配置。提高上限的代价只在真有这么长的内容时才付：内存按实际到达的数据占用。异常客户端最多占一个上限（约 138 MiB，macOS）；真实的 126.7 MiB 提示词能走完全程，3.7 秒，进程占到 646 MiB（行本身、解析出的字符串、日志、请求体各一份）。

### 4.5 写出

- 一批多条时，用 vectored write 一次写出，减少系统调用；只有一条时直接写。
- 不设定时器，不做延迟聚合（§3.6）。
- stdio 传输由写任务自己管理缓冲，每批 flush 一次。

### 4.6 事件过滤

接入时可以排除不需要的事件类别：

| 类别 | 包含的事件 |
|---|---|
| text_delta | message_delta 中的 text |
| thinking_delta | message_delta 中的 thinking |
| tool_call_delta | message_delta 中的 tool_call_start、tool_call_args |
| tool_progress | tool_progress |

- 被排除的事件不放进这个连接的队列。
- 某个事件没有任何连接需要时，它的原生编码根本不会发生（§1.2 第 4 条）。
- 快照不受过滤影响。

### 4.7 大内容

- **工具的完整输出**：工具结果本来就是截断后的文本，完整输出写在会话日志旁边的会话数据目录 `tool-output/<call_id>.txt`（technical-design §5.7、§9.1），路径在 bash 结果的 details 里。协议提供 `resource/read`，按需分段读取（§6.4）；事件流里不传完整输出。
- **图片**：v1 仍以 base64 内嵌在消息里（Q-25）。

### 4.8 内存

- 事件中与历史重复的大对象改用 `Arc` 共享（§5.1）。会话镜像、EventFrame、内核历史共用同一份数据，JSON 格式不变。
- 每个连接的发送队列有字节上限（§3.6）。
- 镜像中正在生成的消息和工具进度都有长度上限。
- 事件和会话中枢的命令在通道里装箱传递。通道按块分配槽位并一直保留，装箱后空闲会话的每个槽位只有指针大小（technical-design §3.3）。
- 连接的读缓冲从 4 KiB 起：读满就翻倍，最多 64 KiB；读不满就减半，空闲的连接缩回最小。写出批次的缓冲按需增长。
- 一行比读缓冲长时，缓冲跟着增长，到 4 MiB 为止用 `realloc`。再长就搬到一块新内存，只搬一次：默认上限下这块留够 128 MiB 加一次读取，页面用到才占。这一行取走后，后面的数据移回这块的开头，下一行接着用，所以碰过的页不超过最长的一行；缓冲读空时这块释放。4 MiB 以上不能用 `realloc`（D-445）：macOS 的分配器留着大块 `realloc` 换下来的脏块，有间隔地发 40 行 7 MiB 就留下 292 MiB，持续发 31 MiB 的行能到 3.1 GiB 以上。Linux 上没有这个问题。释放后的这一块仍可能留在分配器里等复用（macOS 上 `malloc_zone_pressure_relief` 对它无效），所以一行超长的内容之后，进程可能还占着约一行的内存，但不会再涨。
- 服务由忙转闲或会话变少时，请分配器把空闲内存还给系统（macOS 的 xzone 分配器不响应，见 technical-design Q-90）。
- 100–200 个会话的实测见 technical-design §1.4。

### 4.9 以后可选的优化

以下优化先不做，等一期基准给出实测数据再决定：

| 优化 | 收益 | 代价 |
|---|---|---|
| message_completed 的消息与会话日志条目共享同一份序列化结果 | 每条完整消息省一次序列化 | 日志格式与协议格式耦合 |
| `Delta::from_stream` 改为消费流事件，不再复制增量文本 | 每个增量省一次字符串复制 | 要改模型层到内核的接口 |
| 只有一个订阅者的会话，由中枢直接编码写出 | 每个事件省一次任务间转交（微秒级） | 多一条代码路径 |
| 保留最近事件的环形缓冲，重连时补发增量，不发完整快照 | 长会话重连更快 | 占内存，更复杂 |

## 5. 内核侧改动

### 5.1 事件补充

这些补充本身都是增量修改，旧客户端忽略新字段和新事件即可。协议版本现为 2：权限模式改名不是增量修改（technical-design D-30、§8.4），本文的补充随版本 2 一起发布。

| 事件 | 变化 | 用途 |
|---|---|---|
| session_started | 新增 `thinking`、`permission_mode`、`context_window`、`usage`（恢复的会话为历史累计，新会话为零） | 一次拿到全部设置；显示上下文用量 |
| settings_changed | 新增 `context_window` | 切换模型后更新上下文窗口 |
| tool_started | 新增 `category`、`title`、`locations` | 界面显示；ACP 的 kind、title、locations 直接取用 |
| tool_running（新） | `{ call_id }`，工具真正开始执行时发出 | 区分"等待审批或同批预检"与"正在执行" |
| task_completed | 新增 `reason`：`done`、`max_turns`、`output_limit`、`hook` | 区分正常结束与触顶；ACP 的停止原因 |
| tool_completed | `result` 改为 `Arc<ToolResultMessage>`，JSON 不变（需要打开 serde 的 rc 特性） | 与历史、镜像共享数据 |
| warning | 新增可选的 `code`（WarningCode）：`bypass_permissions` 在会话以绕过权限开始、恢复或切换进去时发出；`mcp_servers_not_ready` 在第一次模型请求前仍有 MCP 服务器不可用时发出；没有代码的 warning 不变 | 客户端按代码自己措辞、换语言、放在对话之外（桌面端的关键提醒卡片）；不认识的代码显示 message |
| mcp_server_status（新） | `{ server, state, tools, error?, elapsed_ms? }`：MCP 服务器开始连接、就绪、失败、关闭时发出（mcp-design §11.1） | 显示服务器状态；镜像据此维护快照的 `mcp_servers` |

```rust
#[serde(rename_all = "snake_case")]
pub enum ToolCategory { Read, Edit, Delete, Move, Search, Execute, Fetch, Other }

pub struct Location {
    pub path: PathBuf,            // 绝对路径
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,        // 从 1 开始
}

#[serde(rename_all = "snake_case")]
pub enum CompletionReason {
    Done,         // 模型不再需要继续
    MaxTurns,     // 达到 max_turns
    OutputLimit,  // 最后一条回复被输出上限截断
    Hook,         // 钩子要求结束
}
```

- `ToolCategory` 的取值是 ACP ToolKind 的子集，映射时只需改名。它与 finx-tools 内部用来加锁的 `ToolKind`（只读 / 修改）是两回事，所以另起了名字。
- tool_running 在放行的调用开始执行时发出（`run_tool` 入口）。technical-design §8.3 的工具事件顺序相应补充为：tool_started → approval_requested（如果需要审批）→ tool_running → tool_progress → tool_completed。被拒绝或未执行的调用没有 tool_running。

### 5.2 工具描述

Tool 接口新增一个带默认实现的方法：

```rust
pub struct ToolDescription {
    pub category: ToolCategory,
    pub title: String,            // 一行人类可读的描述
    pub locations: Vec<Location>,
}

trait Tool {
    /// 默认：category 为 Other，title 为工具名，没有 locations
    fn describe(&self, args: &Value, env: &dyn Environment) -> ToolDescription;
}
```

| 工具 | category | title | locations |
|---|---|---|---|
| read | read | `read <path>` | path 与起始行 |
| write | edit | `write <path>` | path |
| edit | edit | `edit <path>` | path |
| bash | execute | 命令本身（只取第一行，最长 200 字符） | — |

内核在发出 tool_started 之前调用 `describe`；路径用 `Environment::resolve` 转成绝对路径。

### 5.3 会话运行时装配

命令行的 setup（读取配置、判断项目根和信任、构建 KernelDeps）迁入 finx-core，成为按工作目录装配运行时的公共函数。命令行和服务层调用同一份代码：

- 服务进程启动时建立一次 ModelRegistry 与 ToolRegistry，所有会话共享（technical-design §3.3）；
- 每个会话按自己的工作目录解析项目配置与信任状态，D-17 不变；
- 未受信任的项目照常降级，并在会话里发一条 warning。

### 5.4 读取会话信息与历史

`Kernel` 新增两个方法：

```rust
/// 会话 id、工作目录、会话文件，以及当前的模型、推理等级、权限模式、上下文窗口
pub fn info(&self) -> SessionInfo;

/// 当前分支上的消息与工具结果，按时间顺序。只克隆 Arc，不复制内容
pub fn transcript(&self) -> Vec<TranscriptItem>;
```

会话中枢在新建或恢复之后、开始消费事件之前各调用一次，作为镜像的初始状态。此时还没有任何 Op 进入内核，所以与之后的事件严格衔接。

## 6. 原生协议

原生协议是 finx 自己的完整协议，面向自研客户端，完整暴露内核的能力。它是公开的：JSON Schema 由 `finx protocol schema` 导出，第三方可以据此实现与官方客户端同样完整的客户端。

### 6.1 传输与分帧

- **分帧**：NDJSON，每行一条 JSON-RPC 消息。UTF-8 编码，以 `\n` 分隔，消息内部不含换行（紧凑 JSON 本来就会转义换行）。
- **传输**：stdio（`finx serve --stdio`）与 Unix socket（`finx serve --listen unix://[PATH]`），见 §8。
- **不支持批量**：JSON-RPC 的批量数组返回 -32600。按行分帧本身就可以连续发送多条。

### 6.2 信封与约定

- 标准 JSON-RPC 2.0，带 `"jsonrpc":"2.0"` 字段。
- 请求 id 可以是整数或字符串，服务端原样返回。
- 参数和结果的字段名一律用 snake_case，与 Op、Event 一致。
- 未知字段忽略；未知方法返回 -32601；未知通知忽略。
- 一个连接可以同时接入多个会话。与会话相关的每条消息都带 session_id。

### 6.3 初始化与版本

1. 客户端的第一条消息必须是 `initialize`。在此之前的其他请求返回 `not_initialized`。
2. 客户端在 `protocol_version` 中给出自己支持的最高版本，服务端返回双方都支持的最高版本。没有共同版本时返回 -32602，data 中列出服务端支持的版本。
   - 服务端目前只支持版本 2，给出 1 的客户端会被拒绝：版本 2 改了权限模式的名字，按版本 1 理解的客户端会读错设置和事件。
3. 版本只在不兼容的修改时升级。同一版本内的新增能力通过 capabilities 声明。

### 6.4 方法

客户端 → 服务端（请求）：

| 方法 | 参数 | 结果 | 说明 |
|---|---|---|---|
| `initialize` | protocol_version、client_info、capabilities | protocol_version、server_info、capabilities | §6.3 |
| `session/new` | cwd?、extra_roots?、model?、thinking?、permission_mode?、mcp_servers?、events?、history_limit? | session_id、snapshot | 新建会话，发起的连接自动接入。省略 cwd 时会话没有项目：内核在 `~/.finx/chats/` 下新建一个空文件夹作为它的工作目录，列表里标为 `no_project`（v0.17）。mcp_servers 是客户端带来的 MCP 服务器，同名时替换配置里的（mcp-design §4.1） |
| `session/resume` | session_id、model?、thinking?、permission_mode?、mcp_servers?、events?、history_limit? | snapshot | 未加载时从磁盘恢复；已加载时等同于接入，此时不能带覆盖参数（包括 mcp_servers） |
| `session/attach` | session_id、events?、history_limit? | snapshot | 接入已加载的会话，不会触发加载 |
| `session/detach` | session_id | `{}` | 停止接收该会话的事件 |
| `session/op` | session_id、op | `{}` | 提交一个 Op，必须先接入。op 的 JSON 与进程内 API、`--ops-stdin` 完全相同 |
| `session/history` | session_id、before、limit? | items、before? | 分页读取更早的记录 |
| `session/context` | session_id | ContextReport | 已加载会话当前上下文的明细（technical-design §7.5.8）：用量、各部分、剩余与预留空间。内核在会话没有变化时直接返回上一份，可以频繁询问 |
| `session/list` | cwd?、cursor?、limit? | sessions、next_cursor? | 磁盘上的会话，以及本服务中还没写出日志的新会话（technical-design §9.3），附带在本服务中的加载状态。cwd 的匹配规则与 `finx sessions` 相同 |
| `session/close` | session_id | `{}` | 关闭会话：中断任务、日志落盘、释放锁 |
| `session/delete` | session_id | `{}` | 会话日志移入回收目录。会话已加载时先关闭（中断任务），再移入 |
| `resource/read` | uri、offset?、limit? | text、offset、eof、total_bytes | 分段读取工具的完整输出等大内容 |
| `models/list` | — | models、providers、defaults | models 与 `finx models --json` 同一份数据；providers 是每个服务商的认证方式与密钥来源（不含密钥本身）；defaults 是 `session/new` 省略设置时使用的模型、推理等级、权限模式。v0.14 起只列有凭据的服务商的模型，模型带 `shown`、`known`、`deprecated`，服务商带 `listing`（model-catalog-design §8.1） |
| `models/refresh` | provider?、catalog? | providers | 立即刷新服务商的模型列表，`catalog: true` 时同时刷新公共目录（model-catalog-design §8.2） |
| `models/show` | model、shown | `{}` | 在模型菜单里显示或隐藏一个模型（model-catalog-design §6.3） |
| `server/shutdown` | — | `{}` | 只用于常驻服务，优雅退出（§3.8） |
| `sessions/subscribe` | 同 `session/list` | 同 `session/list` | 返回第一页，之后这个连接收到 `sessions/changed`。先返回列表、再发变化，客户端不会先看到变化后看到旧列表 |
| `sessions/unsubscribe` | — | `{}` | 不再接收 `sessions/changed`；连接断开时自动取消 |
| `bots/*` | 见 bot-design §4 | 见 bot-design §4 | Bot 的登记、对话的打开（`bots/open` 的结果与 `session/new` 相同）、未读、清空与删除（v0.20） |
| `session/rename` | session_id、title | `{}` | 标题去掉首尾空白、合并成一行，最长 200 字符；空标题返回 invalid_params |
| `session/archive`、`session/unarchive` | session_id | `{}` | 归档或取消归档 |
| `auth/set` | provider、api_key | `{}`；v0.14 起 `{ verified, models? }` | 把服务商的 API 密钥存入凭据存储（D-39）。服务商不存在或不用 API 密钥认证时返回 invalid_params。v0.14 起先用列表请求验证密钥，被拒绝时不保存、返回 `key_rejected`（model-catalog-design §3.3） |
| `auth/delete` | provider | `{}` | 删除凭据存储里这个服务商的密钥；本来没有也算成功 |
| `skills/list` | session_id 或 cwd（二选一），或都不给 | skills、commands?、catalog?、enabled、warnings | session_id：已加载会话启动时的 Skill（按文件现在的内容描述）和输入 `/` 时能用的命令（CommandInfo：name、description、hint?、skill?，内置命令在前，Skill 的 name 是 `skill:名字`）。cwd：在这个目录新开会话会找到的全部 Skill、清单和命令，与 `finx skills --all --json` 相同。都不给：无项目会话会找到的，即用户自己的 Skill（v0.17）。见 skill-design §11.4 |

客户端 → 服务端（通知）：

| 方法 | 参数 | 说明 |
|---|---|---|
| `$/cancel_request` | id | 取消一个进行中的请求，适用于 session/new、session/resume、session/list、resource/read。被取消的请求返回 -32800。方法名与 ACP 相同 |

服务端 → 客户端（通知）：

| 方法 | 参数 | 说明 |
|---|---|---|
| `session/event` | session_id、event | 会话事件。event 的格式见 technical-design §8.2 与本文 §5.1 |
| `session/detached` | session_id、reason、last_seq | 服务端结束了这个连接对该会话的接入。reason 为 `overflow`、`closed` 或 `unloaded` |
| `bots/changed` | bots、deleted? | 发给调用过 `bots/subscribe` 的连接：变了的 Bot 的完整摘要，以及删除的 Bot（v0.20，bot-design §4） |
| `sessions/changed` | sessions、deleted? | 发给订阅了列表的连接：sessions 是变化了的会话的完整摘要，deleted 是被删除的会话 id |

原生协议没有服务端 → 客户端的请求。

**列表推送**（D-38）：会话被创建、加载、卸载、删除，任务开始与结束，审批出现与答复，设置改变，改名、归档，以及新会话的第一条用户消息（带来 preview）时推送。流式增量、工具进度、接入数变化不推送。同一份 `sessions/changed` 只编码一次，所有订阅者共用。

**改名与归档的落盘**：已加载的会话由会话中枢交给内核（Op `set_title`、`set_archived`，任何时候都可以提交，不受任务影响），内核把 title、archived 条目写进会话日志并发出 `title_changed`、`archived_changed` 事件；未加载的会话由服务层直接追加到日志末尾（持有日志的独占锁，会话正被其他进程打开时返回 session_busy）。

**一个 `session/op` 承载全部 Op**：载荷与进程内 API、`--ops-stdin` 完全一致，服务层不做任何字段映射；内核新增 Op 时，协议层不用改。Op 的执行结果通过事件反映（例如 set_model 之后的 settings_changed），与进程内 API 的语义相同。

### 6.5 事件的顺序与可靠性

- technical-design §8.3 的顺序保证全部保留，并补充三条：
  - 合并可能使 seq 不连续（§3.6）；
  - 不同会话的事件之间没有顺序保证；
  - 接入的响应一定早于该会话之后的任何事件；`session/detach` 的响应之后，不再收到该会话的事件。
- 事件只在连接存续期间投递，不做持久化重发。断线后重新接入，以快照为准。

### 6.6 类型定义

```rust
// ---- 初始化 ----
pub struct InitializeParams {
    pub protocol_version: u32,
    pub client_info: Option<PeerInfo>,
    #[serde(default)]
    pub capabilities: ClientCapabilities,
}

pub struct PeerInfo {
    pub name: String,
    pub version: Option<String>,
}

pub struct ClientCapabilities {
    /// 允许在积压时合并增量事件，默认 true（§3.6）
    #[serde(default = "default_true")]
    pub coalesce: bool,
}

pub struct InitializeResult {
    pub protocol_version: u32,
    pub server_info: PeerInfo,
    pub capabilities: ServerCapabilities,
}

pub struct ServerCapabilities {
    pub max_frame_bytes: u64,
    pub session_delete: bool,
    pub resource_read: bool,
    pub event_filter: bool,
}

// ---- 会话 ----
pub struct SessionNewParams {
    pub cwd: PathBuf,                        // 绝对路径
    #[serde(default)]
    pub extra_roots: Vec<PathBuf>,           // 额外的工作区根目录，绝对路径
    pub model: Option<String>,
    pub thinking: Option<ThinkingLevel>,
    pub permission_mode: Option<PermissionMode>,  // 旧名 approval_mode 作为别名
    #[serde(default)]
    pub events: EventFilter,
    pub history_limit: Option<u32>,          // 默认 100，最大 1000
}

pub struct EventFilter {
    #[serde(default)]
    pub exclude: Vec<EventClass>,            // text_delta、thinking_delta、tool_call_delta、tool_progress（§4.6）
}

pub struct SessionOpParams {
    pub session_id: String,
    pub op: Op,
}

// ---- 快照 ----
pub struct SessionSnapshot {
    pub session: SessionInfo,
    pub last_seq: u64,
    pub transcript: TranscriptPage,
    pub active_task: Option<ActiveTask>,
    pub usage: UsageTotals,
    pub mcp_servers: Vec<McpServerInfo>,     // 各 MCP 服务器的最新状态；没有服务器时省略
}

pub struct SessionInfo {
    pub session_id: String,
    pub cwd: PathBuf,
    pub session_file: PathBuf,
    pub model: String,
    pub thinking: ThinkingLevel,
    pub permission_mode: PermissionMode,
    pub context_window: u64,
}

pub struct TranscriptPage {
    pub items: Vec<TranscriptItem>,          // 按时间顺序
    pub before: Option<String>,              // 更早记录的游标（不透明字符串）；None 表示已到开头
}

#[serde(tag = "type", rename_all = "snake_case")]
pub enum TranscriptItem {
    Message { message_id: String, message: Message },               // user 或 assistant
    ToolResult { call_id: String, result: Arc<ToolResultMessage> },
}

pub struct ActiveTask {
    pub task_id: String,
    pub turn: u32,
    pub streaming: Option<PartialMessage>,   // 正在生成的助手消息
    pub tools: Vec<ToolState>,               // 未完成的工具调用
    pub approvals: Vec<PendingApproval>,     // 字段与 approval_requested 事件相同
}

pub struct PartialMessage {
    pub message_id: String,
    pub blocks: Vec<PartialBlock>,           // 按 index 排序
}

#[serde(tag = "type", rename_all = "snake_case")]
pub enum PartialBlock {
    Text { index: usize, text: String },
    Thinking { index: usize, text: String },
    ToolCall { index: usize, call_id: String, name: String, args_json: String },
}

pub struct ToolState {
    pub call_id: String,
    pub name: String,
    pub category: ToolCategory,
    pub title: String,
    pub args: Value,
    pub running: bool,
    pub progress_tail: String,               // 最近的进度输出，最多 16 KiB
}

// ---- 列表与资源 ----
pub struct SessionSummary {
    pub session_id: String,
    pub cwd: PathBuf,
    pub no_project: bool,                    // 没有项目：cwd 是内核为它新建的文件夹（v0.17）
    pub created_at: String,                  // RFC 3339
    pub updated_at: String,                  // 最后活跃：任务最近一次开始或结束的时间，没有任务时同 created_at；打开、关闭、改名、归档、改设置都不改变它
    pub preview: Option<String>,             // 第一条用户消息的开头
    pub title: Option<String>,               // session/rename 给的名字
    pub state: SessionState,                 // idle、running、awaiting_approval、failed（最后一个任务失败）
    pub model: Option<String>,
    pub archived: bool,
    pub task_started_at: Option<String>,     // 运行中任务的开始时间
    pub loaded: bool,                        // 已在本服务中加载
    pub busy: bool,                          // 正在运行任务
    pub attached_clients: u32,
}

// 快照的 SessionInfo 同样增加 title、archived；TranscriptItem 增加：
//   TaskEnd { task_id, outcome: completed | failed | interrupted, reason?, error?, usage?, ts }
// 新写入日志的任务条目带 reason 与 usage，更早的日志里没有这两项
//
// ServerCapabilities 增加四个布尔值（缺省为 false）：
//   sessions_subscribe、session_metadata、transcript_task_end、auth

pub struct ResourceReadParams {
    pub uri: String,                         // finx://tool-output/<session_id>/<call_id>
    #[serde(default)]
    pub offset: u64,
    pub limit: Option<u64>,                  // 默认 1 MiB
}

pub struct ResourceReadResult {
    pub text: String,
    pub offset: u64,
    pub eof: bool,
    pub total_bytes: u64,
}
```

### 6.7 错误码

原生协议与 ACP 投影共用一套错误码。应用错误的 `data` 一律带 `kind`（下表第二列），客户端可以按种类处理。

| code | kind | 含义 |
|---|---|---|
| -32700 | parse_error | 不是合法的 JSON |
| -32600 | invalid_request | 不是合法的请求，或超过单条消息上限 |
| -32601 | method_not_found | 方法不存在 |
| -32602 | invalid_params | 参数错误 |
| -32603 | internal_error | 内部错误 |
| -32800 | request_cancelled | 请求已被取消 |
| -32002 | session_not_found | 会话不存在（与 ACP 的 Resource not found 相同） |
| -32010 | not_initialized | 尚未初始化 |
| -32011 | session_busy | 会话已被另一个进程打开 |
| -32012 | session_not_loaded | 接入时会话未加载 |
| -32013 | not_attached | 提交 Op 前没有接入 |
| -32014 | prompt_in_progress | ACP：上一轮提问还没结束 |
| -32015 | approval_not_pending | 审批已被答复，或者不存在 |
| -32016 | server_full | 已加载的会话数达到上限，而且每个会话都有连接接入或任务在跑 |
| -32017 | overloaded | 内核的 Op 队列已满，稍后重试 |
| -32018 | unsupported_content | 不支持的输入内容，例如音频 |
| -32019 | session_closed | 会话已关闭 |
| -32020 | task_failed | ACP：任务失败，data 中带完整的 ErrorInfo |
| -32021 | key_rejected | `auth/set`：服务商拒绝了密钥 |
| -32022 | model_unavailable | 要的模型所属服务商不存在（本机连接已断开或删除），data 带 `provider` |
| -32040 | bot_not_found | 没有这个 Bot（v0.20） |
| -32041 | bot_default | 默认 Bot 不能删除；品牌标志只给默认 Bot 用作头像 |
| -32042 | bot_invalid | 名字为空或超过 20 字，头像取值不合规，或上传的不是 PNG |
| -32043 | routine_not_found | 这个 Bot 没有这个定时任务，或没有这次运行（v0.24） |
| -32044 | routine_busy | `bots/routine_run_now`：它已经在运行 |
| -32045 | routines_unavailable | 定时任务的数据库打不开；消息写明原因。服务和聊天不受影响 |

### 6.8 示例

`→` 为客户端发送，`←` 为服务端发送；事件省略了 ts 和部分字段。

```jsonl
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol_version":2,"client_info":{"name":"demo","version":"0.1.0"}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol_version":2,"server_info":{"name":"finx","version":"0.2.0"},"capabilities":{"max_frame_bytes":134217728,"session_delete":true,"resource_read":true,"event_filter":true}}}
→ {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/work/demo"}}
← {"jsonrpc":"2.0","id":2,"result":{"session_id":"0193f0c2-…","snapshot":{"session":{…},"last_seq":0,"transcript":{"items":[]},"usage":{…}}}}
← {"jsonrpc":"2.0","method":"session/event","params":{"session_id":"0193f0c2-…","event":{"seq":1,"type":"session_started",…}}}
→ {"jsonrpc":"2.0","id":3,"method":"session/op","params":{"session_id":"0193f0c2-…","op":{"type":"prompt","input":[{"type":"text","text":"跑一下测试"}]}}}
← {"jsonrpc":"2.0","id":3,"result":{}}
← {"jsonrpc":"2.0","method":"session/event","params":{"session_id":"0193f0c2-…","event":{"seq":2,"type":"task_started","task_id":"t1"}}}
← …（message_completed、turn_started、message_delta……）
← {"jsonrpc":"2.0","method":"session/event","params":{"session_id":"0193f0c2-…","event":{"seq":10,"type":"tool_started","call_id":"call_01","name":"bash","args":{"command":"cargo test"},"category":"execute","title":"cargo test"}}}
← {"jsonrpc":"2.0","method":"session/event","params":{"session_id":"0193f0c2-…","event":{"seq":11,"type":"approval_requested","call_id":"call_01",…}}}
→ {"jsonrpc":"2.0","id":4,"method":"session/op","params":{"session_id":"0193f0c2-…","op":{"type":"approval","call_id":"call_01","decision":{"type":"approve_for_session"}}}}
← {"jsonrpc":"2.0","id":4,"result":{}}
← …（approval_resolved、tool_running、tool_progress、tool_completed、turn_completed……）
← {"jsonrpc":"2.0","method":"session/event","params":{"session_id":"0193f0c2-…","event":{"seq":21,"type":"task_completed","task_id":"t1","reason":"done",…}}}
```

### 6.9 Schema 导出

`finx protocol schema` 把原生协议导出为一份 JSON Schema（draft 7），供其他语言的客户端生成类型（例如用 json-schema-to-typescript 生成 TypeScript）、在测试中校验消息。

- **来源**：finx-protocol 与 finx-llm 中的协议类型派生 `JsonSchema`（schemars），Schema 与实际的序列化格式由同一套 serde 属性决定。派生只生成导出时用到的代码，不影响运行时。
- **结构**：
  - `definitions`：每个类型一个定义，例如 `Event`（各种事件内联在其中，与 `seq`、`ts` 并列）、`Op`、各方法的参数与结果；
  - 根上的 `anyOf`：引用所有顶层类型（方法参数与结果、通知参数、`Event`、`Op`），生成工具据此为它们各生成一个类型；
  - `x-methods`：每个请求方法对应的参数类型和结果类型；
  - `x-client-notifications`、`x-server-notifications`：通知方法对应的参数类型；
  - `x-error-codes`：错误码与错误 data 中的 `kind`；
  - `x-protocol-version`：协议版本。
- **仓库中的副本**：`crates/finx-protocol/schema.json`。测试要求它与类型一致，协议有改动时用 `FINX_UPDATE_SNAPSHOTS=1` 重新生成，在评审中查看差异。
- **校验**：端到端测试用这份 Schema 校验 `finx exec --json` 的每一行，以及原生协议的初始化结果、快照、历史、列表、模型列表和会话中的每个事件。

### 6.10 子智能体（v0.9）

capabilities 的 `agents` 为 true 的服务提供以下内容，都是增量：

| 项 | 内容 |
|---|---|
| 事件 `agent_event` | `{agent_id, event}`：子智能体自己会话里的一个事件，seq 是子会话自己的。只转改变它对话的事件：task_started、turn_started、message_completed、stream_retry、tool_started、tool_running、tool_completed、approval_requested、approval_resolved、compaction_*、turn_completed、task_completed、task_failed、task_interrupted、warning；增量、工具进度、设置不转 |
| `agent_status.elapsed_ms` | 空闲状态带上这一轮工作的用时 |
| 快照的 `agents` | AgentSnapshot 数组，按启动顺序：agent_id、name、call_id、session_file、status、since（状态最近一次变化的时间，运行中即这一轮的开始）、summary、usage、error、elapsed_ms，以及它自己的 transcript 与 active_task（与 `history_limit` 一样截取）。只含这个服务加载会话之后启动的子智能体 |
| TranscriptItem 的 `mail` | 子智能体的汇报以 user 消息进入历史，带 MailInfo，客户端据此显示成汇报 |
| MailInfo 的 `no_reply`（v0.12） | 子智能体这一轮既没有回复也没有出错时为 true，比如还没回复就被停下；为 false 时省略。这时汇报正文只是写给模型的一句说明，客户端应显示自己的文字；`agent_status` 也不带 summary |
| Op `agent_interrupt` | `{agent}`（id 或名字）：只停这个子智能体当前的任务，它保留会话、之后仍可接收消息；不是运行中的子智能体时，会话发一条 warning |
| Op `agent_approval` | `{agent, call_id, decision}`：答复这个子智能体的 `approval_requested`，`agent` 是它的 id。已答复过或没有在等，返回 `approval_not_pending` |
| 会话列表 | 子智能体工作期间，SessionSummary 的 state 为 running，busy 为 true，task_started_at 从这段工作开始算起，直到 `idle` |

### 6.11 撤回重发（v0.24）

capabilities 的 `message_resend` 为 true 的服务提供以下内容，都是增量（[message-resend-design.md](message-resend-design.md)）：

| 项 | 内容 |
|---|---|
| Op `resend` | `{message_id, input, commands?}`：从当前分支上的一条用户消息重新开始。任务在跑就先停，对话回到这条消息之前，再发 `input`。结果都走事件 |
| 事件 `session_rewound` | `{message_id, removed_agents?, returned_input?}`：对话回到了 `message_id` 之前，它和它之后的内容不再属于对话。`removed_agents` 是随被撤回段关闭的子智能体，`returned_input` 是交还的排队输入。总在新消息之前发出；任务在跑时，先发它的结束事件 |
| warning code `resend_rejected` | 这次 `resend` 没有生效，会话不变，话还在客户端手里。原因：消息不在当前分支上或不是用户的、内容为空、内容是 `/compact` 或 `/context`、已有一个 resend 在等任务停下、Bot 的会话 |
| 会话镜像 | 把转录截到这条消息之前，去掉 `removed_agents`，重算失败状态；累计用量不减。"快照 + 之后的事件 = 从头接收"仍然成立 |
| 会话列表 | 回到第一条用户消息之前时预览清空，下一条成为新预览。未加载的会话靠日志里 `branch` 条目的 `before_first` |
| 历史分页 | 目标在已加载范围内时 `before` 游标仍然有效。不在范围内时，新消息可能和旧游标的下标重叠，客户端整体重新接入，不拼接 |

## 7. ACP 兼容

### 7.1 范围与版本

- **版本**：实现 ACP v1（protocolVersion 1）中 agent 一侧的方法。客户端要求更高版本时，按 ACP 的规则回复 1，由客户端决定是否继续。
- **v2 准备**：同时实现 v2 草案中必选的会话方法（session/list、session/resume、session/close）。v2 定稿后增加版本协商；v2 用带回放的 resume 取代 session/load，可以复用 §7.3 的回放实现。
- **保持标准**：不定义 finx 专属的 ACP 扩展方法或 `_meta` 字段（D-28）。自研客户端使用原生协议，不需要借 ACP 扩展拿到额外能力。
- **类型**：入站请求用 finx-acp 里的本地最小类型解析，只覆盖 finx 读取的字段。官方的 agent-client-protocol-schema crate（当前 1.13）只作测试依赖：单元测试保证本地类型能读官方类型接受的样例，端到端测试把智能体发出的每条消息反序列化成官方类型。
  - 不在运行时链接 schema crate：它强制打开 serde_json 的 `preserve_order`，会让整个程序的 JSON 对象从有序树换成插入顺序的哈希表，影响内核的内存与性能。
  - 也不使用官方 SDK crate：它在 2026 年 6 月 24 日、7 月 23 日、10 月 6 日先后发布了 1.0、2.0、3.0 三个主版本，变化太快。
  - 连接层使用 finx-rpc，与原生协议共用。
- **认证**：finx 的模型密钥来自环境变量与配置（technical-design §10），所以 `authMethods` 为空，不实现 `authenticate` 与 `logout`（返回 -32601）。
- **模式**：不提供 session modes（Q-26），设置通过配置项完成（§7.7）。

### 7.2 初始化与能力

`initialize` 的回复：

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "finx", "version": "0.2.0" },
  "authMethods": [],
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
    "mcpCapabilities": { "http": true, "sse": false },
    "sessionCapabilities": { "list": {}, "resume": {}, "close": {}, "delete": {}, "additionalDirectories": {} }
  }
}
```

- 客户端声明的能力记录在连接上：
  - `session.notices` 决定警告和重试信息是否以 notice 发出；
  - `session.compaction` 决定是否发送压缩进度；
  - `fs`、`terminal` 见 §7.9。
- 图片输入在提问时按当前模型的能力检查，模型不支持图片时返回 `unsupported_content`。

### 7.3 会话方法

| ACP 方法 | finx 的处理 |
|---|---|
| `session/new` | 新建会话，additionalDirectories 作为额外的工作区根目录。回复 sessionId 与配置项。mcpServers 里的 stdio 与 http 服务器交给会话，名字整理成合法且不重复的形式；其他传输跳过，并在客户端支持时各发一条 notice（mcp-design §11.3） |
| `session/load` | 恢复会话，把完整历史按顺序回放成 session/update，再回复配置项。回放规则见下。会话还没加载时使用带来的 mcpServers，已经加载时忽略 |
| `session/resume` | 恢复会话，不回放，回复配置项。mcpServers 的处理同 session/load |
| `session/list` | 列出磁盘上的会话和本服务中还没写出日志的新会话，支持 cwd 过滤与游标分页。title 取第一条用户消息的开头，updatedAt 取最后修改时间 |
| `session/close` | 关闭会话 |
| `session/delete` | 会话已在本进程加载时先关闭，再移入回收目录 |
| `session/prompt` | §7.4 |
| `session/cancel` | 发送 `Op::Interrupt` |
| `session/set_config_option` | §7.7 |
| `$/cancel_request` | 指向进行中的 session/prompt 时，等同 session/cancel；指向进行中的 session/load 时，停止回放并返回 -32800 |

session/load 的回放规则：

| 历史记录 | 回放成 |
|---|---|
| 用户消息 | user_message_chunk，每个内容块一条 |
| 助手的推理 | agent_thought_chunk（redacted 的跳过） |
| 助手的文本 | agent_message_chunk |
| 工具调用 | 一条 tool_call，带最终状态，以及按 §7.5 生成的内容 |

- `finx acp` 进程里的会话在进程退出时关闭。
- 恢复一个正被其他 finx 进程打开的会话，返回 `session_busy`。

### 7.4 提问与停止原因

收到 `session/prompt` 后：

1. 同一会话已有一轮在进行时，返回 `prompt_in_progress`。ACP 没有定义一轮进行中再提问的语义，所以不排队。
2. 内容转换成 finx 的用户输入（§7.8），提交 `Op::Prompt`。
3. 登记这个请求 id（§3.5 的 Control 项），等任务结束后按下表回复：

| 任务结束事件 | 回复 |
|---|---|
| task_completed，reason 为 done 或 hook | `{"stopReason":"end_turn"}` |
| task_completed，reason 为 max_turns | `{"stopReason":"max_turn_requests"}` |
| task_completed，reason 为 output_limit | `{"stopReason":"max_tokens"}` |
| task_interrupted | `{"stopReason":"cancelled"}` |
| task_failed | 错误 -32020（task_failed），data 为 ErrorInfo |
| session_closed（任务尚未结束） | 错误 -32019（session_closed） |

- ACP 的 `refusal` 在 finx 中没有对应的来源，暂不使用。
- ACP 要求这一轮的所有 session/update 都在回复之前写出。写任务按队列顺序处理，天然满足。
- prompt 的文本 ACP 层不做特殊处理：`Op::Prompt` 照常提交，由内核的命令表解析开头的 `/compact` 和任意位置的 `/skill:名字`（skill-design §6.3）；内嵌资源转成的文字不参与识别。输入的 `/compact` 没有可压缩的内容时也作为任务结束，这一轮照常得到 `end_turn`。
- `session/new`、`session/load`、`session/resume` 的回复之后，发一次 `available_commands_update`，列出内置命令和本会话可以用 `/skill:名字` 提及的 Skill（命令名 `skill:名字`）；Skill 的 `argument-hint` 作为 `input.hint`。这条通知总在打开会话的回复之后（skill-design §11.5）。

### 7.5 事件到 session/update

| finx 事件 | ACP |
|---|---|
| message_delta（text） | agent_message_chunk，messageId 为 message_id |
| message_delta（thinking） | agent_thought_chunk，messageId 为 message_id |
| message_delta（tool_call_start、tool_call_args） | 不发送。工具调用在 tool_started 时一次发出完整信息 |
| message_completed（user） | 本连接登记提问之后的第一条用户消息就是这次提问，不发送；其他来源（例如插话）发 user_message_chunk |
| message_completed（assistant） | 不发送，内容已经通过增量发出 |
| tool_started | tool_call：toolCallId、title、name、kind（即 category）、status 为 pending、locations、rawInput |
| tool_running | tool_call_update：status 为 in_progress |
| tool_progress | tool_call_update：content 为最近的输出（见下文的节流） |
| tool_completed | tool_call_update：status 按 is_error 取 completed 或 failed；content 见下表；rawOutput 为 details |
| approval_requested | session/request_permission 请求（§7.6） |
| approval_resolved | 由其他途径答复时（例如权限模式改成了 bypass-permissions），对挂起的 permission 请求发 `$/cancel_request` |
| turn_completed | usage_update：used 为这次请求的上下文 token 数（input + cache_read + cache_write + output），size 为上下文窗口，cost 为累计费用（价格未知时省略） |
| settings_changed | config_option_update |
| compaction_started、compaction_completed | 客户端支持时发 compaction_update（in_progress、completed），否则不发 |
| warning、stream_retry | 客户端支持时发 notice（warning、info），否则只写日志 |
| session_started、task_started、turn_started、message_started、session_closed | 不发送 |

tool_completed 的 content：

| 工具 | content |
|---|---|
| edit | 每处修改一个 diff：path 为绝对路径，oldText、newText 取自参数中的 old_text、new_text |
| write | 新建文件时一个 diff（省略 oldText，newText 为写入的内容）；覆盖已有文件时一段文本，例如 `Wrote 120 bytes` |
| bash | 一段文本：结果文本（已截断） |
| read | 不带 content，只靠 locations 显示 |
| 出错时 | 一段文本：错误信息 |

**进度输出的节流**：ACP 的 tool_call_update 中，content 是整体替换，不是追加。如果每条 tool_progress 都发完整的累计输出，总字节数会随输出长度按平方增长。所以 ACP 投影：

- 每个工具调用最多每 `acp.progress_interval_ms`（默认 100 ms）发一次；
- 每次只发最近 `acp.progress_tail_bytes`（默认 16 KiB）的输出；
- 工具结束时用最终结果替换。

这只影响编辑器里工具输出的刷新频率，不影响执行，也不影响原生协议。

### 7.6 审批

approval_requested 转换成 session/request_permission：
子智能体的问题（`agent_event` 里的 approval_requested）同样转换，`toolCallId` 为 `agent-{agent_id}/{call_id}`，标题前面写子智能体的标签，答复转成 `agent_approval`。

```json
{
  "sessionId": "0193f0c2-…",
  "toolCall": { "toolCallId": "call_01", "title": "cargo test", "kind": "execute", "status": "pending" },
  "options": [
    { "optionId": "approve", "name": "允许", "kind": "allow_once" },
    { "optionId": "approve_for_session", "name": "本会话总是允许 cargo test", "kind": "allow_always" },
    { "optionId": "deny", "name": "拒绝", "kind": "reject_once" }
  ]
}
```

| ACP 回复 | finx 的 ApprovalDecision |
|---|---|
| selected `approve` | Approve |
| selected `approve_for_session` | ApproveForSession |
| selected `deny` | Deny（不带附言） |
| cancelled | Abort |

- 只有"本会话总是允许"不止放行这一次时，才提供 `approve_for_session`：
  - 有 proposed_rule 时，名称写出规则，如上例；
  - 有 proposed_mode 时，名称写出要切换到的权限模式，例如"允许，并切换到'自动接受编辑'"；
  - 两者都没有时不提供这个选项，因为这时它与"允许"效果相同。
- finx 没有"本会话总是拒绝"，所以不提供 reject_always。
- 文案与命令行的审批提示一致（Q-15）。
- 按 ACP 的规定，客户端发送 session/cancel 时，会以 cancelled 答复挂起的审批。finx 把它当作 Abort，与随后的中断一起使任务以 cancelled 结束。

### 7.7 配置项

| id | category | 类型 | 取值 | 修改时提交的 Op |
|---|---|---|---|---|
| `model` | model | select | 已配置密钥的厂商下的模型，值为 `provider/model` | SetModel |
| `thinking` | thought_level | select | 当前模型支持的推理等级 | SetModel（模型不变，只改推理等级） |
| `permission_mode` | mode | select | manual、accept-edits、bypass-permissions | SetPermissionMode |

- `session/set_config_option` 提交对应的 Op 后，立即回复修改后的全部配置项。内核发出 settings_changed 时，如果结果与回复不同，再发一条 config_option_update。
- 配置项列表在会话新建、加载、恢复时随回复一起给出。
- 旧的配置项 id `approval_mode` 和旧的模式名仍可设置，按改名对照转换。

### 7.8 输入内容转换

| ACP ContentBlock | finx UserContent |
|---|---|
| text | Text |
| image | Image（mime_type、data） |
| resource（文本） | Text，包成 `<resource uri="…">内容</resource>` |
| resource（二进制） | 返回 unsupported_content |
| resource_link | Text：file:// 链接写成 `@<path>`，其他写原始 uri，由模型按需用 read 工具读取 |
| audio | 返回 unsupported_content |

### 7.9 客户端文件与终端

ACP 允许 agent 通过客户端读写文件（`fs/*`）、运行命令（`terminal/*`）。v1 不使用，所有工具都在本地执行（Q-23）。理由：

- 更快：本地文件访问没有往返。
- 沙箱、子进程环境变量的清理（technical-design §5.5）和 FileTracker 的修改检测照常生效。
- 编辑器会自己刷新磁盘上被修改的文件，tool_call 里的 diff 也能正常显示修改。

以后需要时，再加一个通过 ACP 读写文件的 Environment 实现（D-09 预留的扩展点），用配置 `acp.delegate_fs` 打开。

### 7.10 示例

```jsonl
→ {"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true}}}
← {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentInfo":{"name":"finx","version":"0.2.0"},"authMethods":[],"agentCapabilities":{…}}}
→ {"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/work/demo","mcpServers":[]}}
← {"jsonrpc":"2.0","id":1,"result":{"sessionId":"0193f0c2-…","configOptions":[…]}}
→ {"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"0193f0c2-…","prompt":[{"type":"text","text":"跑一下测试"}]}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"0193f0c2-…","update":{"sessionUpdate":"agent_message_chunk","messageId":"8b31d0e4","content":{"type":"text","text":"先运行测试。"}}}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"0193f0c2-…","update":{"sessionUpdate":"tool_call","toolCallId":"call_01","title":"cargo test","name":"bash","kind":"execute","status":"pending","rawInput":{"command":"cargo test"}}}}
← {"jsonrpc":"2.0","id":100,"method":"session/request_permission","params":{"sessionId":"0193f0c2-…","toolCall":{"toolCallId":"call_01","title":"cargo test","kind":"execute","status":"pending"},"options":[…]}}
→ {"jsonrpc":"2.0","id":100,"result":{"outcome":{"outcome":"selected","optionId":"approve_for_session"}}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"0193f0c2-…","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_01","status":"in_progress"}}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"0193f0c2-…","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_01","status":"completed","content":[{"type":"content","content":{"type":"text","text":"Exit code: 0\n…"}}]}}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"0193f0c2-…","update":{"sessionUpdate":"usage_update","used":30512,"size":1048576,"cost":{"amount":0.42,"currency":"CNY"}}}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"0193f0c2-…","update":{"sessionUpdate":"agent_message_chunk","messageId":"c2d4e6f8","content":{"type":"text","text":"12 个测试全部通过。"}}}}
← …（第二轮的 usage_update）
← {"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}
```

## 8. 传输与常驻服务

### 8.1 stdio

- `finx serve --stdio`（原生协议）与 `finx acp`（ACP）：stdout 只输出协议消息。日志写入日志文件（technical-design §13），不写 stdout。
- stdin 关闭即视为客户端离开（§3.8）。
- 每个进程只有一个连接。

### 8.2 Unix socket 与常驻服务

- **启动**：`finx serve --listen unix://[PATH]`。省略 PATH 时为 `$FINX_HOME/run/finx.sock`。
- **权限**：`run/` 目录 0700，socket 文件 0600。每个连接建立时检查对端进程的 uid（`peer_cred`），与服务进程不同的直接断开。
- **单实例**：启动时对 socket 旁的锁文件（默认 `run/finx.lock`）加独占文件锁。拿不到锁说明已有服务在运行，报错退出。拿到锁之后才清理残留的 socket 文件，再绑定。
- **服务记录**（D-37）：拿到锁之后，服务把一行 JSON 写进锁文件：`pid`、`version`、`protocol_version`、`socket`、`exe`、`started_at`。锁文件以不截断的方式打开，拿到锁之后才清空写入，所以启动失败的第二个服务不会抹掉运行中服务的记录。客户端无法握手时（协议版本不兼容、服务卡住）据此找到进程；退出时随锁文件一起删除。
  - 写入后不等落盘就绑定 socket，落盘（macOS 上约 4 ms）在开始监听之后由阻塞线程池完成。同一台机器上的读者不经落盘也能读到记录；机器断电时服务已不在，记录本来就过时（technical-design D-95）。
- **路径长度**：Unix socket 的路径有长度限制（macOS 为 104 字节）。超过时报错，提示用 `--listen` 指定一个短路径。
- **空闲退出**：`--idle-exit SECS` 表示在没有连接、也没有运行中任务的状态持续 SECS 秒后退出。默认不退出。
- **打开文件数**：服务启动时把打开文件数的软上限提到硬上限，最多 65536。每个会话要占日志文件和到模型的连接，每个客户端占一个连接；访达、launchd 和默认终端给的软上限只有 256（technical-design D-92）。
- **接收队列**：监听时向系统要最长的接收队列，macOS 默认 128，Linux 默认 4096。它只限制已经到达、服务还没来得及接收的连接，不限制同时在线的连接数。实测 1000 个连接同时发起，一个都没有被拒（technical-design §1.4）。
- **发现与拉起**（客户端一侧的约定）：客户端先连接默认路径；socket 文件不存在时以后台方式启动 `finx serve --listen unix://`，再重试连接（Q-27）。
  - socket 文件存在、连接却被拒（ECONNREFUSED 或 EAGAIN）时，可能是接收队列一时满了，也可能是服务退出后留下的旧文件。
  - 先退避重试，例如从 1 ms 起翻倍，累计等 2 秒；仍然被拒，再按服务不在处理。不要第一次被拒就报错。
- **多客户端**：每个连接独立初始化、独立接入会话，适用 §3.7 的规则。

### 8.3 WebSocket（预留）

网络传输留到以后再做。届时承载的仍是同样的 JSON-RPC 消息，只是分帧换成 WebSocket 帧。连接与鉴权的细节跟进 ACP 远程传输工作组的规范（目前是 Streamable HTTP 与 WebSocket 的草案）。本地不使用 WebSocket（D-27）。

## 9. 安全

- **本机访问控制**：只监听 Unix socket，靠文件权限和对端 uid 检查限定为同一用户。不监听 TCP。
- **输入限制**：单条消息有上限（`server.max_frame_bytes`，§4.4），超过上限的内容不保留；JSON 嵌套深度沿用 serde_json 的默认限制（128 层）。
- **资源读取**：`resource/read` 只能读取该会话数据目录下 `tool-output/` 里的文件，不能借此读取任意路径。
- **审批不可绕过**：两种协议都只能通过 Op 答复内核发起的审批。审批策略、受保护路径、项目信任（technical-design §11）对协议客户端一视同仁。
- **不传密钥**：事件与协议消息中不包含模型密钥；工具子进程的环境照常清理密钥变量。
- **删除可恢复**：`session/delete` 只把日志移入回收目录。
- **调试日志**：默认不记录消息内容，因为其中可能有代码。设置 `FINX_DEBUG_RPC=1` 时，把收发的每条消息写入日志文件，只用于开发排查。

## 10. 配置与命令行

### 10.1 配置项

新增两个配置段，只在用户配置中生效：

```toml
[server]
max_frame_bytes = 134217728     # 单条消息上限，128 MiB（依据见 §4.4）
queue_hard_bytes = 16777216     # 每个连接、每个会话的待发上限，16 MiB；超过则断开该接入
max_sessions = 1000             # 同时加载的会话数上限；满了先卸载最久没用的会话
idle_session_secs = 900         # 无人接入且空闲的会话，多少秒后卸载
history_limit = 100             # 快照默认带多少条记录

[acp]
progress_interval_ms = 100      # 工具进度的最短发送间隔
progress_tail_bytes = 16384     # 每次发送的进度输出长度
delegate_fs = false             # 是否通过客户端读写文件（Q-23）
```

### 10.2 命令行

| 命令 | 说明 | 阶段 |
|---|---|---|
| `finx serve [--stdio]` | 原生协议，stdio 上的单个连接（默认） | 一期 |
| `finx serve --listen unix://[PATH] [--idle-exit SECS]` | 原生协议，常驻服务 | 三期 |
| `finx acp` | ACP，供编辑器以子进程方式启动 | 二期 |
| `finx protocol schema` | 导出原生协议全部类型的 JSON Schema，包括 Op、Event、方法参数与结果 | 一期 |

- 以上命令都支持 `-c key=value` 覆盖配置。
- 在 Zed 等编辑器中，把 agent 的启动命令配置为 `finx acp` 即可。

## 11. 实施计划

"预估"按单人全职估算，与总方案 §18 的口径一致。

### 一期：服务层与原生协议（预估 2 周）

**范围**

- finx-protocol：事件补充（§5.1）、原生协议类型（§6.6）、Schema 导出；
- finx-tools：`Tool::describe` 及四个内置工具的实现；
- finx-core：运行时装配迁入、`Kernel::info` 与 `Kernel::transcript`、tool_running 与 CompletionReason；
- finx-rpc：分帧、信封、挂起表、取消、错误码；
- finx-server：会话管理、中枢、镜像、连接、发送队列与合并、原生投影、stdio 传输；
- finx-cli：`finx serve --stdio`、`finx protocol schema`；
- 基准程序，实测预算（§12.2）。

**验收标准**

1. 脚本化场景通过 `finx serve --stdio` 跑通：初始化 → 新建会话 → 提问 → 审批 → 完成，收发的消息与金样一致。
2. 中途接入的一致性测试通过（§12.1）。
3. 慢客户端测试通过：内核不被阻塞，内存不超过上限，合并后的文本与逐条接收的一致。
4. `finx exec --json` 的输出除新增字段外不变。
5. §12.2 的预算达标。未达标的项记录实测值和原因，修订预算后再进入二期。

### 二期：ACP（预估 1 周）

**范围**：finx-acp、`finx acp`、一致性测试。

**验收标准**

1. 所有出站消息都能反序列化为 agent-client-protocol-schema 的类型。
2. 在 Zed 中把 agent 的启动命令配置为 `finx acp`，用 deepseek-flash 完成一个真实任务：流式输出、工具调用与 diff 显示、审批、取消、会话列表与恢复都正常。
3. ACP 路径的附加延迟达到 §12.2 的预算。

### 三期：常驻服务与多客户端（预估 1 周）

**范围**：Unix socket 传输、单实例与残留清理、对端 uid 检查、空闲退出、`server/shutdown`、`resource/read`、`session/delete`、多客户端测试。

**验收标准**

1. 两个客户端同时接入同一会话，都能收到实时事件。同一审批先答复者生效，另一方收到 approval_resolved。
2. 客户端断开后任务继续运行；重新接入后快照正确。
3. 其他用户的连接被拒绝；socket 权限为 0600。
4. 已有服务运行时，第二个 `finx serve --listen` 报错退出；残留的 socket 文件能自动清理。

### 11.1 实施状态（截至 2026-10-28）

三期都已实现，代码在 `feat/protocol` 分支：

| 范围 | 状态 |
|---|---|
| 一期：事件补充、`Tool::describe`、`Kernel::info` 与 `Kernel::transcript`、运行时装配迁入 finx-core、finx-rpc、finx-server、`finx serve --stdio` | 已完成 |
| 二期：finx-acp、`finx acp` | 已完成 |
| 三期：Unix socket 常驻服务、单实例锁、对端 uid 检查、空闲退出、`server/shutdown`、`resource/read`、`session/delete`、多客户端 | 已完成 |
| `finx protocol schema` | 已完成（§6.9） |
| 在 Zed 中实测（二期验收第 2 项） | 尚未进行 |

**测试**：
- `cargo test --workspace` 全部通过，clippy 没有警告。
- 端到端测试启动真实的 `finx` 进程，模型由 finx-mock 扮演：`e2e_exec`（文本、JSON 事件、stdin 审批、重试、失败、截断、轮数上限）、`e2e_native`（stdio 全流程、错误输入、Unix socket 多客户端、跨进程的会话锁）、`e2e_acp`（权限、配置项、取消、并发提问、列表、加载回放、恢复、删除、不支持的输入），每条 ACP 消息都按官方 schema 校验。
- 压测见 §12.2。

### 以后

- WebSocket 传输（§8.3）；
- 编辑器接入常驻服务里的会话（Q-28）；
- ACP 通过客户端读写文件（Q-23）；
- 图片按引用传输（Q-25）；
- §4.9 的可选优化；
- 为自研客户端生成 TypeScript 类型。

## 12. 测试与基准

### 12.1 测试

| 范围 | 测试 |
|---|---|
| finx-rpc | 一次读到半条或多条消息；超长消息；非法 JSON 返回 -32700 后连接继续可用；非法请求；未知方法；整数与字符串 id 原样返回；取消 |
| 原生协议 | 用 ScriptedApi 驱动的金样测试：输入一组消息，输出与 `tests/fixtures/*.ndjson` 比对，方式与请求体快照相同（technical-design §4.15） |
| 快照一致性 | 在脚本化任务的每一个事件之后都尝试接入：快照加上之后的事件所重建的客户端状态，必须与从头接收的客户端相同 |
| 合并与背压 | 客户端暂停读取：合并后的文本与逐条接收的一致；seq 严格递增；不同类事件不交换顺序；超过上限时收到 session/detached |
| 多客户端 | 两个连接同时答复同一审批，只有一个生效；断开不影响任务 |
| ACP | 每种出站消息都能反序列化为 schema crate 的类型；脚本化场景的收发金样；取消时挂起的审批以 cancelled 答复、提问以 cancelled 回复；session/load 的回放 |
| 端到端 | 启动真实的 `finx serve --stdio`、`finx acp` 子进程，跑完整场景 |

### 12.2 基准与预算

- 压测在 `crates/finx-cli/tests/stress.rs`，启动真实的 `finx` 进程，模型由 finx-mock 扮演。`FINX_STRESS_SCALE` 控制规模（默认 1，跟随 `cargo test` 运行）。
- 场景混合：回显、长输出、推理、带时间戳的流、文件读写改、bash、并行写入；每个回复都校验内容。
- 阶段：单会话延迟探针；原生协议（Unix socket，一个连接一个会话，一半会话走审批）；原生协议（stdio，一个连接复用多个会话）；ACP（多个编辑器进程）；`finx exec --json`（多个短进程）；四条路径同时跑；慢消费者（停读的连接被断开、慢读的连接收到合并增量且文本完整）。
- 流式延迟：mock 在写出每个块之前记下时间戳，客户端按消息实际到达的时间计算。这条链路包含 HTTP 与 SSE 解析、内核、中枢、socket 和客户端的 JSON 解析，比 §1.2 的"附加延迟"更长。

实测（Apple 芯片的 macOS，release 构建，`FINX_STRESS_SCALE=4`；mock、测试客户端和所有 finx 进程在同一台机器上）：

| 阶段 | 提问数 | 吞吐 | 提问延迟 p50 / p99 | 流式延迟 p50 / p99 |
|---|---|---|---|---|
| 单会话延迟探针（块间隔 2 ms） | 5 | — | — | 120 µs / 382 µs |
| 原生协议 · Unix socket（64 个连接） | 384 | 195 个/秒 | 76 ms / 1.6 s | 318 µs / 9.3 ms |
| 原生协议 · stdio 复用（96 个会话） | 384 | 193 个/秒 | 131 ms / 1.8 s | 322 µs / 20.7 ms |
| ACP · stdio（24 个进程） | 192 | 179 个/秒 | 64 ms / 395 ms | 286 µs / 3.2 ms |
| exec --json（48 个进程） | 48 | 158 个/秒 | 170 ms / 294 ms | — |
| 四条路径同时 | 1008 | 321 个/秒 | 259 ms / 1.0 s | 433 µs / 79 ms |

- 共 2021 个提问全部正确完成，用时 13 秒。p99 的长尾来自同机的负载（bash 子进程、文件工具、几十个进程同时运行），单会话探针反映的是无争抢时的链路延迟。
- 慢消费者：读取正常的连接 657 ms 收完 512 KiB（约 5 万个增量）；慢读的连接收到约 4 万个合并后的增量，文本完整；停止读取的连接被断开，其余连接和会话不受影响。
- 尚未单独测量 §12.2 表中的"附加延迟"与每事件的分配次数。
- 新建会话的延迟、每个任务的 CPU、线程与内存另有并发压测（`finx-load`，100–200 个会话），见 technical-design §1.4。

| 指标 | 场景 | 初始预算 |
|---|---|---|
| 附加延迟 p50 / p99 | 原生协议，stdio 与 Unix socket，单连接 | ≤ 50 µs / ≤ 500 µs |
| 附加延迟 p50 / p99 | ACP，stdio | ≤ 50 µs / ≤ 500 µs |
| 每个事件的编码次数 | 原生协议，1 个与 10 个连接 | 1，与连接数无关 |
| 每个增量事件的堆分配 | 原生协议，编码阶段 | ≤ 2 次 |
| 吞吐 | 原生协议，单连接，增量事件 | ≥ 20 万条/秒 |
| 慢客户端 | 一个连接停止读取 2 秒 | 内核与其他连接不受影响；该连接占用不超过 queue_hard_bytes |
| 启动 | `finx serve --stdio`、`finx acp` 到能回复 initialize | ≤ 10 ms |

- **附加延迟**：从内核发出事件到客户端解码完成的时间，不含模型本身的延迟。
- 这些是初始预算，一期完成后按实测修订。

## 13. 备选方案与取舍

| 方案 | 结论 | 理由 |
|---|---|---|
| 二进制编码（MessagePack、CBOR、Protobuf） | 不用 | 客户端（包括网页）里 JSON 解析是原生实现，往往比二进制解码库更快；可读，好调试；ACP 本身就是 JSON |
| gRPC | 不用 | 依赖重，影响编译、体积和启动；不适合 stdio 子进程；服务端反向发请求不方便 |
| 本地使用 WebSocket | 不用（D-27） | 每次连接多一次 HTTP 升级握手，客户端发出的每一帧还要加掩码；换来的路径路由、压缩协商在本地用不上 |
| 原生协议用服务端请求做审批 | 不用（D-24） | 审批属于会话，不属于连接。用请求的话，断线、重连、多客户端都要额外处理重发和撤销 |
| 原生协议每种 Op 一个方法 | 不用（D-23） | 需要逐个映射；`session/op` 让协议层与 Op 的定义保持零映射 |
| 用独立进程把原生协议翻译成 ACP | 不用（D-21） | 多一个进程，每个事件多一次解析和序列化 |
| 使用官方 ACP SDK crate | 不用（D-28） | 主版本变化快；连接层与原生协议共用更省 |
| 把 ACP 作为唯一的对外协议 | 不用 | ACP 是单客户端、编辑器视角的协议，没有多客户端接入、快照、插话与追加、回退这些能力；全部塞进扩展字段会失去类型约束，还会被 ACP 的版本变化牵着走 |

## 14. 决策与待定问题

### 14.1 决策

| 编号 | 决策 | 理由 | 章节 |
|---|---|---|---|
| D-21 | 所有对外协议都是内核事件在同一进程内的投影：每个事件在每种协议下最多序列化一次，不经过中间形式，不经过第二个进程 | 协议层不增加可感知的开销（G3） | §1.2 §4 |
| D-22 | 新增服务层 finx-server：一个进程承载多个会话与多个连接，会话与连接解耦 | 多客户端、常驻服务、断线重连的基础（G2） | §3 |
| D-23 | 原生协议使用 JSON-RPC 2.0 信封，`session/op` 承载 Op，`session/event` 承载 Event；载荷与进程内 API、`exec --json`、`--ops-stdin` 完全相同 | 零映射；新增 Op、Event 不用改协议层 | §6 |
| D-24 | 原生协议的审批沿用"事件 + Op"，不使用服务端请求；ACP 投影将其转换为 session/request_permission | 审批属于会话，天然支持多客户端、快照和重连 | §3.7 §7.6 |
| D-25 | 接入会话 = 快照 + 增量。快照由会话中枢根据事件流维护的镜像生成，与 seq 严格衔接 | 中途接入与重连不缺事件，也不重复 | §3.2–§3.4 |
| D-26 | 每个连接一个按字节设上限的发送队列；积压时合并相邻的增量；超过上限只断开该连接对该会话的接入。内核事件通道保持无界 | 慢客户端只影响自己；跟得上时不增加延迟 | §3.6 |
| D-27 | stdio 与 Unix socket 都使用 NDJSON 分帧；WebSocket 只用于以后的网络传输 | 本地开销最小；stdio 与 socket 共用一套编解码 | §6.1 §8 |
| D-28 | ACP 入站用本地最小类型，官方 schema crate 只作测试依赖、用于一致性校验；连接层自研并与原生协议共用；出站热路径用借用视图直接序列化；不定义 finx 专属的 ACP 扩展 | 运行时不引入 schema crate 打开的 serde_json `preserve_order`；避开 SDK 的版本变化；不复制字符串；保持标准 | §4.3 §7.1 |
| D-29 | ACP 实现 v1，并实现 v2 草案中必选的会话方法（list、resume、close） | 兼容现有编辑器，为 v2 做好准备 | §7.1 |
| D-37 | 常驻服务把服务记录（进程号、版本、协议版本、可执行文件、启动时间）写进单实例锁文件，拿到锁之后才清空写入 | 客户端无法握手时也能找到进程；诊断"是谁拉起的、从哪里运行" | §8.2 |
| D-38 | 为桌面端补充列表推送、摘要状态、改名与归档、历史中的任务边界、默认设置与密钥状态，都在版本 2 之内由 capabilities 声明；改名、归档经 Op 进内核，未加载时由服务层追加日志 | 列表与历史需要；增量修改不升协议版本；元数据和其他会话数据一样只写在会话日志里 | §6.4 |
| D-39 | 凭据存储：配置、环境变量之后再查；macOS 用登录钥匙串（经 `/usr/bin/security`，密钥走标准输入），其他平台用 0600 的 `credentials.toml`；只有 `finx` 进程会安装存储，测试设 `FINX_CREDENTIAL_STORE=file` | 首次使用不需要写配置文件；钥匙串的访问控制绑在系统工具上，内核升级不触发授权弹框；测试不碰开发者的钥匙串 | §6.4 |
| D-55 | warning 带可选的 `code`，增量修改，不升协议版本 | 客户端不必比对英文原文就能认出提醒、换成自己的语言和样式 | §5.1 |

### 14.2 待定问题

| 编号 | 问题 | 当前假设 | 章节 |
|---|---|---|---|
| Q-22 | 没有客户端接入时出现审批怎么办 | 一直等待。待审批项在快照里，客户端接入后答复。可选：超时按拒绝处理 | §3.1 §3.7 |
| Q-23 | ACP 客户端支持 fs、terminal 时，是否把工具执行交给客户端 | v1 不交，全部在本地执行。以后可以用 `acp.delegate_fs` 打开文件读写的委托；终端委托暂不考虑 | §7.9 |
| Q-24 | 快照默认带多少条记录 | 100 条，可分页 | §3.4 |
| Q-25 | 图片是否改为按引用传输 | v1 以 base64 内嵌（同 Q-07） | §4.7 |
| Q-26 | 是否为只支持 session modes 的 ACP 客户端提供 modes | 否，只提供配置项 | §7.1 |
| Q-27 | 常驻服务由谁启动 | 客户端在 socket 不存在时以后台方式启动，配合空闲退出；登录自启以后再定 | §8.2 |
| Q-28 | 编辑器能否接入常驻服务里的会话 | 以后再做。届时 `finx acp --attach` 只在 stdio 与 socket 之间转发字节，服务进程为该连接使用 ACP 投影，编码仍只做一次 | §11 |
