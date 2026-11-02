# 自定义页：技能与连接器的管理方案

| 项 | 内容 |
|---|---|
| 版本 | v0.13 |
| 日期 | 2026-11-02 |
| 状态 | 一期已实现（§14.3 记下与本文不同的地方），待验收；v0.5 跟随 skill-design v1.6 的技能来源收敛（2e），已实现（skill-design §13.4）；v0.6 定下添加连接器的新流程（§10.9）和二期的 OAuth、旧版 SSE、探测（§6.3、§8.3），已实现（§14.3）；v0.7 去掉页面上的"范围"：新连接器一律写进用户配置，所有项目可用（DD-57）；v0.8 设置页改成分组表单（DD-58），已实现；v0.9 页面不再让用户选客户端身份（DD-59），已实现；v0.10 名称按 Tab 采用建议、连接器显示服务的 logo、同一个服务只连一次（DD-60–DD-62），已实现；v0.11 logo 按形态展示（§10.10，DD-63）、编辑配置改成与添加一致的设置页（§10.11，DD-64）、去掉"也可以粘贴一段 JSON 配置"的提示（DD-65），已实现；v0.12 连接器详情页改成一页到底（§10.12，DD-66），已实现；v0.13 从发现添加连接器时由用户选登录方式，目录只给推荐（§10.6，DD-67），已实现；v0.14 目录条目随应用带上服务商的 logo（§10.10，DD-68），已实现；v0.15 技能详情页改成与连接器详情页一致的一页到底，下面是文件树加打开的文件，Markdown 可以在预览和原文之间切换，新增 `skills/read`（§10.13，DD-69），已实现 |
| 原型 | [customize-demo.html](customize-demo.html)，最终版；添加连接器以 [connector-add-demo.html](connector-add-demo.html) 为准（§10.9），设置页的分组表单以 [connector-add-grouped-demo.html](connector-add-grouped-demo.html) 为准（DD-58）。包含二期的登录和"让打开的会话也用上"；本文另有几种状态没有单独画出：项目未受信任、被更高的层覆盖、令牌缺失 |
| 关系 | 落实 mcp-design.md 的 Q-107（桌面端如何管理服务器），连带 Q-102（OAuth 令牌放在哪里）、Q-103（手动重连）、Q-108（在自己的配置里关掉项目的服务器）、Q-112（工具目录缓存）；技能部分接续 skill-design.md §11.4 的 `skills/list` 和 Q-61（内置技能）。协议新增的方法在实现时同步登记到 protocol-design.md，内核一侧的决策登记到 technical-design.md |

## 方案摘要

- **分工**：
  - 桌面端只做界面：页面、发现目录、表单、引导。
  - finx 服务负责其余一切：技能和连接器存在哪里、怎么读写、怎么检测和登录。
  - 内核运行时照旧在会话启动时从文件加载。

  这与模型密钥（`auth/set`）、模型显隐（`models/show`）、模型连接（`connections/*`）是同一个做法。
- **一份真相**：就是 finx 本来就在读的文件：技能目录、`config.toml` 的 `[mcp_servers]` 和 `skills.disabled`、`skills.opt_in`、系统钥匙串。桌面端不另建清单，会话也不需要注入。在桌面加的东西，`finx exec` 和编辑器里同样能用。
- **页面只写用户自己的文件**：
  - 可写的是 `~/.finx/config.toml`、新增的个人项目层 `~/.finx/projects/<项目键>/config.toml`、`~/.finx/skills`；
  - 仓库里的 `.finx/config.toml`、`.mcp.json`、`.agents/skills`、`.claude/skills` 在页面上只读；
  - 仓库里的连接器可以"只对你关闭"，写在个人项目层，不影响队友。
- **协议**：服务新增一组方法，命令行的同名命令调用同一组函数。
  - **配置**：`config/read`、`config/write`。连接器的增删改、启停都只是一次配置写入。
  - **凭据**：`credentials/set`、`credentials/delete`，令牌存钥匙串。
  - **技能**：`skills/install`、`skills/remove`、`skills/set_enabled`、`skills/files`。
  - **连接器**：`mcp/list`、`mcp/tools`、`mcp/check`；二期加 `mcp/login`、`mcp/logout`、`mcp/apply`。
  - **通知**：`config/changed`、`skills/changed`、`mcp/changed`。
- **写入可靠**：
  - 用 toml_edit 保留手写文件的注释和格式；
  - 带版本号防并发覆盖，先校验再写；
  - 写入的值被更高的层盖住时如实告诉页面；
  - 删掉连接器时回收它的凭据。
- **密钥只进钥匙串**：令牌只在 `credentials/set` 经协议传一次。配置里写 `${credential:名字}` 引用，连接时由内核展开；OAuth 在服务里完成并负责续期。
- **状态**：
  - 连接器的"可用 · 38 个工具"优先取打开的会话里的实时连接，其次取工具目录缓存；
  - 打开页面不启动任何连接器进程，只在"检测"或刚添加时连一次；
  - 服务监视技能目录和配置文件，变化即通知页面。
- **内置技能**：基于 Anthropic 的 Finx 适配版 skill-creator（Apache-2.0）编译进 finx，首次扫描写到 `~/.finx/skills/.system`。"在对话中创建"直接用它。
- **发现目录**：精选技能和推荐连接器是桌面端的数据，一期随应用打包。推荐的连接器只是预填配置。
- **生效**：
  - 默认对之后新开的会话生效；
  - 二期，连接器可以由用户选择推到打开的会话，在下一次模型请求之前替换工具集合，代价是一次缓存未命中。
- **分期**：
  - 一期约 9.5 个工作日：内核与服务 6 天，桌面 3 天，验收半天，见 §14；
  - 二期：OAuth、推到打开的会话、在线目录、技能更新、用缓存加快会话启动。

## 目录

- 0. 阅读说明
- 1. 目标与范围
- 2. 现状
- 3. 总体设计
- 4. 数据与文件
- 5. 写入
- 6. 协议
- 7. 命令行
- 8. 连接器的状态、检测与登录
- 9. 技能的安装、删除与启停
- 10. 桌面端
- 11. 安全
- 12. 性能
- 13. 代码落点
- 14. 实施计划
- 15. 测试与验收
- 16. 决策
- 17. 待定问题
- 附录 A：放弃的做法
- 附录 B：配置示例

## 0. 阅读说明

| 术语 | 含义 |
|---|---|
| 技能 | 一个含 `SKILL.md` 的目录（skill-design §3）。界面叫"技能"，协议和代码里叫 skill |
| 连接器 | 一个 MCP 服务器的配置（mcp-design §4）。界面叫"连接器"，协议和代码里叫 mcp server |
| 我的、发现 | 页面的两个视图：当前项目里新开会话时会用到的东西；桌面端提供的精选技能和推荐连接器 |
| 层 | 配置的来源：用户配置、项目配置、个人项目层、`.mcp.json`、命令行 `-c`、客户端带来的 |
| 个人项目层 | `~/.finx/projects/<项目键>/config.toml`：只对自己、只在这个项目生效的配置（§4.3） |
| 用户自己的文件 | 用户配置、个人项目层、`~/.finx/skills` 下的技能。页面只写这些 |
| 内置技能 | 编译进 finx 的技能，首次运行时写到 `~/.finx/skills/.system`（§4.6） |
| 工具目录缓存 | 每个连接器最近一次连接的结果和工具列表（§4.8，即 mcp-design Q-112） |
| finx 服务 | `finx serve` 常驻进程（desktop-kernel-integration §0）。"内核运行时"指它跑会话的部分 |

- **编号**：
  - 本文的决策接续桌面端文档，从 DD-30 起；待定问题从 DQ-20 起。
  - 内核与协议一侧的决策在实现时登记到 technical-design.md 和 protocol-design.md，取新号段 D-160 起、Q-130 起。
  - 新错误码从 −32023 起（§6.7）。
- **数值**：大小上限、超时、节流间隔等都是初始值，实测后可调。

变更记录：

| 版本 | 日期 | 说明 |
|---|---|---|
| v0.1 | 2026-10-31 | 初稿：分工、数据位置、协议、发现目录、流程、分期 |
| v0.2 | 2026-10-31 | 改动如下：<br>• 改用通用的 `config/read`、`config/write`，加上 `credentials/*`<br>• 页面只写用户自己的文件<br>• 写入带版本号，并报告被更高的层覆盖<br>• 内置技能编译进 finx<br>• 服务监视文件<br>• 连接器的状态合并打开的会话<br>• 连接器改动可以推到打开的会话 |
| v0.3 | 2026-10-31 | 方向定为"服务管理、桌面只做界面"，全文按它细化：<br>• 补齐文件布局（§4.1）、个人项目层与项目键（§4.3）<br>• 补齐配置合并的改动和每个键的来源（§4.4），以及内置技能（§4.6）<br>• 补齐凭据引用的语法与回收（§4.7）、缓存格式（§4.8）<br>• 补齐写入流程（§5）、方法的完整类型和错误码（§6）<br>• 补齐状态合并与检测（§8）、安装细节（§9）<br>• 补齐桌面端的模块、数据流和"界面—方法"对照表（§10）<br>• 补齐实施计划（§14）<br>• 原型改到最终版；原 §3 的方案比较移到附录 A |
| v0.4 | 2026-10-31 | 一期实现后按实现修正：skill-creator 不由模型调用（§4.6）；`SkillsSetEnabledResult` 带 `file` 与 `removed_names`（§6.2）；锁文件的位置（§5.1）；实际的发现目录（§10.6）；实现记录（§14.3） |
| v0.5 | 2026-10-31 | 跟随 skill-design v1.6（2e）收敛技能来源：<br>• 仓库里的技能在 `.agents/skills`（默认启用）和 `.claude/skills`（默认不启用），不再有 `<项目>/.finx/skills`<br>• `~/.agents/skills`、`~/.claude/skills` 默认不读，`skills.other_apps` 打开<br>• 技能行的开关按默认状态写 `skills.opt_in` 或 `skills.disabled`（§9.3）<br>• SkillEntry 新增 `default_enabled`，页面据此写"默认不启用"（§10.4）<br>• 新增 DD-52 |
| v0.6 | 2026-10-31 | 添加连接器改成两步（§10.9，原型 [connector-add-demo.html](connector-add-demo.html)）：第一步只有名称和地址，地址可以是网址、命令或 JSON；远程地址先探测，再按探测结果给出鉴权设置，本地命令进入命令表单；所有路径先检查、后写入。新增 `mcp/probe`，`mcp/login` 可以在写入之前登录（§6.3、§8.3）；内核一侧的 OAuth、客户端身份、旧版 SSE 见 mcp-design v1.3 §13.6–§13.8。新增 DD-53–DD-56 |

## 1. 目标与范围

### 1.1 页面功能

以原型为准，每一项都在后文有落点：

| 区域 | 内容 | 章节 |
|---|---|---|
| 发现 · 技能 | 精选技能，两列卡片；一键添加到个人；详情页可看 SKILL.md 和文件 | §9.1、§10.4 |
| 发现 · 连接器 | 推荐连接器；无鉴权的一键添加，要令牌的进详情页填写，要登录的跳浏览器授权；详情页写明将要运行的命令或地址、写入哪个文件 | §8.3、§10.4 |
| 我的 · 技能 | 分个人、随仓库共享、内置三组，一行一个；启停、在对话中使用、在访达中显示；只有个人目录里的能删除；加载失败的在顶部提示 | §9、§10.4 |
| 我的 · 连接器 | 分所有项目、仅这个项目、随仓库共享三组；状态（可用、连接失败、未检测、需要登录、已停用、只对你关闭）；启停、编辑、检测、登录、删除 | §8、§10.4 |
| 详情页 | 技能：概览、SKILL.md、文件。连接器：一页到底，事实一行、工具一行一个 | §10.4、§10.12 |
| 添加菜单 | 上传技能、在对话中创建、添加自定义连接器 | §9.1、§10.4 |

### 1.2 目标

| 编号 | 目标 | 含义 |
|---|---|---|
| CG1 | 一份真相 | 桌面、命令行、编辑器看到同一组技能和连接器；在桌面加的，`finx exec` 和 Zed 里也能用 |
| CG2 | 内核运行时一期不动 | 任务、提示词、工具调用的代码不为管理页改动；管理是服务层的读写 |
| CG3 | 不拖慢 | `session/new` 不加参数、不加等待；打开页面不启动连接器进程，三个读取请求合计 20 ms 以内 |
| CG4 | 密钥不出钥匙串 | 只在用户输入的那一次经协议传入；不进配置文件、日志、事件、会话快照（沿用 desktop-kernel-integration 的 IG6） |
| CG5 | 改动可预期 | 改了哪个文件、什么时候生效、有没有被别的配置盖住，界面说得清楚；手写的配置文件被改动时保留注释和格式 |
| CG6 | 目录与内核解耦 | 推荐什么、怎么展示，由桌面端决定，随应用更新 |

### 1.3 不在本文

- 插件：把技能、连接器、命令打成一个包。
- MCP 的 resources、prompts、elicitation（mcp-design Q-104、Q-105）。
- 连接器调用的审批（mcp-design D-107：一期不审批）。
- 团队或组织统一下发的目录与策略。

## 2. 现状

| 能力 | 现状 | 出处 |
|---|---|---|
| 技能发现 | 根目录依次是：项目各级、用户、`skills.paths`；同名时先找到的生效；用 `skills.disabled` 停用；跳过名字以 `.` 开头的目录。2e 起项目里只看 `.agents/skills`（默认启用）和 `.claude/skills`（默认不启用），用户层只看 `~/.finx/skills` | skill-design §4、`finx-core/src/skills/mod.rs` |
| 技能清单 | `skills/list {cwd}` 列出全部技能：生效的、被遮蔽的、已停用的、加载失败的，带范围、路径和原因 | skill-design §11.4 |
| 技能何时生效 | 每个会话启动时扫描一次 | skill-design §4.5、Q-60 |
| 配置的层 | `config::load(user, project, trusted, overrides)`：用户 < 项目 < `-c`；表按键深度合并，数组整体替换（`rules` 拼接）；`Workspace::open` 解析项目根、信任和服务器，并记下每个服务器来自哪些层（`mcp_sources`） | `finx-core/src/config.rs`、`runtime.rs` |
| 服务器 | 配置、`.mcp.json`、命令行、客户端带来的合并后交给内核；内核持有连接，每个会话一个 McpManager；工具集合可以在两次模型请求之间替换 | mcp-design §4、§5 |
| 变量展开 | `${VAR}`、`${VAR:-默认}` 在连接时展开，缺失时这个服务器失败并写明变量名 | `finx-mcp/src/env.rs` |
| 管理接口 | 没有；`finx mcp add/remove` 列在二期，等引入 toml_edit | mcp-design §11.4、§12.2 |
| 凭据 | 钥匙串（服务名 `finx`，账户名任意字符串），服务进程内缓存；其他平台用 0600 文件 | `finx-llm/src/credentials.rs` |
| 通知 | 服务给"调用过某个读取方法"的连接发通知，例如 `models/list` 之后的 `models/changed` | `finx-server/src/connections.rs` |
| 已定的原则 | IG3 任务独立于窗口；IG5 只有一个内核，桌面端没有私有通道；IG6 密钥不进协议消息 | desktop-kernel-integration §1.1 |

## 3. 总体设计

### 3.1 分工（DD-30）

```
桌面渲染进程  customize/ 页面 ── 发现目录（随应用打包）
     │ MessagePort（主进程只转发字节）
finx 服务     finx-server: config/* credentials/* skills/* mcp/* 方法；文件监视 → 通知
     │
finx-core     config_edit（保格式写入、版本号、校验、覆盖、回收）· skills/install · skills/system · mcp/cache
finx-mcp      检测时的连接 · 二期 OAuth
finx-llm      钥匙串（credentials）
     │ 读写
文件          ~/.finx/config.toml · ~/.finx/projects/<键>/config.toml · ~/.finx/skills/** · 钥匙串 · ~/.finx/mcp/cache/
     │ 新会话启动时读取（不变）
内核运行时    技能发现 · 服务器合并 · McpManager 连接
```

| 谁 | 负责 | 不负责 |
|---|---|---|
| 桌面渲染进程 | 自定义页；发现目录与"已添加"判断；把表单变成 `credentials/set` 和 `config/write`；删除的延迟提交；"在对话中创建"的引导 | 读写文件和钥匙串、解析 SKILL.md、连接 MCP |
| 桌面主进程 | 选择技能来源的对话框；在访达中显示；打开浏览器；随应用打包的技能文件 | 同上 |
| finx-server | 方法与通知；文件监视；检测和登录的并发控制；从打开的会话取实时状态 | 推荐什么、界面文案 |
| finx-core | 写入、版本号、校验、覆盖、凭据回收；技能的安装与删除；内置技能；工具目录缓存；个人项目层；`skills.disabled` 拼接 | 发现目录、品牌 |
| finx-mcp | 检测入口；`${credential:…}` 展开；二期 OAuth 与续期 | 配置文件 |
| 内核运行时 | 一期不变 | 管理 |

"管控"拆成两半：

- **产品层面的管控在桌面端**：推荐什么、怎么分组、怎么引导、什么时候提示。
- **机制在 finx 服务**：文件格式、校验、钥匙串、连接。这些是 finx 自己定义的东西，由它自己读写才不会分叉。

其他做法为什么不用，见附录 A。

### 3.2 一次改动怎样到达会话（DD-31、DD-43）

以"添加 GitHub 连接器"为例：

1. 页面调 `credentials/set { name: "mcp.github", value }`，令牌进钥匙串。
2. 页面调 `config/write`：在用户配置里写 `[mcp_servers.github]`，请求头为 `Bearer ${credential:mcp.github}`。服务校验、写文件，回 `{ status: "ok", version }`。
3. 服务发 `config/changed`；页面刷新"我的"，并调 `mcp/check`，看到"可用 · 38 个工具"。
4. 之后新开的会话：`Workspace::open` 读到这个服务器，McpManager 连接时把 `${credential:mcp.github}` 换成钥匙串里的值。
5. 已经打开的会话不受影响。二期用户可以点"让打开的会话也用上"（`mcp/apply`，§8.4）。

`session/new` 的 `mcp_servers` 只用于：

- 编辑器带来自己的服务器（ACP 的本来用法）；
- 以后桌面专有的能力（mcp-design Q-109）；
- 以后"这个会话临时不用某个连接器"：只带名字和开关，不带配置（DQ-27）。

## 4. 数据与文件

### 4.1 文件布局

```
~/.finx/
├── config.toml                          用户配置（可写）
├── projects/
│   └── finxwork-3fa81c02/
│       └── config.toml                  个人项目层（可写，新增，§4.3）
├── skills/
│   ├── pdf-tools/                       个人技能（可写）
│   │   ├── SKILL.md
│   │   └── .finx-source.json            来源记录（§4.5）
│   └── .system/                         内置技能（finx 写入，§4.6）
│       ├── .marker
│       └── skill-creator/
└── mcp/
    └── cache/
        └── github-1c9e0a7b.json         工具目录缓存（§4.8）

<项目>/
├── .finx/config.toml                    项目配置（页面只读）
├── .agents/skills/                      仓库里的技能（页面只读，默认启用，可停用）
├── .claude/skills/                      另一个应用的技能（页面只读，默认不启用，可打开）
└── .mcp.json                            页面只读；finx 从不修改

~/.claude/skills、~/.agents/skills         其他应用的目录：默认不读（skills.other_apps）
钥匙串 service "finx"                      mcp.<名字>… 凭据（§4.7）
```

目录 0700，文件 0600，与总方案 §9.1 一致。

### 4.2 范围与可写性（DD-32、DD-36、DD-46）

| 范围 | 界面上的说法 | 技能在 | 连接器在 | 页面能做什么 |
|---|---|---|---|---|
| 个人 | 个人 / 所有项目 | `~/.finx/skills/<名字>/` | `~/.finx/config.toml` | 全部 |
| 仅这个项目 | 仅 finxwork（只对你） | 不提供（DQ-21） | 个人项目层：页面不再往这里添加（DD-57），只显示手写的条目，可编辑、删除 | 编辑、删除 |
| 随仓库共享 | 随仓库共享 · finxwork | `<项目>/.agents/skills/`；`<项目>/.claude/skills/`（默认不启用） | `<项目>/.finx/config.toml`、`.mcp.json` | 技能可停用，`.claude` 的可打开；连接器可"只对你关闭"；都不能编辑或删除 |
| 其他应用的用户目录 | 与 .claude 共用 | `~/.claude/skills`、`~/.agents/skills`：默认不读，`skills.other_apps = true` 时才出现 | — | 只能停用 |
| 内置 | 内置 | `~/.finx/skills/.system/` | — | 只能停用 |

- **仓库里的文件是团队共用的**：页面上显示为只读，给出"在访达中显示"。要改，就自己编辑，或者在对话里让 finx 改；这些都是受保护路径，写入要审批（skill-design §8.3、mcp-design §4.4）。
- **命令行另有选项**：`--project` 仍可写仓库，那是用户在终端里明确要求的。

### 4.3 个人项目层（DD-33）

- **项目键**：`<项目根目录名>-<真实路径 SHA-256 的前 8 个十六进制位>`，例如 `finxwork-3fa81c02`。
  - 目录名只取字母、数字、`-`、`_`、`.`，其余换成 `-`，最长 40 个字符。
  - 没有项目的会话（`~/.finx/chats/…`）没有这一层。
- **文件头**：服务第一次创建这个文件时写两行注释：

  ```toml
  # Personal settings for /Users/yee/CodeSpace/finxwork
  # (only you, only this project; written by finx)
  ```

- **合并顺序**：用户 < 项目 < 个人项目层 < `-c`。自己的设置盖过仓库里的。
- **信任**：这是用户自己的文件，不受项目信任状态影响，整份加载。
- **项目搬家**：路径变了，键就变了，旧文件留在原处。页面在"仅这个项目"为空、而 `projects/` 下有同名但不同指纹的目录时，提示一次"这个项目以前在别处，要沿用那里的设置吗"（DQ-33）。
- **顺带解决 Q-108**：在自己的配置里关掉仓库里的服务器，就是在这一层写 `[mcp_servers.<名字>] enabled = false`。不影响队友，也不在其他项目里留下空条目。

### 4.4 配置合并的改动

`config::load` 的三处改动：

1. **多一层**：在项目配置之后、`-c` 之前，读个人项目层，`Workspace::open` 用项目根算出它的路径。
2. **`skills.disabled` 跨层拼接（DD-34）**：与 `rules` 一样拼接、去重，不再整体替换。否则项目配置里只要写了 `skills.disabled`，个人停用的就全被覆盖。2e 新增的 `skills.opt_in` 同样拼接。
3. **记下每个键的来源**：合并时为每个叶子键记下最后写它的层。
   - `config/read` 的 `origins` 用它；写入后判断"被谁盖住"也用它（§5.1）。
   - 现有的 `mcp_sources` 是它的特例，改为由它导出。

### 4.5 技能的来源记录

从目录或上传安装时，服务在技能目录里写 `.finx-source.json`：

```json
{ "kind": "catalog", "id": "webapp-testing", "version": "1.0.0", "sha256": "…", "installed_at": "2026-10-31T10:00:00Z" }
```

- **`kind` 的取值**：
  - `catalog`：来自发现目录；
  - `upload`：上传的，没有 id 和 version；
  - `chat`：不由服务写。模型在对话里写的技能没有这个文件，页面显示为"本地"。
- **`sha256`**：安装时整个目录的指纹（文件按相对路径排序后逐个哈希）。以后用来判断用户是否改过它，更新前提示（§9.5）。
- **扫描不受影响**：扫描只看 SKILL.md。`skills/list` 读到这个文件时，把它放进 SkillEntry 的 `source`。

### 4.6 内置技能（DD-47）

- **编译进去**：内置技能的文件作为文本资源编译进 finx，用 `include_str!` 显式收录。当前内置 Anthropic Skill Creator 的 Finx 适配版（来源与版本见随技能打包的 `UPSTREAM.md`），包含正文、agents、references、scripts、评审 HTML 和许可证。
- **写到磁盘**：
  - 服务启动时，以及命令行第一次需要技能时，比较 `~/.finx/skills/.system/.marker` 里的指纹和内置内容的指纹；
  - 相同就跳过；不同就把 `.system` 整个写到临时目录，再 rename 替换，然后写新的标记；
  - 这一步约 1 ms，只在升级后发生。
- **扫描**：
  - 新增一层"内置"，范围值为 `system`，排在所有根目录之后，同名时用户的技能优先；
  - `.system` 以点开头，用户层扫描本来就跳过它（skill-design D-63），不会被扫到两次。
- **模型看不到它**：skill-creator 的头部写 `disable-model-invocation: true`，不进系统提示词里的技能目录，只在用户点名时使用（输入 `/skill:skill-creator`，或者"在对话中创建"预填）。这样内置技能不给每个会话加提示词。
- **用户能做什么**：可以停用，不能删除。直接改它的文件，会在下次升级时被覆盖；详情页写明这一点。
- **为什么作为内置资源打包**：桌面、终端和服务端共用同一个发现机制；创建与评测策略放在技能文件里，内核只负责已有的落盘、发现和读取，不增加专门的创建算法。
- **依赖**：创建和编辑只用现有模型与文件工具；评测用 Finx 子代理，缺少子代理时可顺序检查并说明局限；统计、离线评审、打包脚本可选 Python 3.10+，只用标准库。自动校验复用 Finx CLI 解析器，可用 `FINX_BIN` 指定桌面自带的可执行文件。不要求安装 Claude Code、PyYAML 或另配 Anthropic 账号，不加载远程 CDN。
- **入口**：桌面"在对话中创建"仅在当前技能列表中 skill-creator 已启用时显示；终端使用 `/skill:skill-creator`。

### 4.7 连接器的凭据（DD-37、DD-38）

- **语法**：在 `${VAR}` 之外新增 `${credential:名字}`。
  - 可以写在 `env`、`headers` 的值里，以及 `command`、`args`、`url`。与 `${VAR}` 在同一处、同一时机展开（`finx-mcp/src/env.rs` 的 `expand`）。
  - 名字限 `mcp.` 开头，后面是 1–96 个字母、数字、`.`、`_`、`-`。
- **命名约定**：页面写入时用下面三种名字：
  - `mcp.<服务器>`：远程服务器的 Bearer 令牌；
  - `mcp.<服务器>.<变量名>`：本地服务器的环境变量；
  - `mcp.<服务器>.header.<头名>`：其他请求头。
- **展开**：
  - 由 finx-mcp 查 `finx_llm::credentials::get`，服务进程内有缓存，每个条目每个服务进程只读一次钥匙串；
  - 条目不存在时，这个服务器失败，原因是 `credential mcp.github is not saved`；页面据此显示"令牌缺失 · 重新填写"。
- **不进日志**：展开后的值和 `${VAR}` 的值一样，只在连接时使用，日志、事件、快照里都只出现引用。
- **回收**：一次 `config/write` 删掉或换掉了某个引用时，服务扫描用户自己的文件。没有别处再引用这个名字，就在写入成功后删掉这个凭据（§5.1 第 9 步）。仓库里的文件不参与扫描，它们引用的个人凭据由用户自己管理。
- **OAuth 令牌（二期）**：
  - 存在 `mcp-oauth.<服务器>` 下，内容是令牌响应、过期时间、授权服务器和服务器地址；
  - 地址变了，令牌就作废，需要重新登录。同名服务器删掉又加回来也不会继承旧令牌。

### 4.8 工具目录缓存（DD-39）

- **位置**：`~/.finx/mcp/cache/<名字>-<指纹前 8 位>.json`。
- **指纹**：规范化配置的 SHA-256，按名字、传输方式、命令、参数、环境、地址、请求头的固定顺序序列化。
  - 凭据只以引用名参与计算，不含值；
  - 本地服务器还算上工作区根目录，因为同一条命令在不同项目里可能给出不同的工具。
- **内容**：

  ```json
  {
    "version": 1,
    "server": "github",
    "fingerprint": "1c9e0a7b…",
    "result": "ok",
    "error": null,
    "checked_at": "2026-10-31T09:12:00Z",
    "elapsed_ms": 640,
    "protocol_version": "2025-11-25",
    "instructions": "…",
    "tools": [{ "name": "create_issue", "title": "Create issue", "description": "Create a new issue in a repository" }]
  }
  ```

- **何时写**：
  - 会话里服务器就绪或失败时（McpManager 的状态变化处），由服务写；
  - `mcp/check` 之后也写；
  - 同一指纹 60 秒内最多写一次。
- **大小**：每个工具的说明截到 300 个字符；单个文件最多 1 MB；目录最多 200 个文件，超出时删最旧的。
- **以后**：Q-112 用它让会话启动时不必等服务器，规则按 mcp-design 的原定。

## 5. 写入

### 5.1 `config/write` 的流程（DD-40）

1. 确定目标文件：`user` 或 `user_project`（要 `cwd`）。其他层返回 `config_layer_readonly`。
2. 取这个文件的锁（`flock`），最多等 2 秒；等不到返回 `config_busy`。锁文件放在 `~/.finx/run/locks/`，不放在配置文件旁边，免得 `--project` 在仓库里留下文件。
3. 读文件，算版本号。带了 `expected_version` 而不相同，返回 `config_version_conflict`，`data` 里给出当前版本号。
4. 用 toml_edit 按顺序应用 `edits`：
   - `replace`：整体替换这个键（表或值）；
   - `upsert`：只改给出的字段，其余保留；
   - `value: null`：删除这个键，删空的父表一并删掉。
5. 把改后的文件单独解析一遍（与读取时同一个解析器，未知字段报错）。不通过就返回 `config_validation_error`，`data` 带键路径和原因。
6. 用改后的文件重新合并所有层，校验合并结果（服务器名、命令或地址、数值范围）。不通过同上。
7. 对每个改动的键，查合并后它来自哪一层（§4.4）。来自更高的层，就记为 `overridden_by`。
8. 写临时文件，fsync，rename，释放锁。
9. 回收凭据（§4.7），发 `config/changed`，再按改动的范围发 `mcp/changed` 或 `skills/changed`。
10. 返回 `{ status, version, file, overridden_by? }`。

- **保格式**：只动目标的表或数组项，其余字节不变。新建的表追加在文件末尾，前面空一行。
- **版本号**：文件内容的 SHA-256 前 16 个十六进制位；文件不存在时为 `"absent"`。
- **命令行**：一次性命令调用同一个函数，不经过服务，所以服务不会主动发通知；服务的文件监视会补上（§5.3）。

### 5.2 键路径

- 用点分隔：`mcp_servers.github.enabled`、`skills.disabled`。
- 服务器名只含字母、数字、`_`、`-`，不需要引号。键里本身有点的，用 TOML 的引号写法，例如 `mcp_servers.github.headers."X-Team"`。
- 页面只用到下面这几类：

  | 用途 | 键路径 | 写法 |
  |---|---|---|
  | 新建或整体修改一个连接器 | `mcp_servers.<名字>` | `replace` |
  | 启停 | `mcp_servers.<名字>.enabled` | `replace`，值为布尔 |
  | 删除 | `mcp_servers.<名字>` | `value: null` |
  | 只对你关闭仓库里的连接器 | 个人项目层的 `mcp_servers.<名字>.enabled` | `replace`，值为 false；重新打开时删掉这个键 |

### 5.3 监视与通知（DD-48）

- **监视什么**：
  - 用户层的技能根目录（`~/.finx/skills` 含 `.system`、`skills.paths`；`other_apps` 打开时加上 `~/.agents/skills`、`~/.claude/skills`）；
  - 用户配置；
  - `~/.finx/projects/`；
  - 每个"订阅过的工作区"的项目技能目录、项目配置和 `.mcp.json`。
- **订阅过的工作区**：连接调用 `skills/list`、`mcp/list` 或 `config/read` 时带的 cwd，记在这个连接上，连接断开就移除。
- **通知规则**：事件节流 2 秒合并：
  - 技能目录有变化，发 `skills/changed { cwd? }`；
  - 配置文件有变化，发 `config/changed { file }`，同时发 `mcp/changed`。
- **实现**：notify crate；macOS 上是 FSEvents，空闲时不占 CPU。
- **兜底**：监视失败（例如文件句柄不够）时记一条日志。页面在窗口重新获得焦点时总会重取一次。

## 6. 协议

都在协议版本 2 之内，由 capabilities 的 `customize` 声明。桌面端要求这一位；内核太旧时，守护器在没有任务时替换它，与 `model_connections` 相同。

### 6.1 配置与凭据（DD-45）

```ts
// config/read
interface ConfigReadParams { cwd?: string; layers?: boolean }
interface ConfigReadResult {
  config: object;                         // 合并后的配置，凭据保持 ${credential:…} 原样
  origins: Record<string, LayerName>;     // 键路径 → 最后写它的层，只列叶子
  layers?: ConfigLayerInfo[];             // layers: true 时
}
type LayerName = "user" | "project" | "user_project" | "project_json" | "flag";
interface ConfigLayerInfo {
  layer: LayerName;
  file: string;                           // .mcp.json、-c 没有可写的文件时为说明文字
  version: string;                        // §5.1
  writable: boolean;                      // 只有 user、user_project 为 true
  exists: boolean;
}

// config/write
interface ConfigWriteParams {
  layer: "user" | "user_project";
  cwd?: string;                           // user_project 时必填
  edits: { key_path: string; value: unknown | null; merge: "replace" | "upsert" }[];
  expected_version?: string;
}
interface ConfigWriteResult {
  status: "ok" | "overridden";
  version: string;
  file: string;
  overridden_by?: { key_path: string; layer: LayerName; file: string }[];
}

// credentials/set、credentials/delete
interface CredentialsSetParams { name: string; value: string }    // name 以 mcp. 开头
interface CredentialsDeleteParams { name: string }

// 通知 config/changed
interface ConfigChanged { file: string }
```

- **为什么用通用写入**：
  - 连接器的增、删、改、启停都只是改 `[mcp_servers.*]`；
  - 以后的设置页（权限模式、默认模型等）也用这一对方法；
  - 校验、版本号、覆盖提示、通知只有一处。
- **凭据名的限制**：`credentials/*` 只接受 `mcp.` 和 `mcp-oauth.` 开头的名字。模型密钥仍走 `auth/set`，它要先向服务商验证。
- **日志**：`credentials/set` 只记名字。

### 6.2 技能

```ts
// skills/list（改）：SkillEntry 新增
interface SkillEntryAdditions {
  source?: { kind: "catalog" | "upload"; id?: string; version?: string };   // §4.5
  removable: boolean;                     // 在 ~/.finx/skills 里（不含 .system）
  default_enabled: boolean;               // 2e：用户没有打开或关掉时是否可用；项目 .claude/skills 里的为 false
}
// SkillsListResult 新增（2e）：not_read?: string[]，other_apps 关着而有东西的目录；页面不显示
// SkillScope 新增 "system"

// skills/files
interface SkillsFilesParams { path: string }       // 技能目录或 SKILL.md
interface SkillsFilesResult {
  skill_md: string;                       // 最多 256 KB，超出截断并标 truncated
  truncated: boolean;
  files: { path: string; size: number; dir: boolean }[];   // 相对路径，最多 500 项、6 层
}

// skills/read（v0.15）
interface SkillsReadParams { path: string; file: string }   // 技能目录或 SKILL.md；file 是 skills/files 列出的相对路径
interface SkillsReadResult {
  text: string;                           // 最多 256 KB，超出截断并标 truncated；不是文本时为空
  truncated: boolean;
  binary: boolean;                        // 不是 UTF-8 文本（图片、压缩包、程序）
  image?: { mime_type: string; data: string };   // 按签名是 PNG、JPEG、GIF、WebP 的图片，data 为 base64
}

// skills/install
interface SkillsInstallParams {
  from: string;                           // 绝对路径：目录、SKILL.md、.zip 或 .skill
  scope?: "user" | "project";             // 默认 user；页面只用 user
  cwd?: string;                           // scope 为 project 时必填
  source?: { kind: "catalog"; id: string; version: string; sha256: string };
  dry_run?: boolean;                      // 只解析和检查，不写
  replace?: boolean;                      // 同名时替换（旧的移到废纸篓）
}
interface SkillsInstallResult {
  skill: SkillEntry;                      // dry_run 时为解析出的样子
  target: string;                         // 将要或已经装到的目录
  conflict?: { path: string };            // 同名且没有 replace 时
}

// skills/remove
interface SkillsRemoveParams { path: string }      // 只接受 removable 的技能

// skills/set_enabled
interface SkillsSetEnabledParams { path: string; enabled: boolean }
interface SkillsSetEnabledResult {
  file: string;                           // 改了的用户配置文件
  removed_names?: string[];               // 启用时一并删掉的名字形式
}
// 2e：参数和结果不变；写 skills.opt_in 还是 skills.disabled 由内核按 default_enabled 决定（§9.3）

// 通知 skills/changed
interface SkillsChanged { cwd?: string }
```

### 6.3 连接器

```ts
// mcp/list
interface McpListParams { cwd?: string }
interface McpListResult { servers: McpServerView[] }
interface McpServerView {
  name: string;
  layer: LayerName | "client";            // 定义它的层；被个人项目层只改了 enabled 的，仍是原来的层
  file?: string;                          // 定义它的文件
  editable: boolean;                      // layer 为 user 或 user_project
  enabled: boolean;
  disabled_by?: LayerName;                // enabled 为 false 时，是哪一层关掉的；仓库的服务器为 user_project 时即"只对你关闭"
  transport: "stdio" | "http" | "sse";    // sse：二期的旧版传输（mcp-design §13.7）
  summary: string;                        // 命令行，或去掉查询串的 URL；凭据只显示引用名
  description?: string;
  auth: "none" | "credential" | "oauth" | "unknown";
  auth_state?: "saved" | "missing" | "logged_in" | "needs_login";
  status: McpServerStatusView;
}
interface McpServerStatusView {
  state: "ok" | "failed" | "unknown" | "needs_login" | "untrusted";
  source?: "session" | "cache";
  sessions?: number;                      // 打开的会话里正连着它的数目
  tools?: number;
  error?: string;
  checked_at?: string;
  elapsed_ms?: number;
}

// mcp/tools
interface McpToolsParams { name: string; cwd?: string }
interface McpToolsResult {
  tools: { name: string; title?: string; description?: string }[];
  source: "session" | "cache" | "none";
  checked_at?: string;
}

// mcp/check
interface McpCheckParams { name: string; cwd?: string }
interface McpCheckResult { server: McpServerView; tools: McpToolsResult["tools"] }

// mcp/probe（二期）：添加之前检查，不写任何文件（mcp-design §13.6）
interface McpProbeParams {
  probe_id: string;                       // 调用方生成，进度通知和取消都用它
  name: string;
  server:                                 // 与配置里的一项相同；密钥写成 ${credential:…} 引用
    | { url: string; headers?: Record<string, string>; transport?: "streamable_http" | "sse" }
    | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
  cwd?: string;                           // 本地命令的工作目录和 roots
}
interface McpProbeResult {
  kind: "remote" | "local";
  steps: McpProbeStep[];
  transport?: "streamable_http" | "sse";
  auth?: {
    required: boolean;                    // 回了 401
    oauth?: {                             // 找到了登录服务
      authorization_server: string;       // issuer
      scopes?: string[];
      pkce: boolean;                      // 支持 S256
      metadata_document: boolean;         // client_id_metadata_document_supported
      registration: boolean;              // 有 registration_endpoint
    };
  };
  suggested: { auth: "oauth" | "token" | "none"; client?: "metadata_document" | "registration" | "own" };
  tools?: { name: string; description?: string }[];
  error?: string;
}
interface McpProbeStep {
  id: "connect" | "resource" | "auth_server" | "start" | "handshake" | "tools";
  state: "running" | "ok" | "failed" | "skipped";
  detail?: string;                        // "登录服务：mcp.linear.app"、"找不到主机 …"
  http_status?: number;
}
// 通知 mcp/probe_progress { probe_id, step: McpProbeStep }
// mcp/probe_cancel { probe_id }：结束正在进行的探测，本地命令的进程组一并结束

// 二期
interface McpLoginParams {
  name: string;
  cwd?: string;
  server?: { url: string; headers?: Record<string, string>; transport?: "streamable_http" | "sse"; oauth?: { client_id: string; client_secret?: string; scopes?: string[] } };
                                          // 还没写进配置时带上，登录在写入之前完成
}
interface McpLoginResult { authorize_url: string; login_id: string }
interface McpLogoutParams { name: string }
interface McpApplyParams { cwd: string; names?: string[] }
interface McpApplyResult { sessions: number }

// 通知 mcp/changed
interface McpChanged { name?: string; login_id?: string; login_error?: string }
```

- **增删改与启停**：都是 `config/write`（§5.2）。
- **密钥只进不出**：只在 `credentials/set` 的参数里出现；`config/read` 原样返回引用，`mcp/list` 只有"已保存"或"缺失"。
  - `auth_state` 为 `saved` 还是 `missing`，看钥匙串里有没有这个条目，结果在服务进程里缓存，不读值。

### 6.4 订阅

- 调用过 `config/read` 的连接收到 `config/changed`；调用过 `skills/list` 的收到 `skills/changed`；调用过 `mcp/list` 的收到 `mcp/changed`。与 `models/list` 之后收到 `models/changed` 相同。
- 带 `cwd` 的读取顺带把这个工作区加进监视范围（§5.3）。

### 6.5 并发

| 情况 | 处理 |
|---|---|
| 两个连接同时写同一个文件 | 文件锁排队；带了版本号的后一个返回冲突 |
| 同一个服务器同时两次 `mcp/check` | 合并成一次，两边拿到同一个结果 |
| 检测或登录进行中又改了它的配置 | 写入照常；进行中的检测结果因指纹不同不写缓存，返回时附 `stale: true` |
| 写入时监视也触发了 | 服务记下自己刚写的文件和版本号，同版本的监视事件不再发通知 |

### 6.6 ACP

不变。编辑器照常在 `session/new` 里带 `mcpServers`；用户在桌面加的连接器也会出现在编辑器的会话里，因为读的是同一份配置。

### 6.7 错误码

| 码 | 名字 | 含义 | data |
|---|---|---|---|
| −32023 | config_version_conflict | 文件在读取之后被改过 | `{ version }` |
| −32024 | config_layer_readonly | 目标不是用户自己的文件 | `{ layer }` |
| −32025 | config_validation_error | 改后的文件或合并结果不合法 | `{ key_path, message }`（可多条） |
| −32026 | config_busy | 2 秒内拿不到文件锁 | — |
| −32027 | skill_invalid | SKILL.md 缺失、头部无法解析、没有 description，或超出大小限制 | `{ message }` |
| −32028 | skill_conflict | 目标已有同名技能，且没有 replace | `{ path }` |
| −32029 | not_removable | 要删除的技能不在 `~/.finx/skills`（或是内置的） | `{ path }` |
| −32030 | credential_store_unavailable | 钥匙串不可用（例如被锁，或用户拒绝了访问） | `{ store }` |

## 7. 命令行

调用 finx-core 里与服务相同的函数，不经过服务：

| 命令 | 对应 |
|---|---|
| `finx skills add <目录或压缩包> [--project] [--replace]` | `skills/install`；`--project` 装到仓库的 `.agents/skills`（2e） |
| `finx skills remove <名字或路径>` | `skills/remove` |
| `finx skills enable/disable <名字或路径>` | `skills/set_enabled`；写名字时停用全部同名；写路径时按默认状态写 `opt_in` 或 `disabled`（skill-design §4.4） |
| `finx mcp add <名字> --url <URL> [--header K=V]…` | `credentials/set`（`--token` 从标准输入读）和 `config/write` |
| `finx mcp add <名字> [--env K=V]… -- <命令> [参数…]` | 同上；`--secret-env K` 把 K 的值存进钥匙串，配置里写引用 |
| 范围选项 | 默认写用户配置；`--here` 写个人项目层；`--project` 写仓库的项目配置 |
| `finx mcp remove/enable/disable <名字> [--here]` | `config/write`；仓库里的服务器用 `disable --here` 只对自己关闭 |
| `finx mcp list --check`（已有） | 同时写缓存 |
| `finx mcp login/logout <名字>`（二期） | 自己打开浏览器，在终端等回调 |

例子：

```
$ printf %s "$GITHUB_TOKEN" | finx mcp add github --url https://api.githubcopilot.com/mcp/ --token
added github to ~/.finx/config.toml (token saved in the keychain as mcp.github)
checking… ok, 38 tools (640 ms)
```

## 8. 连接器的状态、检测与登录

### 8.1 状态从哪里来（DD-39）

`mcp/list {cwd}` 对每个服务器按顺序取：

1. **已停用**：`enabled = false`，`disabled_by` 说明是哪一层关掉的。
2. **项目未受信任**：定义在仓库里、项目又没有信任。
3. **打开的会话**：服务承载着所有会话。找根会话中工作区相同、这个服务器指纹相同的；有就用它的实时状态（就绪、失败），`sessions` 为数目。
4. **缓存**：§4.8 的文件，指纹相同才用。
5. **未检测**。

另外，`auth: "oauth"` 而钥匙串里没有令牌，或令牌已失效、刷新失败，状态就是 `needs_login`（二期）。

| 页面上 | 条件 |
|---|---|
| ● 可用 · 38 个工具（悬停："2 个打开的会话正在使用"或"3 小时前检测"） | ok |
| ● 连接失败 · 重试 | failed |
| 未检测 · 检测 | unknown |
| ● 需要登录 · 登录 | needs_login |
| 已停用 / 只对你关闭 | enabled 为 false；后者是仓库的服务器被个人项目层关掉 |
| 未加载 · 项目未受信任 | untrusted |

### 8.2 `mcp/check`

- **怎么连**：与会话用同一个 McpClient 和同一套展开规则：环境白名单、`${VAR}`、`${credential:…}`。roots 为 cwd。
- **步骤**：握手、取工具列表、断开；时限取 `startup_timeout_secs`（默认 30 秒）；本地服务器断开时结束整个进程组（mcp-design §5.6）。
- **判断要不要登录**：远程服务器回 401，并在 `WWW-Authenticate` 里给出 `resource_metadata`，或者在受保护资源的元数据地址能取到授权服务器，就判为 `needs_login`，并把 `auth` 记为 `oauth`。自定义的连接器不需要用户事先知道它用哪种鉴权。
- **结果**：写缓存，发 `mcp/changed`，返回服务器的视图和工具列表。
- **并发**：同一个服务器同时只有一次检测（§6.5）。

### 8.3 二期：OAuth 登录（Q-102）

协议细节、客户端身份的顺序和续期规则在 mcp-design §13.8，这里只写页面怎么用。

1. `mcp/login { name, server? }`：
   - 服务读这个服务器的受保护资源元数据，找到授权服务器，再读授权服务器的元数据；
   - 客户端身份：用户填的应用 → finx 的客户端元数据文档 → 动态注册（注册结果在本地复用）→ 请用户填（mcp-design D-182）；
   - 生成 PKCE 和 state，在 127.0.0.1 的随机端口上监听回调；
   - 返回 `authorize_url` 和 `login_id`；
   - 带 `server` 时服务器还没写进配置：添加流程先登录、成功了再写配置（DD-54）；用户放弃时页面调 `mcp/logout { name }` 删掉已经存下的令牌。
2. 桌面主进程用系统浏览器打开 `authorize_url`；命令行自己打开，并在终端里等待。
3. 回调到达：服务校验 state，用授权码换令牌，请求里带 `resource`（服务器地址）。令牌存进 `mcp-oauth.<名字>`，发 `mcp/changed { login_id }`。
4. 页面收到后调 `mcp/check`。5 分钟没有回调就放弃，发 `mcp/changed { login_id, login_error }`。
5. 续期：
   - 由 finx-mcp 在连接时和收到 401 时进行，401 后刷新一次再重发，与模型连接的规则相同；
   - 刷新时取 `mcp-oauth.<名字>.lock` 的跨进程锁，避免命令行和服务同时刷新、互相覆盖。
6. `mcp/logout`：服务器支持撤销就先撤销，再删除令牌。

### 8.4 二期：推到打开的会话（DD-49）

`mcp/apply { cwd, names? }` 对这个工作区里每个打开的根会话：

1. 用当前文件重新合并它的服务器列表，保留客户端带来的那些；
2. 与它的 McpManager 比较：
   - 新增的开始连接；
   - 删掉的关闭；
   - 指纹变了的先关闭再连接；
   - 没变的不动；
3. 在这个会话的下一次模型请求之前，按 mcp-design §5.4 替换工具集合和系统提示词里的连接器目录，记一条 `system_prompt` 条目；
4. 正在执行的工具调用不受影响，子智能体随根会话一起变化。

页面只在有打开的会话、而且改动涉及连接器时，在提示里给出"让打开的会话也用上"。代价是每个会话一次缓存未命中，所以不自动做。

## 9. 技能的安装、删除与启停

### 9.1 安装

1. **读来源**：
   - 目录：直接读；
   - SKILL.md：它所在的目录就是技能；
   - .zip 或 .skill（同一种格式）：解到同一文件系统上的临时目录。压缩包只有一个顶层目录时，以它为技能目录。
2. **检查**：
   - 用内核现有的头部解析器（skill-design §3.3），没有 description 不收；
   - 名字取头部的 `name`，没有时取目录名，并按规范检查（不合规只记提示，与扫描时相同）；
   - 总大小不超过 20 MB、文件不超过 2,000 个、深度不超过 8 层；
   - 拒绝指向技能目录以外的符号链接，以及压缩包里的绝对路径、`..` 和设备文件。
3. **目标**：`~/.finx/skills/<名字>`；`scope: "project"` 时为 `<项目>/.agents/skills/<名字>`（2e 之前是 `.finx/skills`）。
4. **同名**：目标已有同名技能，没有 `replace` 时返回 `skill_conflict`；有 `replace` 时先把旧的移到废纸篓。
5. **写入**：复制到目标旁边的临时目录，写 `.finx-source.json`，rename 成正式目录。
6. **收尾**：发 `skills/changed`，返回新的 SkillEntry。

`dry_run` 只做第 1、2 步和第 4 步的判断，用在上传前的确认。

### 9.2 删除

- 只接受 `removable` 的技能，否则返回 `not_removable`。
- 移到系统废纸篓（trash crate）；取不到废纸篓时返回错误，不直接删除。
- 页面的"撤销"是延迟 5 秒再调用（§10.4），内核不提供恢复。

### 9.3 启停

- `skills/set_enabled { path, enabled }` 只改用户配置，按技能的默认状态决定写哪个列表（2e，skill-design §4.4、D-175）：
  - 默认启用的：停用时把路径加进 `skills.disabled`；启用时删掉这条路径，用户以前写的同名的名字形式也一并删掉，并在结果里提示。
  - 默认不启用的（仓库 `.claude/skills` 里的）：打开时把路径加进 `skills.opt_in`；关掉时删掉这条路径。
  - 每次写入时，顺手删掉另一个列表里指向它的路径。
- 停用生效的那一份后，被它遮蔽的下一份随之生效（skill-design §4.4），页面在提示里说明。
- 仓库里的技能被停用，也写在用户配置里，不改仓库（原型的提示："写在你的个人配置里，不改仓库"）。

### 9.4 文件

- `skills/files` 返回 SKILL.md 的原文和文件列表，打开详情页时调用一次。
- `skills/read`（v0.15）返回技能里一个文件的内容，在"文件"里打开 SKILL.md 以外的文件时调用：
  - 只读技能目录以内的文件：`file` 必须是相对路径，不能含 `..`；解析符号链接后仍须在目录内，否则返回 `skill_invalid`；
  - 和 SKILL.md 一样最多 256 KB，超出截断；截断处切开的半个字符不算非文本；
  - 不是 UTF-8 或含 NUL 的，返回 `binary: true`、不带内容；
  - 按文件签名是 PNG、JPEG、GIF、WebP 的，另带 `image: { mime_type, data }`（base64），用于详情页显示；超过一个技能整体的上限 20 MB（§9.1）的不带。

### 9.5 二期：更新

- 目录里的版本比来源记录新时，卡片和详情页显示"有更新"。
- 更新等于 `replace: true` 的安装。路径不变，所以停用状态不变。
- 来源记录里的 `sha256` 与当前文件不同时，说明用户改过它，更新前提示"你改过这个技能，更新会覆盖你的改动"。

## 10. 桌面端

### 10.1 入口与路由

- **侧栏**：在"新会话""搜索"之后加"自定义"，图标为三格加一格的方块。
- **路由**：`Selection` 新增 `{ kind: "customize"; tab: "skills" | "connectors"; view: "mine" | "discover"; detail?: { kind: "skill" | "connector"; id: string; tab: string } }`，随其他界面状态保存；默认 `skills` / `discover`。
- **页面**：MainWindow 在 `kind === "customize"` 时渲染 `<Customize />`。详情页是这个页面的子视图，不是弹窗。Esc 或"← 技能/连接器"返回列表，列表保留滚动位置。

### 10.2 模块

| 文件 | 内容 |
|---|---|
| `renderer/src/customize/Customize.tsx` | 页头、页签、"我的/发现"切换、添加菜单、列表与详情的切换 |
| `customize/useCustomize.ts` | 取数与订阅：三个读取请求、三个通知、窗口获得焦点时重取；把结果整理成页面用的结构 |
| `customize/SkillRows.tsx`、`ConnectorRows.tsx` | "我的"的分组与一行一个的面板 |
| `customize/Discover.tsx` | 两列卡片、加号的三种状态 |
| `customize/Details.tsx` | 详情页：已添加的连接器和技能是一页到底（§10.12、§10.13）；推荐连接器仍是页头加页签 |
| `customize/SkillContents.tsx` | 技能详情的"文件"：文件树、打开的文件、预览与原文的切换（§10.13） |
| `customize/ConnectorFields.tsx` | 连接器设置的分组表单：带锁的键值行、鉴权、脚注、高级选项、命令和环境变量；添加和编辑共用 |
| `customize/EditConnector.tsx` | 编辑配置（§10.11）：从配置文件填好表单，远程地址在后台重新探测，按字段显示错误 |
| `customize/UploadSkill.tsx` | 选择来源、预览、冲突与替换 |
| `customize/catalog.ts` | 发现目录（§10.6） |
| `customize/status.ts` | McpServerView → 状态文字与动作（§8.1 的表） |
| `styles/customize.css` | 页面样式，沿用 tokens.css 和 app.css 的类 |

### 10.3 数据流

- **打开页面**：
  - 并行请求 `skills/list {cwd}`、`mcp/list {cwd}`、`config/read {cwd, layers: true}`；
  - `cwd` 是新会话页当前选中的项目，没有项目时不带（DQ-25）；
  - 发现目录是本地数据，同时就绪。
- **刷新**：
  - 收到 `skills/changed` 重取技能；收到 `config/changed` 或 `mcp/changed` 重取连接器和配置；
  - 窗口重新获得焦点时三个都重取。
- **开关**：先在界面上切换，再写入；失败就弹回原状，并显示错误。
- **写入时带版本号**：用 `config/read` 拿到的版本号。遇到 `config_version_conflict`，就重取后再提交一次；表单里正在编辑的内容不丢。
- **删除**：先在界面上移除，提示条带"撤销"，5 秒后才调用。提交前离开页面，就立即提交。

### 10.4 界面与方法的对照

| 界面动作 | 调用 | 结果怎么显示 |
|---|---|---|
| 发现 · 技能卡片的 + | `skills/install { from: <打包路径>, source }` | 加号转圈，然后变成勾；"已添加 X，新会话起可用" |
| 技能详情页的"添加" | 同上 | 页面就地变成已添加的样子 |
| 添加 › 上传技能 | 主进程选择框 → `skills/install { from, dry_run }` → 确认 → 不带 dry_run 再调一次 | 预览名字、描述、"将复制到 ~/.finx/skills/<名字>"；同名时"替换" |
| 添加 › 在对话中创建 | 新开无项目会话，输入框预填 `/skill:skill-creator ` | 模型写入前请求审批；写完后监视触发 `skills/changed`，列表自动出现 |
| 技能行的开关 | `skills/set_enabled` | 仓库里的："已停用 X：写在你的个人配置里，不改仓库"；默认不启用的打开后："已启用 X：写在你的个人配置里，不改仓库" |
| 技能 ⋯ › 删除 | 5 秒后 `skills/remove` | "已删除 X，移到了废纸篓 · 撤销"；只有个人目录里的有这一项 |
| 技能 ⋯ › 在对话中使用 | 新开会话，输入框预填 `/skill:<名字> ` | — |
| 技能 ⋯ › 在访达中显示 | 主进程 `revealPath` | — |
| 技能详情 › 文件 | `skills/files`，打开 SKILL.md 以外的文件时 `skills/read` | 文件树与打开的文件（§10.13） |
| 发现 · 无鉴权连接器的 + | `config/write`（用户配置，`mcp_servers.<id>` replace）→ `mcp/check` | 转圈，然后变成勾；"已添加 X · N 个工具，新会话起可用" |
| 发现 · 要令牌的 + | 进入详情页，令牌框获得焦点 | — |
| 连接器详情的"添加"（令牌） | `credentials/set { name: "mcp.<id>…", value }` → `config/write` → `mcp/check` | 同上；令牌框为空时标红 |
| 发现 · 要登录的 +（二期） | `config/write` → `mcp/login` → 主进程打开浏览器 → 等 `mcp/changed { login_id }` → `mcp/check` | "等待授权…"，可以取消 |
| 添加 › 添加连接器 › 连接（远程地址） | `mcp/probe`，按 `mcp/probe_progress` 画三步进度 → 进入远程设置页（§10.9） | 默认的鉴权来自 `suggested`，旁边标"检测到"；客户端身份默认"自动"，`mcp/login` 不带 `client`，由内核按 D-182 的顺序选；探测失败时可以返回修改、重试或仍然添加 |
| 远程设置页 › 添加并登录（OAuth） | `mcp/login { name, server }` → 浏览器 → `mcp/changed { login_id }` → `config/write` → `mcp/check` | "在浏览器里登录 X"，可以取消；成功后"已添加 X · N 个工具" |
| 远程设置页 › 添加（令牌） | `credentials/set` → `mcp/probe`（带令牌复查）→ `config/write` → `mcp/check` | 复查回 401 时显示"令牌无效"，可以仍然添加；放弃时删掉刚存的凭据 |
| 本地表单 › 添加 | 带锁的值逐个 `credentials/set` → `mcp/probe`（启动、握手、列出工具）→ `config/write` | 三步进度；失败时显示命令的错误输出，可以返回修改、重试或仍然添加 |
| 连接器 ⋯ › 编辑配置 › 保存 | 同上；凭据没改的行不调用 `credentials/set` | "已保存 X，正在检测" |
| 连接器行的开关（自己的） | `config/write { mcp_servers.<名字>.enabled }`，写回定义它的文件 | 返回 `overridden` 时："已关闭，但 <层> 里又打开了它" |
| 连接器行的开关（仓库的） | 个人项目层的 `config/write`：关闭写 `enabled = false`，打开删掉这个键 | "已对你关闭 X：写在你的个人项目配置里，不影响队友" |
| 连接器 ⋯ › 删除 | 5 秒后 `config/write { mcp_servers.<名字>: null }` | "已删除 X，它的令牌一并删除 · 撤销" |
| 状态里的"重试""检测"，⋯ › 重新检测 | `mcp/check` | "正在检测…"，然后是新状态 |
| 状态里的"登录"（二期） | `mcp/login` | 同"要登录的 +" |
| ⋯ › 退出登录（二期） | `mcp/logout` | "已退出 X 的登录，令牌已从钥匙串删除" |
| 提示里的"让打开的会话也用上"（二期） | `mcp/apply { cwd }` | "已推送到 N 个打开的会话，各自在下一次模型请求前生效"；一期不显示这个按钮 |
| 连接器详情 › 工具 | `mcp/tools` | 上方写明来源："来自 2 个打开的会话里的连接"或"3 小时前检测的结果" |
| 顶部"1 个技能没有加载 · 查看" | 来自 `skills/list` 的 invalid 项 | 弹出原因和"打开 SKILL.md" |

### 10.5 文案约定

- **状态**：
  - 可用 · N 个工具；连接失败；未检测；需要登录；已停用；只对你关闭；未加载 · 项目未受信任；
  - 进行中的写"正在检测…""等待授权…"。
- **生效时机**：所有改动的提示都带"新会话起生效"或"新会话起可用"。
- **只读的说明**：
  - 仓库里的："这个连接器写在仓库的 .finx/config.toml 里，随仓库共享，这里只读"；
  - 其他应用目录里的："归那个工具管理"；
  - 仓库 `.claude/skills` 里的（2e）：分组提示"`.claude` 里的技能默认不启用"，行内小字"来自 .claude · 默认不启用"，打开开关就启用；
  - 内置的："会在下次升级时被覆盖"。
- **密钥**："存进系统钥匙串，配置文件里只写引用"。

### 10.6 发现目录

- **数据**：`src/shared/catalog.ts` 导出与 §6 无关的纯数据，页面、构建脚本和测试共用；描述、令牌的说明等文字放在语言文件里（`customize.catalog.<id>`）：

  ```ts
  interface CatalogSkill { id: string; by: string; version: string; license: string; sha256: string; files: number }
  interface CatalogConnector {
    id: string; name: string; mono: string; logo?: string; by: string; docs: string; verifiedAt: string;
    install:
      | { url: string; auth: ConnectorAuth[] }
      | { command: string; args: string[]; auth: ConnectorAuth[] };
  }
  type ConnectorAuth = { kind: "none" } | { kind: "oauth"; url?: string } | TokenAuth;
  interface TokenAuth { kind: "token"; header?: string; prefix?: string; env?: string; placeholder: string; createURL: string }
  ```

- **条目**：2026-10-31 全部清空，按用户的要求逐个重新收录。
  - 清空前有 6 个技能（code-review、write-tests、commit-message、release-notes、api-docs、data-cleaning）和 6 个连接器（GitHub、Context7、Playwright、Fetch、Memory、Brave Search）。
  - 目录为空时，"发现"的两个页签各显示一张空状态卡片：技能给出"上传技能""在对话中创建"，连接器给出"添加自定义连接器"。
  - 已经装进 `~/.finx/skills` 的技能、写进配置的连接器不受影响，只是不再对应目录里的条目。
  - 要 OAuth 的（Linear、Notion、Sentry）等二期的登录做好再收录。
  - 已重新收录的连接器：
    - **Exa**（2026-11-02）：三种方式，推荐不用密钥。
      - 不用密钥：地址 `https://mcp.exa.ai/mcp`，免费额度内能用搜索和读取网页两个工具。
      - 登录：按 Exa 文档改用 `https://mcp.exa.ai/mcp?login`，授权服务器是 `auth.exa.ai`，支持 PKCE、客户端元数据文档和动态注册。
      - API Key：放在 `x-api-key` 请求头。
      - 登录和 API Key 都能多用一个研究智能体。
      - 说明取自服务器自报的 `serverInfo.description`，每种方式的区别写在语言文件的 `catalog.ways.exa.<方式>`。
- **登录方式由用户选（DD-67）**：
  - **条目**：`auth` 列出服务商接受的所有方式，第一个是推荐。登录要用另一个地址的（例如 Exa 的 `?login`），写在 `oauth.url` 里。
  - **一键添加**：只有所有方式都是"不需要鉴权"的条目，点 + 才直接写入。
  - **其余条目**：点 + 或详情页的"添加"都打开添加连接器的设置页（§10.9）。地址已经定了，所以跳过第一步，也不能改地址。
    - "方式"只列这个条目的几种，推荐的那种预先选好，并标上"推荐"。
    - 每种方式的说明换成这个条目自己的话（`catalog.ways.<id>.<方式>`），选中的那种写在表单下面的脚注里。
    - 选令牌时，"发送为"已经填好服务商的请求头，并给出"去 X 获取"的链接。
    - 本地命令的条目没有"发送为"：方式只有令牌和"不需要鉴权"两种，放在命令上面；令牌作为条目的 `env` 变量交给命令，值存进钥匙串。选"不需要鉴权"时什么变量都不写，不会留下一个空变量。
    - 之后的流程照常：令牌先检测再写入；登录先写入，再打开浏览器。
  - **详情页**：列出几种登录方式，第一种标"推荐"。不再在详情页里填令牌。
- **技能文件**：放在仓库的 `apps/desktop/resources/catalog/skills/<id>/`（目录为空时这个文件夹不存在，构建和校验都照常通过）。构建时由 scripts/build-app.mjs 复制到 `Contents/Resources/catalog/skills/`，并校验每个目录的 sha256 与 catalog.ts 一致，不一致就构建失败；单元测试也做同样的检查。sha256 按内核安装时的算法计算（scripts/catalog-hash.mjs），所以装上以后来源记录里的值与目录一致，二期判断"有更新"时直接比较。
- **"已添加"**：
  - 技能：有来源记录时按 id，否则按名字；
  - 连接器：按名字，目录条目的 id 就是默认名字。用户手写了同名的服务器也算已添加，因为再加一个只会重名。
- **收录规则**：
  - **连接器**：对照服务商的公开文档核实地址、传输方式和鉴权方式，实际连通才收录，记下核实日期；
  - **技能**：只收许可允许转发的，附上许可与出处；
  - **图标**：一期用字母缩写（DQ-24）。
- **二期**：在线目录（DQ-30）、技能更新（§9.5）。

### 10.7 主进程

- **`pick-skill-source`**：一个对话框，同时允许选文件夹和文件，文件只限 `.zip`、`.skill`、`.md`。返回绝对路径，页面再交给 `skills/install`。
- **拖放**：拖进上传弹窗的文件，经 preload 取得路径，走同一条路。
- **其余能力**：在访达中显示、打开浏览器都用现有的 `revealPath`、`openExternal`。
- **打包的目录路径**：页面经 preload 取得 `Contents/Resources/catalog/skills`；开发模式下指向仓库里的 `apps/desktop/resources/catalog/skills`。

### 10.8 预览与模拟

- **模拟服务**：packages/client 的模拟服务（mock）实现全部新方法和三个通知，数据与原型一致。浏览器预览（`pnpm --dir apps/desktop web`）和 `FINXWORK_KERNEL=mock` 都能走完所有界面流程。
- **原型**：customize-demo.html 是界面的最终参照，实现时逐屏对照，浅色深色各核对一遍。添加连接器以 connector-add-demo.html 为准（§10.9），它取代 customize-demo.html 里的自定义连接器表单。

### 10.9 添加连接器（v0.6，DD-53–DD-56）

原型：[connector-add-demo.html](connector-add-demo.html)，底部的按钮可以切换各种情况：OAuth 的三种身份、开放的、只要 API Key 的、旧版 SSE、连不上、本地命令、带变量的命令、启动失败、粘贴 JSON。

**第一步：名称和地址**

- **只有两个输入框**，底部是"取消"和"连接"，回车也能提交。
- **名称**可以不填，按地址建议：
  - 远程地址取主机名里去掉 `mcp`、`api` 之后的那一段（`mcp.hermesh.io` → `hermesh`）；
  - 命令取包名，去掉作用域、版本和 `mcp-server-`、`-mcp` 一类的前后缀（`@playwright/mcp@latest` → `playwright`）；
  - JSON 里有名字就用它。

  规则同配置：1–32 个字母、数字、`-`、`_`，不能与已有的重名。建议的名字显示为占位文字，名称框为空时按 Tab 把它填进去，再按一次 Tab 才离开（DD-60）。
- **地址**是一个会自动变高的等宽输入框，占位文字是"https://mcp.example.com/mcp，或者 npx -y @scope/server"。输入时下面实时显示识别结果：
  - `http://` 或 `https://` 开头：远程服务器。不是 https 又不是本机地址时提示令牌会明文传输；
  - 其他协议开头：提示只支持 http 和 https；
  - `{` 开头：按 JSON 解析，接受单个服务器、`mcpServers`、`mcp_servers` 或 `servers` 表，取第一个。页面上不另外提示可以粘贴 JSON（DD-65）；
  - 其余：本地命令。开头的 `KEY=值` 拆成环境变量，名字像密钥的自动上锁。
  - 已经有连接器连着同一个服务（按 mcp-design §13.10 的标识，与名字无关）：识别结果换成红字"X 已经连着这个服务了，同一个服务只需要一个连接器"和"打开 X"，"连接"不可用（DD-62）。编辑连接器时改成别的连接器的地址，保存时同样提示。

**远程地址：探测，然后设置**

1. 点"连接"后，表单收成一行摘要，下面是三步进度：连接服务器、查找登录设置、检查登录服务。每一步右侧显示结论，例如 `401`、`OAuth`、`PKCE`、`可自动登记`；不需要的步骤显示"不需要登录"并跳过。
2. 探测完自动进入设置页，形式是系统设置那样的分组表单（DD-58）：左边是名称，右边是控件，行与行之间一条细线；多选一用弹出按钮，不用单选组。
   - **摘要**：名称、地址、传输方式，"修改"回到第一步。
   - **鉴权**一组：
     - "方式"一行，弹出按钮三选一：用账号登录（OAuth）、令牌或 API Key、不需要鉴权。探测得出的那一项默认选中，按钮和菜单里都标"检测到"；服务器没有公布登录服务时，OAuth 一项灰掉并写明原因。每项的说明写在菜单里。
     - 选了 OAuth，主表单里不再多出任何一行：finx 以什么身份去登录服务（公布的身份或自动登记）是 finx 自己的事，用户不用知道（DD-59）。只有登录服务不接受应用自动登记时（如 GitHub），才直接多出 Client ID、Client Secret（可不填，存钥匙串）两行。
     - 选了令牌，多"令牌"（存进钥匙串的输入框）和"发送为"两行；"发送为"平时只显示 `Authorization: Bearer ‹令牌›`，点"修改"换成请求头名字和前缀两个输入框。
   - **组下的脚注**：先写检测到了什么（蓝色），再写添加后会怎样（"在浏览器里用你的 X 账号登录"）；用自己的应用时写出回调地址；服务器只能用自己的应用时，提示服务商若提供个人访问令牌，选令牌更省事。界面上不出现"注册""身份"这类会被理解成账号的词，说"登记应用""OAuth 客户端"。
   - **高级选项**（默认收起，标题旁写当前值）：OAuth 客户端（选了 OAuth 才有；"自动"或"你自己的 OAuth 应用"，登录服务不接受自动登记时"自动"灰掉）、传输方式（弹出按钮，自动选好）、请求头（带锁的值存钥匙串）。
   - 最后一句信任提示。页头和底部按钮固定，只有中间的表单滚动。按钮是"返回"和"添加并登录"（OAuth）或"添加"。
3. OAuth：显示"在浏览器里登录 X"的等待页，登录成功后才写配置。
4. 完成页：勾、"已添加 X"、"N 个工具 · 新会话起可用"和前几个工具名，按钮"完成"。

**本地命令：表单，然后检查**

- 表单（同样是分组表单）：摘要（名称、"本地命令"、"修改"），命令一组（可编辑，下方按词显示解析结果），环境变量一组（带锁的值存钥匙串，脚注说明上锁的含义），"高级选项"里的工作目录，底部写明本地命令以你的身份运行。npx、uvx 一类第一次运行要下载，提示检查可能要几十秒。
- 点"添加"后在同一张表单里跑三步检查：启动命令、完成握手、列出工具。通过了才写配置。失败时显示命令的错误输出，可以返回修改、重试或仍然添加。

**取代的部分**：一期的 ConnectorForm（先选类型、再按类型给不同表单）已删除；编辑见 §10.11。

### 10.10 连接器的 logo 怎么画（v0.11，DD-63）

logo 来自服务器声明或它的网站（mcp-design §13.9），形态各异：有的是 iOS 那样铺满的方形图标，有的是透明底上的一个标记，有的只有 16 像素。照应用商店展示别人图标的做法，页面先读 logo 的像素再决定怎么画（`src/shared/logo.ts`），不给所有 logo 套同一个白框：

- **图块**：不透明、方形，四边中点和四角往里一点都是实的（圆角方形是，圆形和横排的字标不是）。它本身就是连接器的图块：铺满整个形状，四周不加底、不留白，圆角用图块的 `--r-*`。
  - 图块外面若有一圈透明边（macOS 风格的图标常有），先裁掉再铺满。
  - 上面盖一条 0.5px 的内描边：浅色主题是黑 10%，深色主题是白 12%，让白色图标在浅色页面上、黑色图标在深色页面上都有边。
  - 自带圆角的图标（四角透明）保留自己的圆角，不画描边，免得描边和它的圆角对不上。
- **标记**：透明底上的图形，放在普通图块的底色上，四周留白，最大占边长的 62.5%。
  - 看标记的平均亮度：很暗的标记在深色主题下换成近白的底，很亮的在浅色主题下换成深灰的底，其余用普通底色。只有标记会看不见时才换底。
- **不放大到发虚**：图块的原图边长小于要画的尺寸时，按标记画，最大画到原图的像素尺寸。原图小于 16 像素时不画，显示首字母。SVG 不受这条限制。
- 解码失败、全透明时显示首字母。解码在渲染进程里做一次，按图片缓存；解码完成前图块先空着，不先闪一下首字母。
- **目录条目的 logo**（DD-68）：发现里的条目还没添加，没有探测过，也就没有找到的 logo。条目的 `logo` 指向随应用带的文件（`src/renderer/src/assets/connectors`，取服务器握手里声明的图标），发现的卡片、目录详情页和添加流程用它；添加之后用服务器自己的 logo，还没找到时仍用这份。没有 `logo` 的条目显示首字母。

### 10.11 编辑配置（v0.11，DD-64）

连接器详情页的"编辑配置"打开一张和添加流程设置页一样的表单（`customize/EditConnector.tsx`）。两边用同一套组件（`customize/ConnectorFields.tsx`：鉴权一组、脚注、高级选项、命令、环境变量），同一个设置在两边的样子和用法一样。

- **页头**：标题"编辑 X"，下面一行摘要：logo、名称、类型（远程、远程 · SSE、本地命令），以及写在哪个文件里。名称不能改；远程和本地不能互换（那是另一个连接器，删掉重新添加）。
- **远程**：
  - "地址"一组，可以改。
  - 鉴权、脚注、高级选项与添加时相同，初始值从配置文件读出来：`auth = "oauth"` 是用账号登录；请求头里引用 `mcp.<名称>` 凭据的那一行是令牌，"发送为"取它的请求头名字和前缀；`oauth.client_id` 有值是用自己的 OAuth 应用。其余请求头进高级选项。
  - 打开时在后台重新探测一次地址（`mcp/probe`，不带凭据），地址改了停顿 0.6 秒再探测。探测中脚注写"正在检测这个地址…"；探测完和添加时一样写检测结果、标"检测到"；没连上时写明这次没连上，下面是现在保存的设置，选项都不灰掉。
- **本地**：命令、环境变量和高级选项里的工作目录，与添加时相同。
- **已经存在钥匙串里的值**：输入框留空，占位文字写"已存进钥匙串 · 输入新值即更换"；留空保存时文件里的引用不变，输入了新值才调用 `credentials/set`。
- **保存**：
  - 只写这些字段（`merge = "upsert"`），配置里其他字段（工具筛选、超时等）不动；编辑留在原来的层。
  - 地址或命令改成另一个连接器已经连着的服务时，提示并拒绝保存（DD-62）。
  - 不再用令牌时删掉钥匙串里的令牌；不再用 OAuth 时退出登录。
  - 新改成 OAuth，或者地址、OAuth 客户端变了，或者现在需要登录：按钮是"保存并登录"，写完配置就打开浏览器登录，和详情页的"在浏览器里登录"一样。否则按钮是"保存"，保存后检查一次，结果用提示条告诉用户。

### 10.12 连接器详情页（v0.12，DD-66）

原型：[connector-detail-demo.html](connector-detail-demo.html)，底部可以切换可用、需要登录、连接失败、已停用、本地命令、没有说明几种情况。一期的页签（概览、工具）和右侧的信息卡片去掉，整页一栏，最宽 852，没有框也没有分割线，层次只靠字号、字重和留白。

- **间距**（v0.15 收紧，技能详情页同样）：三档。同一组内 8：事实与它的注脚、"工具""文件"标题与下面的内容；页头里各组之间 21：返回到标题、标题到事实、事实到提示条、到"简介"；页头与下面的列表之间 34。原来是 13、34、55，同一组的东西隔得太开，整页显得散。
- **顶行**：只有"← 连接器"。
- **操作**："启用"开关和 ⋯ 放在标题行的最右边，和 logo、名字垂直居中，右边缘和下面"重新检测"对齐：它们是这个连接器的操作，跟着它的名字走，不悬在返回那一行。⋯ 平时只有图标，悬停或打开时才有底色。随仓库共享的连接器开关写"对你启用"；项目未受信任时不显示开关。
- **⋯ 菜单**：编辑配置…（能编辑的才有），分隔线，重新检测、复制地址（本地的是复制命令）、退出登录（用 OAuth 且已登录时），分隔线，删除连接器（红色）。不再有"在访达中显示配置文件"。
- **标题**：48 的 logo（§10.10），26 号的名字，旁边是"自定义"或"仓库"标签。
- **事实一行**紧跟在标题行下面（间距 21），所有值用同一种字体、同一字号（13），地址、命令、路径也不用等宽字，太长以省略号结尾。
- **事实一行**：每项小标签在上、值在下，列间 34：
  - 状态：圆点加一个词（可用、需要登录、连接失败、已停用、未检测、未加载），颜色同列表；
  - 账号（OAuth，值是地址去掉 `mcp.`、`api.` 这类前缀后的主机，后面浅色"已登录""未登录"），或令牌、密钥（值是键名，后面浅色"在钥匙串里""钥匙串里没有"）；不需要鉴权时没有这一项；
  - 地址或命令：占满这一行剩下的宽度，太长就以省略号结尾；悬停时旁边出现复制按钮。
  - 配置文件不显示：用户不需要知道它写在哪个文件里。
- **提示**：只在需要用户处理时出现，在事实下面，按钮在右边：需要登录（"在浏览器里登录"，登录中显示等待和"复制链接"）、连接失败（错误原文和"重试"）、项目未受信任、随仓库共享（只读说明）。
- **工具**：标题"工具 N"，右边"N 分钟前检测"和"重新检测"；一行一个，名字一列（172）、说明一行，悬停变浅底，点一下展开完整说明。没连上或没登录时写"连上之后（登录之后），这里列出它提供的工具"。
- **停用**：logo、事实和工具变淡，顶行不变，方便直接打开。
- 进入时标题区和工具区依次淡入上浮（减少动态效果时不动）。

### 10.13 技能详情页（v0.15，DD-69）

原型：[skill-detail-demo.html](skill-detail-demo.html)，底部可以切换我的、仓库、`.claude` 默认不启用、内置、发现里未添加、只有 SKILL.md 几种情况，以及对比用的"保留页签"。布局与连接器详情页（§10.12）相同：去掉页签和右侧的信息卡片，整页一栏，最宽 852，层次只靠字号、字重和留白。

- **顶行**：只有"← 技能"。
- **标题行**：48 的技能图标，26 号的名字，旁边按需显示"内置"或"仓库"标签。最右边依次是：
  - "在对话中使用"：技能停用时变灰；
  - "启用"开关；
  - ⋯ 菜单：在访达中显示；自己目录里的技能另有分隔线和"删除技能"（红色）。
  - 发现里还没添加的技能，这里只有一个实心的"添加"。
- **事实一行**：紧跟在标题行下面，小标签在上、值在下，所有值同一种字体（13 号），不用等宽字：
  - 来源（上传、finx 精选、仓库、来自 .claude、finx 内置……）；
  - 范围：只有个人和仓库的技能显示（"个人""随仓库共享 · 项目名"），内置和配置路径里的技能与来源重复，不显示；
  - 调用：`/skill:名字`，只能手动调用的后面浅色写"只能手动调用"，悬停时出现复制按钮；
  - 路径：占满这一行剩下的宽度，太长以省略号结尾，悬停时出现"在访达中显示"。
  - 未添加的技能是来源、许可、添加到。
- **说明**：仓库里的、`.claude` 里默认不启用的、别的工具目录里的、配置路径里的，各一句；内置技能没有说明，"内置"标签已经说清楚了。它只是要知道的事，没有要做的事，所以不用连接器页那种带底色的提示条（那是给需要登录、连接失败这类要处理的事的），而是事实下面 8 处一行 12 号的灰字，最宽 600，像事实的注脚。
- **技能简介**：当作事实里的又一项：小标签"技能简介"与事实的标签同样（11.5 号、最浅的灰），下面隔 3 是 SKILL.md 头部的 description，与事实的值同样（13 号、正文颜色），最宽 680。在事实（或说明）之后隔 21，"文件"在它之后隔 34。连接器页同样，标签是"连接器简介"，在提示条之后、"工具"之前；没有说明时整块不显示。
- **文件**：标题"文件 N"（N 是文件数，不含文件夹），下面一个细框，高度固定（窗口高度减 140，介于 320 和 640 之间），滚到这里时正好占满窗口；文件树和文件在框里各自滚动，文件再长页面也不变长。
  - **左栏，文件树**：按目录层级缩进，每层 14；SKILL.md 排第一，然后是文件夹，再是文件，各按名字排序。文件夹前是展开、收起的箭头，默认全部展开；点文件打开它，打开的那行是浅底、加粗。名字太长以省略号结尾，悬停显示完整路径。只有 SKILL.md 一个文件时不显示文件树。窗口窄于 720 时两栏上下排列。
  - **右栏，打开的文件**：默认是 SKILL.md。顶行左边是等宽的路径（`/references/formats.md`），右边：
    - Markdown 文件有一对小图标按钮，眼睛是预览、`</>` 是原文；选中的那个有底色。选择在这一页里保持，换文件不变；
    - 已添加的技能有一个文件夹按钮，在访达中显示这个文件；目录里还没添加的技能没有。
  - **内容**：
    - Markdown 预览用对话里的同一个 Markdown 组件渲染，头部（`---` 之间的 name、description）不显示，页头已经有了；
    - Markdown 原文是等宽的原样文本，头部用浅色；
    - 其他文本按扩展名着色（与对话里的代码块相同），认不出的扩展名就是原样文本；
    - 图片（PNG、JPEG、GIF、WebP，按文件签名认）按原尺寸显示，最宽占满右栏，透明处是棋盘格底；点一下铺满窗口看，点任意处或 Esc 关闭（与输入框附件的放大相同）。SVG 和 Markdown 一样有预览、原文两种，预览当作图片显示，原文按 XML 着色；
    - 其他不是文本的文件写"这个文件不是文本，不能在这里查看"；读不到时写错误原文；超过 256 KB 时在内容上方写"只显示了前 256 KB"。
- **停用**：图标、事实和文件框变淡，标题行的控件不变。
- 进入时标题区和文件区依次淡入上浮（减少动态效果时不动）。
- 能选中的文字（描述、事实里的值、文件内容、对话里的 Markdown）悬停时显示文本光标，与输入框相同；其中的按钮仍是箭头。
- 版本、下载暂不做。以前保存的页签不再有意义，详情页一律从头显示。

## 11. 安全

- **谁能调用**：管理方法和其他方法一样，只对同一用户的本机连接开放（desktop-kernel-integration §11）。
- **不碰仓库**：页面不写仓库里的配置和技能（DD-46）；仓库里的连接器仍然需要信任项目才会加载（mcp-design §4.4）。个人项目层是用户自己的文件，不受此限。
- **技能也是指令**：
  - 装上的技能会成为以后每个会话的指令。从网上下载的，等于把一段指令交给模型。
  - 上传前先预览 SKILL.md；精选目录里的经过人工审阅；安装不执行技能里的任何脚本。
  - 压缩包按 §9.1 的规则检查路径和大小。
- **本地连接器会在本机执行命令**：
  - 添加和检测都会运行配置里的命令，`npx -y` 这类还会当场下载第三方包；
  - 推荐卡片的详情页和自定义表单都写明将要运行的命令；
  - 子进程的环境仍按白名单（mcp-design §5.7）。
- **密钥**：
  - 只在 `credentials/set` 的那一次经过协议，之后只在钥匙串里；
  - 配置文件里只有引用；返回给页面的只有"已保存"或"缺失"；
  - 删除服务器时一并回收（§4.7）。
- **OAuth（二期）**：
  - 授权码流程带 PKCE 和 state，只在 127.0.0.1 上监听，5 分钟超时；
  - 令牌和服务器地址绑定；
  - 续期时加跨进程的锁。

## 12. 性能

| 场景 | 目标 | 做法 |
|---|---|---|
| 打开页面 | 三个读取请求合计 20 ms 以内（25 个技能、10 个连接器） | `skills/list` 现成（25 个约 1 ms 加读描述）；`config/read` 读几个小文件、算 SHA-256；`mcp/list` 读配置和缓存、查一次打开的会话，不连接、不读钥匙串的值 |
| 写入一次 | 5 ms 以内（不含钥匙串） | 一次加锁、解析、合并、写临时文件、rename |
| 会话启动 | 不变 | 个人项目层多一次 stat；内置技能多一个根目录；`${credential:…}` 第一次读钥匙串约 10 ms，之后用缓存 |
| 空闲 | 不占 CPU | FSEvents；通知节流 2 秒 |
| 检测 | 不阻塞其他请求 | 在后台任务里进行，同一个服务器合并成一次 |

实现后用 tools/bench 补一个脚本，测前三项；会话启动时间用现有的 bench_startup.py 对比。

## 13. 代码落点

| 位置 | 新增或改动 |
|---|---|
| finx-core `config.rs` | 个人项目层；`skills.disabled` 拼接；每个键的来源（`mcp_sources` 改为由它导出） |
| finx-core `config_edit.rs`（新） | §5.1 的写入流程：键路径、toml_edit、版本号、锁、校验、覆盖判断、凭据回收的计划 |
| finx-core `paths.rs` | `projects_dir`、`project_key`、`mcp_cache_dir`、`system_skills_dir` |
| finx-core `runtime.rs` | `Workspace::open` 读个人项目层 |
| finx-core `skills/install.rs`（新） | 安装、删除（trash）、文件列表、来源记录 |
| finx-core `skills/system.rs`（新） | 内置技能：编译进来的文件、指纹标记、写入；`roots()` 加内置一层 |
| finx-core `mcp/cache.rs`（新） | 工具目录缓存的读写与清理；McpManager 状态变化时写入 |
| finx-mcp `env.rs` | `${credential:名字}` 展开 |
| finx-mcp | 检测入口（复用 McpClient）；401 时判断是否需要登录；二期 OAuth 与续期 |
| finx-llm `credentials.rs` | 不改接口；新增"是否存在"的查询（结果缓存，不读值） |
| finx-protocol `api.rs` | §6 的类型、方法名常量、错误码、capabilities 的 `customize`、SkillScope 的 `system`；重新生成 schema.json |
| finx-server `customize.rs`（新） | 方法、订阅与通知、检测的合并、从打开的会话取实时状态 |
| finx-server `watch.rs`（新） | 文件监视与节流 |
| finx-server `native.rs` | 方法分派 |
| finx-cli `cmd_mcp.rs`、`cmd_info.rs` | `finx mcp add/remove/enable/disable`、`finx skills add/remove/enable/disable` |
| packages/protocol | 随 schema 重新生成 TypeScript 类型 |
| packages/client `mock/` | 模拟服务实现新方法 |
| desktop 渲染进程 | `customize/` 全部（§10.2）；`store.tsx` 的 Selection；`MainWindow.tsx` 的路由；`sidebar/Sidebar.tsx` 的入口；`icons.tsx` 的新图标 |
| desktop 主进程与 preload | `pick-skill-source`；打包目录的路径 |
| desktop 资源与构建 | `resources/catalog/skills/`；scripts/build-app.mjs 复制并校验 |

新增依赖，都是纯 Rust，体积增量预计在 1.5 MB 以内，构建后实测：

| 依赖 | 用途 |
|---|---|
| toml_edit | 保格式写入 |
| zip | 解压技能包 |
| trash | 移到废纸篓 |
| notify | 文件监视 |
| include_dir | 内置技能，也可以用 build.rs 代替 |

## 14. 实施计划

### 14.1 一期

| 步 | 内容 | 预估 | 完成的标志 |
|---|---|---|---|
| 1 | 配置：个人项目层、`skills.disabled` 拼接、键的来源 | 1 天 | 合并顺序和来源的单元测试通过 |
| 2 | `config_edit` 与 `config/read`、`config/write`、`credentials/*`；`${credential:…}`；凭据回收 | 1.5 天 | 保格式、版本冲突、校验、覆盖、回收的测试通过；`finx mcp add/remove/enable/disable` 可用 |
| 3 | 技能：安装、删除、启停、文件；内置技能；`skills/list` 的新字段 | 1.5 天 | 三种来源的安装、冲突、越界检查的测试通过；`finx skills add/remove/enable/disable` 可用 |
| 4 | 连接器：`mcp/list`、`mcp/tools`、`mcp/check`，工具目录缓存，从打开的会话取状态 | 1 天 | 用 finx-mcp-server 跑通成功、失败、超时；会话里连着时状态来自会话 |
| 5 | 文件监视与三个通知；capabilities；schema 与 TypeScript 类型；模拟服务 | 1 天 | 命令行改了配置，2 秒内收到通知 |
| 6 | 桌面：路由与入口、"我的"与"发现"、详情页、表单、上传、在对话中创建、打包的目录 | 3 天 | 原型里的每个动作在真实内核上走通，浅色深色截图与原型一致 |
| 7 | 验收：§15 的全部，包括一份真相和真实服务 | 0.5 天 | §15 全部通过 |

合计约 9.5 个工作日。步骤 1–5 与 6 可以部分并行：桌面先接模拟服务。

### 14.2 二期

| 内容 | 依赖 |
|---|---|
| OAuth 登录、续期、退出（§8.3） | 一期的凭据与检测 |
| `mcp/apply` 推到打开的会话（§8.4） | McpManager 支持增删服务器 |
| 用缓存加快会话启动（Q-112） | 一期的工具目录缓存 |
| 在线目录与技能更新（§9.5、DQ-30） | 一期的来源记录 |
| 添加连接器的新流程（§10.9）、`mcp/probe` | 内核的探测（mcp-design §13.6） |
| 旧版 SSE 连接器 | 内核的 SSE 传输（mcp-design §13.7） |
| finx 的客户端元数据文档 | 已公布在 `https://finxwork.ai/oauth/client.json`（mcp-design Q-119） |
| 工具页签里逐个工具的开关（DQ-29） | `config/write` |

### 14.3 实现记录（一期，2026-10-31）

与上文不同、或上文没写到的地方：

- **锁文件**：放在 `~/.finx/run/locks/`，不放在配置文件旁边（§5.1）。仓库文件经 `--project` 写入时保留原来的权限，不改成 0600。
- **`.mcp.json` 与个人项目层**：配置里只写设置、不写命令和地址的条目（例如个人项目层的 `enabled = false`），叠加到 `.mcp.json` 里同名的服务器上，"只对你关闭"因此对 `.mcp.json` 的服务器同样有效。关掉一个这里并不存在的服务器（未受信任项目的），不再列出一个空条目。
- **凭据的名字**：页面上带锁的值存为 `mcp.<服务器>.<键>`；配置里原有的写法（如 `Bearer ${credential:…}`）保留引用前后的文字。命令行 `--token` 存为 `mcp.<服务器>`，`--secret-env K` 存为 `mcp.<服务器>.K`。
- **编辑连接器**：在原来的层里只改表单里的字段（`upsert`），用户手写的其他字段保留；不提供换层（DD-57）。
- **开关**：打开时删掉关闭它的那一层里的设置；那一层不归 finx 写（仓库的），就在个人项目层写 `enabled = true`。命令行的 `enable/disable` 用同样的规则。
- **已停用的技能**不出现"在对话中使用"。
- **添加连接器**（2026-10-31，§10.9）：
  - **组件**：`customize/AddConnector.tsx`。第一步只有名称和地址；远程地址走 `mcp/probe`，按 `mcp/probe_progress` 画真实的三步；本地命令进入表单，添加时同样先探测。
  - **身份选择**：选了 OAuth 时，`mcp/login` 带上 `server` 和页面选的 `client`。
  - **失败**：可以返回修改、重试或仍然添加；为检查存下的凭据在放弃时删掉。
  - **入口**：添加菜单的"添加连接器…"、连接器的空状态都打开它。一期的 ConnectorForm 已删除，编辑见 §10.11。
  - **原型差异**：同类的 sheet 都没有右上角的 ×，所以这里也不加，与原型不同；底部按钮在长表单里固定在底部。
  - **模拟服务**：支持 `mcp/probe`（按地址模拟原型里的各种情况，带进度通知）、`mcp/login`（2.5 秒后回来）、`mcp/logout`。异步的方法在模拟服务里等结果出来再应答。
  - **验收**：`e2e/customize.mjs` 用真实的 finx 新增两步：
    - 带上锁变量的本地命令：先检查后写入，配置里只有引用；
    - OAuth 服务器（`finx-mcp-server --oauth`）：检查后在设置页默认选 OAuth；写入之前从页面取授权地址，用 fetch 扮演浏览器；登录后才写入配置，令牌在凭据库里，`finx exec` 能用它。
- **发现目录清空**（2026-10-31，§10.6）：`catalog.ts` 的两个列表为空，`resources/catalog` 删除，语言文件只留 `catalog.by`；条目的文字经 `catalogText` 按键名读取，键随目录增减。验收脚本改为先确认"发现"是空状态，再用 `finx skills add` 装一个技能，看"我的"跟上（实测 919 ms）。
- **验收脚本**：`apps/desktop/e2e/customize.mjs` 用真实的 finx、finx-mock 和 finx-mcp-server 走 §15 的 CG1 三步，可选截图；finx-mock 为此加了 `mcp_env:SERVER:VAR` 场景，读出服务器进程拿到的环境变量。

## 15. 测试与验收

- **Rust 单元测试**：
  - 保格式写入：用带注释和空行的配置做对照文件，修改前后逐字节比较；
  - 版本号：读后被别人改过的文件，写入返回冲突；
  - 并发：两个进程同时改，结果不丢；
  - 写前校验：非法输入不落盘，错误带键路径；
  - 覆盖：项目配置盖住了个人的写入时返回 `overridden`，带层和文件；
  - 凭据回收：删掉最后一个引用时凭据被删，还有别处引用时保留；
  - 个人项目层：项目键的计算、合并顺序、未受信任项目里照常加载；
  - `skills.disabled`、`skills.opt_in` 跨层拼接；
  - 开关（2e）：默认启用与默认不启用的技能各自打开、关掉，写入与清理的列表正确；
  - `${credential:…}`：展开、缺失时的报错、日志里只有引用；
  - 安装：目录、SKILL.md、压缩包三种来源；dry_run；同名冲突与替换；符号链接越界；压缩包里的 `..`、绝对路径、设备文件；大小、数目和深度上限；
  - 内置技能：首次写入、指纹相同时跳过、升级后重写；与用户技能同名时用户的优先；
  - 缓存：指纹不同不复用；大小与数目上限。
- **服务端到端测试**：
  - `mcp/check` 用 finx-mock 的 `finx-mcp-server`：成功、失败、超时；
  - 远程服务器回 401 并带资源元数据时判为需要登录；
  - 打开的会话连着服务器时，`mcp/list` 的状态来自会话；
  - 监视：命令行改了配置，2 秒内收到 `config/changed`；服务自己写的不重复通知；
  - 凭据只在 `credentials/set` 的参数里出现，日志和返回里都没有；
  - 协议消息按 schema.json 校验。
- **一份真相的验收（CG1）**：
  1. 在桌面页加一个令牌类连接器和一个技能；
  2. 用 `finx exec` 跑一个要用到它们的任务，确认都可用；
  3. 用 `finx mcp remove` 删掉连接器，确认桌面页在 2 秒内更新，钥匙串里的凭据被回收。
- **桌面端**：
  - 经 CDP 驱动隔离的开发版（FINX_HOME 指向临时目录、`FINX_CREDENTIAL_STORE=file`），按 §10.4 的表逐项走一遍；
  - 浅色深色各截一张图，与原型对照。
- **真实服务**：一期用一个令牌类的远程服务器跑通添加、检测、会话里调用；二期用一个 OAuth 服务器跑通登录、续期、退出。

## 16. 决策

| 编号 | 决策 | 理由 | 章节 |
|---|---|---|---|
| DD-30 | 管理方法放在 finx 服务，桌面端只做界面 | 一份实现，命令行和编辑器同样受益；内核运行时不改；与模型密钥、模型连接的做法一致 | §3.1 |
| DD-31 | 不在 `session/new` 注入；新会话照旧从文件加载 | 文件本来就是内核的输入，注入只会多出第二份清单，还让密钥每次过协议 | §3.2 |
| DD-32 | 只写 finx 已经在读的位置，不建桌面私有清单 | CG1 | §4.2 |
| DD-33 | 新增个人项目层 `~/.finx/projects/<项目键>/config.toml`，合并时排在项目配置之后 | "仅这个项目"不必写进仓库；顺带解决在自己的配置里关掉仓库里的服务器（Q-108） | §4.3 |
| DD-34 | 停用技能写用户配置的路径形式；`skills.disabled` 跨层拼接 | 只停这一份；仓库里的配置不能覆盖个人的停用 | §4.4、§9.3 |
| DD-35 | 删除移到废纸篓；界面的撤销用 5 秒延迟提交 | 删掉的东西找得回来；撤销不需要内核配合 | §9.2、§10.3 |
| DD-36 | 其他客户端目录里的技能可以停用，不能在页面里删除或编辑 | 那些目录归别的工具管；停用只改 finx 自己的配置 | §4.2 |
| DD-37 | 密钥存钥匙串，配置里写 `${credential:名字}` 引用，连接时展开；只在 `credentials/set` 时经协议传一次 | IG6、CG4；配置文件可以放心给人看；桌面用户不必去设环境变量 | §4.7 |
| DD-38 | 凭据跟着配置走：最后一个引用消失时回收；OAuth 令牌与服务器地址绑定 | 同名重加或换地址不会继承旧令牌 | §4.7 |
| DD-39 | 连接器的状态先取打开的会话，再取工具目录缓存；页面不拉起进程 | CG3；服务承载着所有会话，有现成的实时状态可用 | §8.1 |
| DD-40 | 写入用 toml_edit 保格式；版本号防并发覆盖；文件锁、原子替换；写前校验单个文件和合并结果；被更高的层盖住时如实报告 | CG5；命令行与服务同时写也不出错；用户知道自己的设置为什么没生效 | §5.1 |
| DD-41 | 发现目录归桌面端；一期随应用打包，构建时校验技能文件的 sha256 | CG6；首屏不等网络；打包的内容与目录一致 | §10.6 |
| DD-42 | "已添加"按来源记录判断，没有记录时按名字 | 手写的同名项也算已添加，避免重名 | §10.6 |
| DD-43 | 改动默认对新会话生效 | 系统提示词是请求前缀，中途改写会让缓存失效 | §3.2 |
| DD-44 | 命令行的同名命令与服务的方法调用同一组函数 | 一份实现；也方便测试 | §7 |
| DD-45 | 通用的 `config/read`、`config/write` 加 `credentials/set`、`credentials/delete`；连接器的增删改、启停都走它们 | 校验、版本号、覆盖提示、通知只有一处；以后的设置页直接复用 | §6.1 |
| DD-46 | 页面和 `config/write` 只写用户自己的文件；仓库里的文件只读 | 团队共用的文件不该被管理页悄悄改动；要改就自己编辑或经审批 | §4.2 |
| DD-47 | 内置技能编译进 finx，写到 `~/.finx/skills/.system`，作为优先级最低的一层 | 命令行和编辑器同样可用；"在对话中创建"不必先安装 | §4.6 |
| DD-48 | 服务监视技能目录和配置文件，节流 2 秒后通知；窗口重新获得焦点时页面再取一次作为兜底 | 命令行、编辑器、模型改的文件也能及时反映到页面 | §5.3 |
| DD-49 | 连接器的改动可以由用户选择推到打开的会话（二期），在下一次模型请求之前替换工具集合 | 机制已有（mcp-design §5.4）；代价是每个会话一次缓存未命中，所以不自动做 | §8.4 |
| DD-50 | 远程服务器要不要登录由检测得出（401 与受保护资源的元数据），不依赖目录条目 | 自定义的连接器也能直接提示登录 | §8.2 |
| DD-51 | 新错误码 −32023 至 −32030（§6.7） | 页面要按错误种类给出不同的处理：重取、提示只读、按字段显示 | §6.7 |
| DD-52 | 技能默认是否启用由内核按位置判断，经 `default_enabled` 告诉页面；页面只有一个开关，仍调用 `skills/set_enabled`，不知道背后写的是 `opt_in` 还是 `disabled`（2e，skill-design D-173、D-175） | 规则只在内核里有一份，命令行和页面一致；页面不必理解配置的细节 | §9.3 §10.4 |
| DD-53 | 添加连接器的第一步只有名称和地址；地址一个输入框接受网址、命令和 JSON，按内容识别；名称可以留空，按地址建议 | 用户手里通常只有一个地址或一条命令；先选类型再填表，要求用户先懂 MCP 的传输方式 | §10.9 |
| DD-54 | 所有添加路径先检查、后写入：远程先探测，OAuth 先登录，令牌先复查，本地先启动检查；失败时由用户决定是否仍然添加；放弃时删掉为检查而存的凭据和令牌 | 不把连不上的连接器悄悄写进配置；用户随时取消，配置和钥匙串里都不留东西 | §10.9 §6.3 |
| DD-55 | 鉴权的默认值来自探测：401 加登录服务为 OAuth，401 没有登录服务为令牌，200 为不需要；客户端身份按 mcp-design D-182 的顺序默认选中；检测到的一项标"检测到"，用户仍可改 | 用户不必知道服务器用哪种鉴权，也能看懂为什么这样选 | §10.9 |
| DD-58 | 添加连接器的设置页用分组表单：一行一个设置，多选一用弹出按钮，说明放进菜单和组下的脚注；页头和按钮固定，表单在中间滚动 | 单选组每项带一段说明、身份再嵌套一组，弹窗又高又乱，按钮随内容滚走；分组表单是 macOS 系统设置的做法，常见情况下整页不用滚动 | §10.9 |
| DD-60 | 名称框为空、有建议的名字时，Tab 把建议填进去 | 建议已经显示在占位文字里，照着再敲一遍是多余的；这是补全的通行做法 | §10.9 |
| DD-61 | 连接器显示服务的 logo（mcp-design §13.9）：列表、详情页，以及添加流程探测完之后的摘要；没有就显示首字母。怎么画见 DD-63 | 一眼认出是哪个服务；自定义的连接器也和精选的一样好看 | §10.9 |
| DD-63 | logo 按形态画（§10.10）：方形不透明的铺满图块、加 0.5px 内描边；透明底的标记放在图块底色上留白，只在会看不见时换底；不把小图放大到发虚，小于 16 像素显示首字母 | 一律套白底会给已经是图块的 logo 再加一圈白框；应用商店展示别人的图标就是铺满、统一圆角、加一条细描边 | §10.10 |
| DD-64 | 编辑配置用添加流程的设置页，两边共用组件；远程地址打开时重新探测 | 一期的编辑表单是另一套样子和用法，同一个设置在两处要学两遍；重新探测让"检测到"在编辑时也成立 | §10.11 |
| DD-65 | 添加连接器的第一步不再写"也可以粘贴一段 JSON 配置"，JSON 照样识别 | 会粘贴 JSON 的人不用提示，不会的人看了也不知道去哪找；地址框下面的识别结果已经说明认出了什么 | §10.9 |
| DD-66 | 连接器详情页一页到底：去掉页签和右侧信息卡片；启用和 ⋯ 在标题行右侧，编辑收进 ⋯；事实（状态、账号或密钥、地址）排成一行，不显示配置文件；工具一行一个 | 页签和卡片把很少的信息分得很散，开关和编辑又不在一处；多次出 demo 比较后，大标题、一行事实、一行一个工具最清楚，操作和名字在同一行，看得出是对这个连接器的操作 | §10.12 |
| DD-67 | 从发现添加连接器时由用户选登录方式：条目列出服务商接受的所有方式，第一种是推荐；只有不需要鉴权的条目一键添加，其余打开添加连接器的设置页，只列这几种方式 | 同一个服务常有几种接法（免密钥、账号登录、API Key），能用的工具、额度和网络要求各不相同，该由用户按自己的情况选；目录只给推荐。设置页沿用自定义连接器的那一套，选项、脚注和后续流程都一样 | §10.6 |
| DD-69 | 技能详情页与连接器详情页一致，一页到底：标题行带操作，下面依次是一行事实（同一种字体）、需要时的说明、"技能简介"（描述）、"文件"——固定高度的框里，左边文件树、右边打开的文件，Markdown 和 SVG 默认预览、可切到原文，图片直接显示、点开放大，渲染用对话里的 Markdown 组件；内核新增 `skills/read` 读技能目录以内的单个文件，图片带上 base64 | 原来的"概览"只有描述和几项事实，放进页头正好，页签就多余了；两个详情页一个样子更好认。一个技能的说明往往分在 references 里，要能就地读到；框定高，长文件不撑长页面。`skills/read` 只读、只限技能目录，不给页面打开任意文件的能力 | §6、§9.4、§10.13 |
| DD-68 | 目录条目随应用带上服务商的 logo，没添加时也显示；添加后优先用服务器自己的 logo（v0.14） | 发现是第一眼认服务的地方，只有首字母的卡片和点进去的详情页对不上；列表不联网（mcp-design D-190），所以 logo 只能随应用带 | §10.10 |
| DD-62 | 同一个服务只连一次（mcp-design §13.10）：输入地址时立刻提示，并给出打开已有连接器的入口 | 两份相同的工具只会让模型困惑；在用户点"连接"之前就说，省得白等一次探测 | §10.9 |
| DD-59 | 页面不让用户在"公布的身份"和"自动登记"之间选：两者合成"自动"，由内核按 mcp-design D-182 的顺序决定；"自动"和"你自己的 OAuth 应用"放进高级选项的"OAuth 客户端"一行；只有登录服务不接受自动登记时，Client ID 才出现在主表单 | "登录身份""自动注册"会被读成"用哪个账号登录""要再注册一个账号"；这是 finx 和登录服务之间的事，普通用户在登录过程中不必感知 | §10.9 |
| DD-57 | 页面上不提供连接器的"范围"：添加一律写进用户配置 `~/.finx/config.toml`，所有项目可用；编辑留在原来的层；个人项目层保留给手写的条目和"只对你关闭"仓库里的连接器 | 连接器经工具目录渐进加载，多挂一个不占上下文；"仅这个项目"的真实需求还没出现，等出现时按需求再设计，不提前做 | §4.2 §10.9 |
| DD-56 | 请求头和传输方式收进"高级"，默认收起并在标题旁写当前值；"用到时再登录"不提供 | 绝大多数服务器用不到它们；令牌已有专门的一项，不必去请求头里填；中途登录先不做（mcp-design Q-118） | §10.9 |

## 17. 待定问题

| 编号 | 问题 | 当前倾向 | 章节 |
|---|---|---|---|
| DQ-20 | "仅这个项目"是否在一期就做个人项目层 | 一期就做。仓库文件只读之后，"仅这个项目"和"只对你关闭"都只能靠它 | §4.3 |
| DQ-21 | 精选技能从哪里来；技能要不要"仅这个项目"的范围 | 先自己写三到五个，并收录许可允许转发的；技能暂不提供仅这个项目 | §10.6 |
| DQ-22 | 是否内置 skill-creator（skill-design Q-61） | 已定：编译进 finx（DD-47） | §4.6 |
| DQ-23 | 技能能否在已经打开的会话里立即生效 | 以后做。按 skill-design Q-60 的思路，在下一个任务开始前追加一条说明，不改写前缀。连接器那一半已由 DD-49 解决 | §3.2 |
| DQ-24 | 推荐连接器用不用品牌图标 | 一期用字母缩写；逐项确认商标许可后再换 | §10.6 |
| DQ-25 | 页面上的"当前项目"怎么选 | 取新会话页选中的项目；项目分组的标题旁可以切换，复用新会话页的项目菜单 | §10.3 |
| DQ-26 | 在线目录是否在 sha256 之外再加签名 | 二期再定。目录的 index 用随应用发布的公钥验签，是比较稳妥的做法 | §10.6 |
| DQ-27 | 要不要"这个会话临时不用某个连接器" | 以后做。`session/new` 只带名字和开关，不带配置 | §3.2 |
| DQ-28 | 未受信任项目里的连接器，页面是否提供"信任这个项目" | 提供，需要一个对应 `finx trust` 的协议方法 | §8.1 |
| DQ-29 | 工具页签是否提供逐个工具的开关（`enabled_tools`、`disabled_tools`） | 二期。写入就是 `config/write` | §14.2 |
| DQ-30 | 二期的在线目录由桌面端同步，还是由 finx 服务同步 | 倾向服务：命令行也能按 id 浏览和安装，下载与校验只有一份实现；展示（分组、排序、文案）仍在桌面端 | §10.6 |
| DQ-31 | 是否提供"从其他工具导入连接器"（读取其他编码工具的 MCP 配置，确认后写进个人配置） | 以后做。技能已经直接读取其他客户端的目录，连接器可以照此提供一次性的导入 | §1.3 |
| DQ-32 | 技能要不要一个可选的界面信息文件（显示名、图标、默认提示词） | 暂不。一期所有技能用同一个图标；以后需要时，默认提示词可以用在"在对话中使用"的预填上 | §10.5 |
| DQ-33 | 项目搬家后，个人项目层怎么跟过去 | 页面检测到同名、不同指纹的旧目录时提示一次，用户同意后改名 | §4.3 |

## 附录 A：放弃的做法

| 做法 | 是什么 | 为什么不用 |
|---|---|---|
| 桌面清单 + 每次注入 | 桌面端记一份装了什么，每次 `session/new` 把技能路径和服务器配置带给内核 | 命令行和编辑器用不到；与内核本来就读的目录形成两份清单；令牌每个会话过一次协议（违背 IG6）；客户端带来的服务器不写进会话日志，恢复会话时要原样重带 |
| 桌面直接改文件 | 桌面主进程自己读写 `config.toml` 和技能目录 | 格式、校验、优先级要用 TypeScript 再写一遍，迟早分叉；TypeScript 缺少可靠的保格式 TOML 库；与命令行没有共同的锁 |
| 连接放在桌面进程 | 桌面持有 MCP 连接，经协议把工具提供给内核，内核反向调用 | 关掉应用后正在跑的任务失去这些工具（违背 IG3）；命令行和编辑器拿不到；只在内核服务跑在另一台机器上时才划算 |

## 附录 B：配置示例

用户配置 `~/.finx/config.toml`（页面写入的部分）：

```toml
[skills]
disabled = ["/Users/yee/CodeSpace/finxwork/.agents/skills/desktop-dev-run"]
opt_in = ["/Users/yee/CodeSpace/finxwork/.claude/skills/release-notes"]

[mcp_servers.github]
url = "https://api.githubcopilot.com/mcp/"
headers = { Authorization = "Bearer ${credential:mcp.github}" }

[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@latest"]

[mcp_servers.sentry]
url = "https://mcp.sentry.dev/mcp"
enabled = false
```

个人项目层 `~/.finx/projects/finxwork-3fa81c02/config.toml`：

```toml
# Personal settings for /Users/yee/CodeSpace/finxwork
# (only you, only this project; written by finx)

[mcp_servers.postgres-dev]
command = "uvx"
args = ["mcp-server-postgres"]
env = { DATABASE_URL = "${credential:mcp.postgres-dev.DATABASE_URL}" }

[mcp_servers.staging-db]          # 定义在仓库里，只对自己关闭
enabled = false
```
