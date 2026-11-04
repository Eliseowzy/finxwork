# finx Bot 技术方案

| 项 | 内容 |
|---|---|
| 版本 | v1.5 |
| 日期 | 2026-11-04 |
| 状态 | 一期已实现（分支 feat/bot-mode），测试与真实模型验收见 §8。二期（§10）是方向，开工前另行细化 |
| 关系 | 产品需求见 [docs/desktop/bot-mode-design.md](../desktop/bot-mode-design.md)（下称 PRD）。扩展 technical-design.md（下称总方案）的 §7.2 系统提示词、§9 会话持久化、§11.5 受保护路径，protocol-design.md（下称协议方案）的 §3 服务层、§6 原生协议。一期不改输入队列和子智能体的调度；任务循环只加两处判断：结束标记（§3.3）和没回话时的提醒（§3.11） |

变更记录：

| 版本 | 日期 | 说明 |
|---|---|---|
| v0.1 | 2026-11-03 | 初稿 |
| v0.2 | 2026-11-04 | 二期方向改为 Bot 调度会话模式 |
| v0.3 | 2026-11-04 | 一期收窄到最小可用：不另做"差事"，连发靠插话队列，长活靠现有的子智能体；优化移到"按需再加" |
| v0.4 | 2026-11-04 | Bot 唯一对主人可见的输出改为 `send_to_user` 工具：一次调用一个气泡，普通的助手文字是私有的；`end_turn` 结束这一轮 |
| v0.5 | 2026-11-04 | 系统提示词按会话类型选配置：Bot 会话换掉基础段（bot.md），其余各段不动；以后迭代的参考 |
| v1.0 | 2026-11-04 | 定稿。按代码核对后补齐：`end_turn` 做成工具结果的通用标记（§3.3）；气泡取成功的 `send_to_user`，对话按时间排（§3.4）；改名用一种新的日志条目在轮次边界告诉模型（§2.4）；数据目录写保护的核实结论与改法，顺带修好无项目会话（§2.5）；未读由客户端报告"在看"（§5.3）；头像图片的存取（§4）；按 crate 和文件的实现清单（§7）；bot.md 全文（附录 A） |
| v1.1 | 2026-11-04 | 实现。与 v1.0 的出入：列表的最近一句改为原文的前 1000 字加图片数，附件的标记由客户端认（§4）；气泡取助手消息里的 `send_to_user` 调用，它和 `tool_started` 几乎同时到，调用失败、被拒、没执行的不显示（§3.4）；模拟模型加 Bot 场景，真实模型统计脚本和桌面端走查脚本（§8）；Bot 模式下 ⌘K 搜 Bot。按验收结果加了一项：短问题上模型常只写私有的文字就结束（36 次里 16 次），改提示词无效，加上没回话时提醒一次（§3.11、D-316），漏发降到 0（另两组短问题各漏 1 次，见 §8）；几句一起送达时模型偶尔把几首诗并进一个气泡，bot.md 补一句"几个请求分开回、按顺序"（附录 A.1） |
| v1.2 | 2026-11-04 | 试用后改：确认不再是对话里的卡片，Bot 页用会话页同一个授权窗口（§3.8、D-317）。只改桌面端和客户端库，内核和协议不动 |
| v1.3 | 2026-11-04 | Bot 的权限模式可选，默认由第一次进入 Bot 模式时的选择决定（§3.8、D-318）。全在桌面端，内核和协议不动 |
| v1.4 | 2026-11-04 | 去掉第一次进入时的弹窗：Bot 默认完全访问，权限选择器上方浮一次提示气泡（§3.8、D-318）。仍然只改桌面端 |
| v1.5 | 2026-11-04 | 试用后改：Bot 页有内置浏览器和文件面板，和会话页共用 `session/SidePanels.tsx`；桌面端不再提供清空聊天记录和标为已读/未读，`bots/clear`、`bots/unread` 留在协议里，没有界面入口（D-319）。没有清空以后，系统提示词在 Bot 的对话里不再更新（Q-200） |

## 方案摘要

- **一期的目标**：先把 Bot 的机制跑起来。现有内核能做到的不另做，没有证据的优化不做。
- **Bot 是一个会话**：Bot = 身份（名字、头像，存在 `~/.finx/bots/<id>/bot.json`）+ 一个会话。会话头部记 `bot`，不进会话列表；工作目录是 Bot 自己的文件夹，按无项目会话处理。
- **一期只加一个工具：`send_to_user`**。它是 Bot 唯一对主人可见的输出：一次成功的调用就是一个气泡；普通的助手文字是私有的，永远不送到主人那里；`end_turn` 表示这一轮说完了。其余工具与无项目会话完全相同，包括现有的子智能体工具。
- **一轮怎么过**（写在 Bot 的系统提示词 bot.md 里）：主人一开口，第一个动作是发一条消息，能马上答就答，否则说一句先做什么；做长活时在关键节点发简短的进展；做完把结果都发出去，最后一条带 `end_turn`。
- **连着发几句**：用现有的插话队列。Bot 正在回时新的一句排进队列，这一步做完就送达，Bot 接着回它。连发四首诗，回来四个气泡。
- **长活**：用现有的子智能体。`spawn_agent` 默认在后台跑，Bot 接着聊；汇报回来唤醒 Bot，由 Bot 转告。
- **不流式**：桌面端接入 Bot 会话时排除增量事件，气泡整条出现。协议和内核不为此改动。
- **内核改七处**：头部的 `bot` 与列表排除；私有文件夹；`send_to_user` 与结束任务的标记；没回话时提醒一次；提示词配置（Bot 会话用 bot.md，后台帮手用会话的）；改名的环境更新；数据目录写保护对会话自己的文件夹放行。
- **服务层**：Bot 的登记、`bots/*` 方法、`bots/changed` 推送；最近一句、未读、在忙都从会话已有的事件得出。
- **二期**：Bot 调度会话模式（§10），Bot 自己的工具从这里开始出现。
- **没回话时提醒一次**（§3.11）：任务要结束时主人还没收到回复，内核追加一条只给模型看的提醒，再请求一次。验收时证明需要，从"按需再加"提进一期。
- **按需再加**（§11）：顶掉、表情回应、引用等，一期不做，等真实使用暴露问题再做。
- **工作量**：一期约 12 人天（§9）。

## 目录

- 方案摘要
- 0. 阅读说明
- 1. 目标与原则
- 2. Bot 就是一个会话
- 3. 对话怎么跑
- 4. 协议
- 5. 服务层
- 6. 客户端库与桌面端
- 7. 实现清单
- 8. 测试与验收
- 9. 分期与工作量
- 10. 二期：调度会话模式
- 11. 按需再加
- 12. 持久化与兼容
- 13. 设计取舍
- 14. 决策
- 15. 待定问题
- 16. 以后迭代的参考（一期完成后讨论）
- 附录 A：给模型的文本

## 0. 阅读说明

- **章节引用**：§x 指本文；"总方案 §x""协议方案 §x""子智能体方案 §x""输入队列方案 §x"分别指 technical-design.md、protocol-design.md、subagent-design.md、input-queue-design.md；"PRD §x"指产品需求。
- **术语**：

| 术语 | 定义 |
|---|---|
| Bot | 身份（id、名字、头像）加上一个会话。用户在 Bot 模式里找的"人" |
| Bot 会话 | 头部带 `bot` 的会话：Bot 唯一的那段对话 |
| 主人 | 使用这个 Bot 的人 |
| 气泡 | 桌面端显示的一条消息：主人的一条消息，或者 Bot 的一次成功的 `send_to_user` |
| 私有文字 | Bot 会话里普通的助手文字和思考。只在"过程"里看得到，永远不送到主人那里 |
| 后台帮手 | Bot 用 `spawn_agent` 起的子智能体 |
| 私有文件夹 | 会话自己的工作目录，在 finx 数据目录里：无项目会话的 `chats/<uuid>/`，Bot 的 `bots/<id>/files/` |
| 提示词配置 | 拼系统提示词时选哪份基础段：会话配置用 base.md，Bot 配置用 bot.md（§2.3） |

- **编号**：决策从 D-300 起，待定问题从 Q-200 起。
- **给模型的文本**：按 D-16 用英文，全文见附录 A。

## 1. 目标与原则

| 编号 | 目标 | 来自 |
|---|---|---|
| BG1 | 一个 Bot 一段对话，永不结束；主人不管理会话和上下文 | PRD G1 |
| BG2 | 随时能发，一次发几句；每句都被接住、都有回答 | PRD G2 |
| BG3 | 主人只看到写完的话，看不到流式的字和工具调用 | PRD §6.6 |
| BG4 | 长活不挡住聊天：Bot 交给后台帮手，自己接着回 | PRD §6.9 |
| BG5 | 二期能调度会话模式 | 主人的方向 |

原则：

- **最小可用**：一期先把机制跑起来。现有内核能做到的不另做；没有证据的优化列进 §11，写明什么情况下才做。
- **复用**：Bot 会话就是会话，后台帮手就是子智能体。日志、恢复、工具、审批、压缩、镜像、事件全部照用。
- **在拥有它的那一层改**：结束任务的信号放在工具结果里，写保护的放行放在受保护路径的判断里，列表排除放在会话头部的一个方法里，不在调用处打补丁。
- **一个真相来源**：在忙、未读这些状态由服务层从会话事件得出，桌面端只渲染。
- **不设上限**：Bot 的数量、后台帮手的数量都不限（子智能体方案 D-50）。

## 2. Bot 就是一个会话

### 2.1 身份与存储

```
~/.finx/
├── bots/
│   └── <bot_id>/
│       ├── bot.json        身份、会话 id、列表用的摘要
│       ├── avatar.png      上传的头像（有的话）：256 × 256 的 PNG
│       └── files/          Bot 的工作目录（私有文件夹）
└── trash/
    ├── sessions/           清空和删除时，Bot 会话的日志移到这里（与 session/delete 相同）
    └── bots/<bot_id>/      删除的 Bot
```

```json
{
  "version": 1,
  "id": "0193…",
  "name": "研究员",
  "avatar": { "kind": "char", "shape": "round", "hue": "slate" },
  "default": false,
  "pinned": false,
  "created_at": "2026-11-03T14:05:00Z",
  "session_id": "0193…",
  "summary": {
    "last": { "from": "bot", "text": "对比好了，常见的三种…", "ts": "2026-11-03T14:20:11Z" },
    "unread": 2
  }
}
```

- `id` 是 UUID v7。目录 0700，文件 0600，写入走原子替换（总方案 §9.1）。
- `avatar.kind`：
  - `mark`：品牌 α，只有默认 Bot 能用；
  - `char`：小角色，`shape` 取 round、box、ghost、cloud、dome、cat、egg、gem，`hue` 取 slate、sage、clay、ochre、plum、teal、rose、stone；
  - `mono`：名字的第一个字，只存 `hue`，字随名字变；
  - `image`：avatar.png，`rev` 每换一次图加一。
- `summary` 是列表用的缓存：最近一句和未读数，变化时写回（§5.2）。在忙、帮手数、在等的确认是瞬时状态，不写。
- 会话日志仍在 `sessions/` 下，与其他会话一样。

| 操作 | 做什么 |
|---|---|
| 新建 | 建目录和 `files/`，写 bot.json；会话在第一次 `bots/open` 时建 |
| 默认 Bot | 第一次 `bots/subscribe` 时一个 Bot 都没有，就建 FinxBot（`default: true`，头像 `mark`）。只用命令行的人不会有 `bots/` |
| 改名、换头像、置顶 | 改 bot.json，推送 `bots/changed`；改名时会话加载着就告诉内核（§2.4） |
| 清空聊天记录 | 关闭 Bot 会话（中断任务和后台帮手），日志按 `session/delete` 的做法移进回收站，清掉 `session_id` 和 `summary`；下次 `bots/open` 开新会话。`files/` 不动 |
| 删除 | 同清空，再把 Bot 目录移进 `trash/bots/`。默认 Bot 不能删 |

### 2.2 Bot 会话

- **头部**：`SessionHeader` 加 `bot: Option<BotRef>`，`BotRef { id, name }`。`name` 是建会话时的名字，也就是系统提示词里的那个，改名时用它判断要不要告诉模型（§2.4）。
- **不进列表**：不进 `session/list`、`sessions/subscribe`、`sessions/changed`，也不算"最近的会话"（`resume --last`）。`SessionHeader::listed()` 在 `agent` 和 `bot` 都没有时为真；存储里现在判断 `agent.is_none()` 的各处都改用它。服务层的会话中枢按会话类型决定摘要推给会话列表还是 Bot 列表（§5.1）。
- **工作目录**：`bots/<id>/files/`，是私有文件夹，按无项目会话处理：不向上找项目根，不读项目配置和项目指令，只用主人自己的配置、指令和技能（总方案 §9.1）。`FinxHome` 加两个判断：
  - `has_no_project(cwd)`：现在的 `is_chat_dir` 加上 `bots/<id>/files/`，供 `Workspace::open` 判断有没有项目；
  - `private_folder(cwd)`：cwd 恰好是 `chats/<uuid>/` 或 `bots/<id>/files/` 时返回它，供写保护放行（§2.5）。
- **工具**：与无项目会话相同（基础工具、连接器、技能、子智能体工具），另加 `send_to_user`（§3.2）。挂法与子智能体工具相同：`extended(tools, "bot", bot::tools)`，在 `agent_tree` 之后挂，所以后台帮手拿到的工具里没有它。恢复会话时按头部的 `bot` 同样挂上（工具不记在日志里，恢复时本来就重建）。
- **权限与模型**：默认模型与新建会话相同（PRD DQ-54）。权限模式按 §3.8，会话启动时是配置的默认值，桌面端接入后按主人的选择改；桌面端接入，所以审批可交互。

### 2.3 系统提示词：按会话类型选配置

**现在的系统提示词怎么来的**（总方案 §7.2，`prompt.rs` 的 `build_system_prompt`）：内核在会话开始时按段拼一次，之后冻结，写进日志的 system_prompt 条目；恢复会话时用日志里那份，子智能体沿用父的那份。各段依次是：

1. 基础段：内置的 `prompts/base.md`；配置了 `system_prompt_file` 时换成那个文件；
2. 桌面段：会话开始时桌面端连着，就加 `prompts/app.md`（文件链接、命令代码块的写法）；
3. `<tool_guidelines>`：各工具自带的使用规则；
4. 指令：`~/.finx/AGENTS.md`、项目的指令文件、配置的 `instructions.extra`；
5. 技能清单；
6. `<environment>`：工作目录、系统、日期、git。

**基础段不适合 Bot**，只在后面追加一段不够：

- 身份是"FinxWork，做金融与办公工作的智能体"，Bot 有自己的名字；
- "用户在你工作时发的消息，通常是在调整当前任务"——Bot 收到的新消息常常是另一件事；
- "怎么沟通"一节按完整报告来写（先结果、再按便于核对的顺序给依据、用表格），Bot 是一两句话的聊天，而且只有 `send_to_user` 发出的才可见。

前后两段互相矛盾，模型会摇摆。所以 Bot 换掉基础段，其余各段不动。

**提示词配置**：

```rust
pub enum PromptProfile {
    /// 会话模式和子智能体：base.md。
    Session,
    /// Bot 会话：bot.md，{{name}} 换成 Bot 的名字。
    Bot { name: String },
}
```

- `PromptInputs` 多一个 `profile`。`build_system_prompt` 只按它选基础段，第 2 到第 6 段不变。Bot 会话同样加桌面段：气泡同样按 Markdown 渲染文件链接和命令代码块（PRD §6.6）。
- **内核自己决定用哪个配置**：`Kernel::start` 带 `bot` 时用 Bot 配置，否则用会话配置。提示词的文字不经过协议，桌面端只告诉服务层"打开这个 Bot"。
- **共用的两节**：base.md 里"Numbers and data""Acting with care"两节，两种配置都要。把它们移到 `prompts/shared/numbers_and_data.md` 和 `prompts/shared/acting_with_care.md`，base.md 和 bot.md 用 `{{numbers_and_data}}`、`{{acting_with_care}}` 引用，内置文本第一次用时替换一次。会话配置拼出的文字与现在逐字相同（测试拿现在的 base.md 原文比对）。各自不同的是身份、一轮怎么过、怎么工作、怎么说话（bot.md 全文见附录 A.1）。
- **覆盖文件也按配置分**：`system_prompt_file` 只换会话配置的基础段，意思不变；另加 `bot_prompt_file` 换 Bot 配置的。覆盖文件里也可以用上面这些标记。`bot_prompt_file` 的用途是调提示词时不用重新编译，验收时改几句就能对比。
- **后台帮手用会话配置**：子智能体本来沿用父的系统提示词（子智能体方案 D-42）。Bot 的提示词讲的是怎么跟主人聊天、只有 `send_to_user` 可见，帮手没有这个工具，它的回复是写给 Bot 的汇报。所以 Bot 会话开始时，用同一份输入（工作目录、指令、技能、环境）按会话配置多拼一份，存在 `SessionState.helper_prompt`；`spawn_agent` 有它就用它代替父的基础提示词。指令和技能只扫描一次，拼两遍。恢复 Bot 会话时按当时的输入重拼这一份：帮手都是新会话，本来就以当时为准。
  - 代价：帮手的第一个请求用不上 Bot 提示词的缓存。帮手与 Bot 的工具列表本来就不同（没有智能体工具和 `send_to_user`），损失只是一次系统提示词长度的未命中。

**为什么不让桌面端把提示词传进来**

- **提示词和内核是一套**：它讲的是 `send_to_user`、`end_turn` 这些内核的行为，必须和内核的工具、版本一致。由桌面端带进来，两边版本不一致时就会描述一个内核没有的工具，或者漏掉新的。
- **一个真相来源**：命令行、ACP 和以后的客户端打开同一个 Bot，行为应当一样。
- **不开不必要的口子**：任何连上服务的客户端都能给会话塞一份任意的系统提示词，这个口子现在用不上。产品上 Bot 也没有人设（PRD DD-99），用户不写提示词。

**为什么不会破坏内核**

- 改动只在拼基础段这一步。冻结、写日志、恢复、压缩、上下文报告都只认拼好的整段文字，不关心基础段写了什么。
- 日期检测读的是最后的 `<environment>` 段，技能清单的位置也不变，两种配置都一样。
- 旧日志恢复时用日志里那份，与配置无关。
- 会话配置的拼法与现在逐字相同，会话模式的行为和缓存都不变。

### 2.4 改名

系统提示词冻结不动（总方案 D-15）。改名和日期变化一样，在对话里追加一条环境更新（总方案 D-234）：

- **内核怎么知道新名字**：服务层在 Bot 会话加载着时调用 `Kernel::set_bot_name(name)`（进程内的方法，与 `set_system_connectors` 一样，不是协议的 Op）；加载会话时由 `ResumeOptions.bot_name` 带进来。
- **什么时候告诉模型**：每个轮次边界，紧接着 `note_date`，`note_bot_name` 比较当前的名字和上下文里的名字；不同就记一条 `EntryKind::BotName { name }`。
- **上下文里的名字**：最近一次压缩之后最新的 `BotName` 条目；没有就是头部的 `bot.name`（系统提示词里的那个）。所以压缩把旧的改名条目挤出上下文后，下一轮会再告诉一次。
- **模型看到的**：一条用户消息 `<environment_update>\nyour name: 运维小助手\n</environment_update>`（附录 A.4）。和日期条目一样不进 transcript，桌面端不显示。
- 旧版本把不认识的条目读成 `EntryKind::Unknown`，跳过。

### 2.5 数据目录的写保护

**核实结论**：`protected.rs` 的 `protected()` 对数据目录（`~/.finx`）里的路径一律返回 "finx data directory"，除 bypass 以外的所有权限模式下写这些路径都要确认。无项目会话的 `chats/<uuid>/` 正是这样：模型在会话自己的工作目录里写文件，每次都问。Bot 的 `files/` 也一样。

**改法**：

- `SessionView` 加 `own_folder: Option<PathBuf>`：会话的工作目录是私有文件夹时就是它（规范路径），否则为空。会话启动时由 `FinxHome::private_folder` 算一次。
- `protected()` 里数据目录那条规则跳过 `own_folder` 之内的路径。之后的规则照旧：私有文件夹是工作区根，里面的 `.git`、`.agents`、`.bashrc` 等仍按名字受保护。
- 数据目录的其余部分照旧受保护：配置、bot.json、头像、别的会话的文件夹。
- 后台帮手的工作目录与 Bot 相同，同样放行。
- 这一处同时修好无项目会话。

## 3. 对话怎么跑

除了 `send_to_user`、它结束任务的那一处判断和没回话时的提醒（§3.11），下面每一条都是现有的行为，只是桌面端换一种方式显示。

### 3.1 主人的话怎么进来

- 桌面端每句都按插话发（`Op::Prompt`，mode = steer），没有"排队"和"停止"（PRD §6.14）。附件、技能、连接器与会话页的输入框相同。
- Bot 空闲：开一个任务（总方案 §6.3）。
- Bot 正在回：这句进插话队列，这一步结束时送达；这一步回完，任务看到还有插话，接着回它（`task.rs` 里 `has_steer` 的那个判断）。
- **连发四首诗**：第一句开始任务；后面三句在 Bot 写第一首时进队列，这一步做完时送达。Bot 按约定一首发一条，四个气泡按顺序回来。几句恰好在同一步里送达，也是分几条发（附录 A.1）。
- 正在执行工具时来的话，同样等这一步做完。长活本来就该交给后台帮手（§3.6），所以 Bot 自己这一步通常很快。
- 排队中的消息照样显示成气泡（`queue_changed` 里的项）。写进历史时 id 不变（输入队列方案），不会重复。

### 3.2 `send_to_user`：Bot 唯一的出口

- **为什么要它**：Bot 模式里，主人看到的是一次一个、整条出现的气泡。让模型通过一个工具"发出"一条消息，正好对应这种交互：
  - 一次调用就是一个气泡，看到调用就能一次性渲染，不用等文字拼好；
  - 几个要点可以分几条发，四首诗可以四个气泡；
  - 模型边查边想的文字是私有的，不会漏给主人；
  - 先回一句再去做事、做的过程中发进展、做完发结果，都是"发不发、什么时候发"的选择，由模型决定；
  - 什么时候算这一轮说完了，模型用 `end_turn` 明说。
- **参数**：`text`（必填，去掉首尾空白后不为空，按 Markdown 渲染）；`end_turn`（可选，布尔）。描述与参数说明见附录 A.3。
- **执行**：只读工具（`ToolKind::ReadOnly`），不走审批、不占锁。校验 `text`，返回 `Sent.`；`end_turn` 为真时，结果带结束任务的标记（§3.3）。`describe` 的标题取 `text` 的第一行，供"过程"和命令行显示。
- **不另记条目、不发新事件**：调用的参数在 `tool_started` 和历史里本来就有，桌面端按工具名认出它。
- **只在 Bot 会话里有**：按头部的 `bot` 挂上（§2.2）。后台帮手没有这个工具，它的汇报照旧回到 Bot。
- **没发就结束**：模型一次都没调用就要结束这一轮时，内核提醒它一次（§3.11）。

### 3.3 `end_turn` 结束这一轮

- **通用的标记**：finx-tools 的 `ToolOutput` 加 `ends_task: bool`：工具要求这一批执行完后结束任务。`send_to_user` 在 `end_turn` 为真时设它。
- **执行**：`tool_exec` 看到一个成功的（`is_error` 为假）、带 `ends_task` 的结果，就在 `TaskCtx` 上记下。`task.rs` 在这一批的结果写进历史、`finish_turn_hooks` 返回 Default 之后检查：记下了，并且插话队列是空的，任务以 `CompletionReason::Done` 结束，不再请求模型。
- **插话队列里有新消息**：照常接着回，标记作废。
- **汇报在等**：任务照样结束；任务结束时现有的逻辑看到有会唤醒的汇报，马上开一个新任务送进去（`task.rs` 里 `has_waking_mail` 的那个分支），什么都不会丢。
- **同一批里还有别的调用**：这一批照常执行完，结果进历史，然后结束；模型下次被唤醒时看得到这些结果。bot.md 要求 `end_turn` 只放在最后一条消息上。
- **为什么不用钩子的 `TurnDecision::End`**：钩子是留给用户配置的扩展点；结束的信号来自一次工具调用的结果，就放在工具结果里。以后别的工具要结束任务，用同一个标记。

### 3.4 气泡从哪来

桌面端从会话的历史（快照的 transcript 和之后的事件）直接得出气泡，规则固定：

| 历史里的东西 | 显示成 |
|---|---|
| 主人的消息 | 右边的气泡，附件在上方 |
| 成功的 `send_to_user` 调用 | 左边的气泡，内容是 `text` |
| 失败的 `send_to_user`（`text` 为空、被钩子拒绝、没有执行） | 不显示 |
| 助手的文字、思考 | 不显示；归进它后面那个气泡的"过程" |
| 其他工具调用和结果 | 同上 |
| 子智能体的汇报（`mail`） | 不进对话；在"过程"里是一步 |
| 中断留下的半截消息（stop_reason 为 aborted） | 不显示。Bot 模式没有停止键，只有命令行、ACP 才会产生 |
| 日期、改名、提醒条目 | 不显示 |
| 等确认的调用 | 不进对话；输入框上方的授权窗口（§3.8） |
| 任务失败 | 失败卡，带"重试"（§3.9） |

- **实时显示**：气泡来自写完的助手消息里的 `send_to_user` 调用（`text` 不为空），按调用在消息里的顺序。助手消息写完（`message_completed`）紧接着就是这一批的 `tool_started`，两者几乎同时到。调用最后失败了（被钩子拒绝、没有执行）就不显示；这种情况很少。服务层的列表摘要用 `tool_started`，与此同步。
  - 不等结果才显示，是因为同一批里只要有一个调用要确认，整批都要等确认答复以后才执行：先发的那句"要重启 nginx，你确认一下"得在授权窗口之前让主人看到。
- **按时间排**：对话按时间排序，同一时间按历史的顺序。主人的消息取发出的时间（`UserMessage.ts`，消息到达内核时就定了，排队的也一样）；Bot 的气泡取那条助手消息写完的时间（`ts + duration_ms`）。这样，Bot 回话中途发出的话，实时看到的位置和重新打开后的一样。否则按历史的顺序，排队的消息要到这一步结束才写进历史，重新打开时会挪到 Bot 那一步的气泡后面。
- **过程**：一个气泡的过程是同一个任务里、从上一个气泡（或任务开始）到它之间的步骤，用时从任务开始或上一个气泡算起。
- 这不是在客户端猜：`send_to_user` 的参数就是 Bot 发出的话。不另记聊天视图的条目，不加 `reply_to`（D-302）。

### 3.5 不流式

- 桌面端接入 Bot 会话时排除 text_delta、thinking_delta、tool_call_delta、tool_progress 四类事件（`EventFilter`，协议方案 §4.6）。
- 没有连接要这些事件时，它们的原生编码根本不会发生，几乎没有开销。协议和内核不为"不流式"改动；会话模式照旧流式。

### 3.6 长活：后台帮手

- Bot 用现有的 `spawn_agent` 把长活交给子智能体。默认异步：调用立即返回，Bot 这一轮很快结束，主人可以接着聊（子智能体方案 §6.2）。`spawn_agent` 的描述已经写了什么活该交出去、汇报怎么回来、要转告主人，bot.md 不重复。
- 汇报：Bot 空闲时唤醒它开一个任务，Bot 正在回时在下一个轮次边界送达（子智能体方案 §7）。Bot 用 `send_to_user` 转告；不值得说的可以不发。
- 帮手遇到要确认的调用直接拒绝，写进汇报（子智能体方案 D-43）；Bot 转告时问主人，主人同意后 Bot 自己去做，这时的授权窗口来自 Bot 会话。
- 主人说"那个不用查了"，Bot 用现有的 `send_message`（带 interrupt）停下那个帮手。

### 3.7 在忙

| 状态 | 从哪来 | 显示 |
|---|---|---|
| 在回话 | Bot 会话有任务在跑（task_started 到任务终止）。发了先回的那句之后、做完之前，仍算在忙 | "它在忙"的气泡；列表和顶栏写"正在输入…" |
| 有后台帮手 | 有子智能体在跑（agent_started、agent_status，子智能体方案 §11） | 气泡写帮手的说明（`spawn_agent` 的 `description`），几件时写"正在处理两件事"；点开看每件当前的步骤（`agent_event` 里的 tool_started） |
| 在等确认 | 待审批项 | 列表"[待确认]"，顶栏"等你确认" |

都是现有的事件，桌面端和服务层直接用。

### 3.8 确认

- 待审批项（快照的 `active_task.approvals` 和 approval_requested 事件）由会话页的授权窗口（`session/Approval.tsx`）显示，弹在输入框上方，能力和快捷键与会话页相同，几件按提出的先后一件一件答。答复走现有的审批 Op。
- 授权不进对话：`botChat` 不产出它，答过以后对话里不留痕迹，那一步在"过程"里看得到（PRD §6.13）。
- ⌘↩ 走菜单：Bot 没有会话那组菜单状态，`MenuState.botApprovable` 单独说屏幕上的 Bot 在等确认。
- **权限模式**：Bot 页的输入框下面是会话页的权限选择器，发 `set_permission_mode`；选择写进会话日志，恢复时还在。界面上 `bypass-permissions` 叫"完全访问"，协议和配置里的名字不变。
- **默认值**：Bot 默认完全访问，存在桌面端。每个 Bot 记下已经给过默认值的会话 id：接入一个没给过的会话时发一次 `set_permission_mode`，已有的对话和新对话都这样，之后主人选的不会被覆盖；清空聊天记录是新会话，回到默认。
- **提示**：权限选择器上方的气泡说明默认值和在哪里改；点"知道了"、用选择器或开始输入就收起，记在桌面端的本地设置里，不再出现。
- **帮手**：权限继承根会话（子智能体方案 D-43），所以完全访问时帮手也能跑命令，不会被拒。
- 一期的授权窗口只来自 Bot 会话自己的调用；帮手不发确认（§3.6）。

### 3.9 失败与重试

- 自动重试照旧（总方案 §4.11）；重试期间"它在忙"的气泡照常跳。
- 重试用完，任务失败：失败卡带"重试"，发 `Op::Continue`；主人直接发新消息也会开新任务。
- 失败时插话队列里还没送达的消息交还给客户端（输入队列方案 §3.4），桌面端在重试或下一次发送时把它们重发；它们在对话里的位置以重发的时间为准。

### 3.10 一段永不结束的对话

- 靠现有的阈值压缩（总方案 §7.6）。界面上的聊天记录一直完整，日志只追加。
- 两个已知的缺口，一期先接受：
  - 系统提示词冻结，新装的技能、改了的全局指令进不了已有的对话（Q-200）；桌面端没有清空，所以一直进不来；
  - 日志一直变长，几个月后加载会慢一些（Q-203）。

### 3.11 没回话时提醒一次

- **为什么加**：验收时发现短问题最容易漏发。真实模型逐句问三个短问题、跑 12 遍，36 个任务里 16 个只写了私有的文字就结束了，主人什么也没收到；把 bot.md 那句改得更直白（"连一个字的回答也要用 send_to_user 发"）以后是 17 个，改提示词改不动它。§11 记下的触发条件满足了，从"按需再加"提进一期。
- **判断**：任务要正常结束时（这一步没有调用，插话和排队都是空的，也不是被输出上限截断），从历史的末尾往回找：先碰到主人的话，就是"没回话"；先碰到成功的 `send_to_user`，就是回过了。主人的话可以在之前的任务里，比如失败后点"重试"的那个任务。帮手的汇报唤醒 Bot 时，主人的话已经回过，就不提醒。
- **补救**：记一条 `unanswered` 条目，再请求一次模型。这条条目在上下文里是一条用户消息（附录 A.6）；不进对话、不发事件，日志里留着，恢复或重新打开后上下文和当时一样（只追加，缓存照样命中）。
- **每个任务一次**：提醒过还是没发，任务照样结束，不再提醒；主人的下一句另算。
- **代价**：只在漏发时多一次请求，前面的内容都在缓存里。
- **效果**：同样的测试，漏发从 16/36 降到 0 或 1/36：加提醒以后的三组短问题共 108 个任务，漏 2 个，都是模型被提醒后又只写了文字（§8、§11）。

## 4. 协议

`initialize` 结果的 capabilities 加 `bots: true`。以下都是增量。

| 方法 | 参数 | 结果 | 说明 |
|---|---|---|---|
| `bots/subscribe` | — | `{ bots }` | 返回全部 Bot 的摘要，之后这个连接收到 `bots/changed`。一个都没有时先建默认 Bot |
| `bots/unsubscribe` | — | `{}` | |
| `bots/create` | name、avatar | `{ bot }` | 新建（§2.1） |
| `bots/update` | bot_id、name?、avatar?、pinned? | `{ bot }` | 改名、换头像、置顶 |
| `bots/avatar` | bot_id | `{ data }` | 上传的头像，`data:image/png;base64,…`。摘要里只带 `rev`，客户端按 (bot_id, rev) 缓存 |
| `bots/open` | bot_id、events?、history_limit? | `{ session_id, snapshot }` | 加载或接入 Bot 会话，还没有会话时建一个。之后就是普通的会话接入：`session/op`、`session/history`、`session/detach` 照用 |
| `bots/read` | bot_id | `{}` | 主人在看：未读清零（§5.3） |
| `bots/unread` | bot_id | `{}` | 标为未读：未读设为 1 |
| `bots/clear` | bot_id | `{}` | 清空聊天记录。桌面端不提供入口（D-319） |
| `bots/delete` | bot_id | `{}` | 默认 Bot 返回 `bot_default` |

```rust
pub struct BotSummary {
    pub id: String,
    pub name: String,
    pub avatar: Avatar,
    pub default: bool,
    pub pinned: bool,
    pub session_id: Option<String>,
    pub last: Option<LastMessage>,
    pub unread: u32,
    /// Bot 会话有任务在跑。
    pub typing: bool,
    /// 在跑的后台帮手数。
    pub helpers: u32,
    /// 最早那件在等的确认：调用的标题。
    pub waiting: Option<String>,
    pub created_at: String,
}

#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Avatar {
    Mark,
    Char { shape: AvatarShape, hue: AvatarHue },
    Mono { hue: AvatarHue },
    Image { rev: u32 },
}

/// 新建、修改时给的头像：图片带 256 × 256 的 PNG（base64）。
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AvatarInput {
    Mark,
    Char { shape: AvatarShape, hue: AvatarHue },
    Mono { hue: AvatarHue },
    Image { png: String },
}

pub struct LastMessage {
    pub from: Speaker,                      // user | bot
    /// 原文的前 1000 字。客户端从中取要显示的一行，也认出输入框加的附件标记（文件名）。
    pub text: String,
    /// 带的图片数。
    pub images: u32,
    pub ts: String,
}
```

- **头像图片**：桌面端负责读图、裁成正方形、缩到 256 px、转成 PNG（主进程的 nativeImage，能读 HEIC）。服务层只校验 PNG 签名和大小（不超过 1 MB），写 avatar.png，`rev` 加一。服务层不带图像库。
- **名字**：去掉首尾空白，1 到 20 个字（按字符计）。可以重名（PRD DQ-58）。
- **通知** `bots/changed { bots, deleted? }`：新建、改名、换头像、置顶、清空、删除；Bot 发了消息；主人发了消息；在忙和确认变化；未读变化。只带变了的 Bot。同一份只编码一次，所有订阅者共用（协议方案 D-38 的做法）。
- **错误码**：−32040 `bot_not_found`，−32041 `bot_default`（默认 Bot 不能删，`mark` 头像只给默认 Bot），−32042 `bot_invalid`（名字为空或超过 20 字，头像取值不合规，PNG 不合规）。
- **会话层面没有新 Op、新事件**：桌面端发插话、重试、审批答复都用现有的 Op。
- **类型生成**：改 Rust 类型，`FINX_UPDATE_SNAPSHOTS=1 cargo test -p finx-protocol` 更新 schema 快照，再 `node packages/protocol/scripts/generate.mjs` 生成 TypeScript。

## 5. 服务层

### 5.1 登记与会话中枢

- **BotRegistry**（新文件 `bots.rs`）：启动时读 `bots/*/bot.json`，常驻内存；读不了的跳过并记一条警告。按 session_id 也能查到 Bot。改动写回 bot.json 并推送。
- **会话中枢的去向**：中枢现在把摘要变化推给会话列表（`sessions/changed`）。建中枢时给它一个去向：会话列表，或者某个 Bot。Bot 会话的中枢不推 `sessions/changed`，改为把变化交给登记，由登记更新这个 Bot 的摘要、推 `bots/changed`。

### 5.2 摘要

Bot 会话加载着时，中枢看到这些事件就更新摘要，不另外查询内核：

| 事件 | 更新 |
|---|---|
| 主人的消息（message_completed，用户消息） | last |
| `send_to_user` 的 tool_started（`text` 不为空，与桌面端同一个规则；之后失败的极少，列表不回退） | last；未读规则见 §5.3 |
| 任务开始与终止 | typing |
| 子智能体开始、状态变化 | helpers |
| 审批出现与答复 | waiting；未读规则见 §5.3 |

- `last` 和 `unread` 一变就写回 bot.json（原子替换，一条消息一次）。服务崩溃后，列表仍有最近一句和未读。
- 会话没加载时，typing、helpers、waiting 都是空的：没加载的会话不可能在跑。

### 5.3 未读

- 主人在不在看，只有界面知道：附着一个会话不等于在看（桌面端可能附着着、但停在别的页）。所以由客户端报告：Bot 被选中、窗口在前台时调用 `bots/read`；在看的时候每来一个气泡再调一次。
- 服务层：每个气泡（§5.2 的 `send_to_user`）、每个新的确认请求，未读加一；`bots/read` 清零，`bots/unread` 设为 1。
- 客户端不显示正在看的那个 Bot 的未读数，所以"加一"到"清零"之间的一瞬看不出来。

### 5.4 打开

- `bots/open`：bot.json 没有 session_id，或者日志已经不在了，就新建会话（cwd 是 `bots/<id>/files/`，`StartOptions.bot` 带 id 和名字），记下 session_id；会话没加载就恢复（`ResumeOptions.bot_name` 带当前的名字）；已加载就接入。结果与 `session/new`、`session/resume` 的接入相同。
- 不经过 `bots/open` 直接 `session/resume` 一个 Bot 会话（比如命令行），服务层也按 session_id 查登记，带上名字。
- `session/new` 不能建 Bot 会话：`bot` 只由服务层在进程内传给内核。

### 5.5 改名、清空、删除

- 改名：写 bot.json，推送；会话加载着就调 `Kernel::set_bot_name`（§2.4）。
- 清空、删除：中断任务和后台帮手，关闭会话并等它写完日志，再按 §2.1 移进回收站，推送。

### 5.6 卸载

空闲卸载照旧（协议方案 §3.1）。摘要已经随时写回，卸载时不用另做什么。

## 6. 客户端库与桌面端

- **客户端库**（packages/client）：
  - `bots.ts`：订阅 Bot 列表，按 PRD §6.2 排序（置顶在前，然后按最近一句的时间；在忙不改变顺序）；头像图片按 (bot_id, rev) 缓存；
  - `botChat.ts`：由会话快照和事件按 §3.4 的规则得出气泡、过程和"它在忙"（§3.7）；
  - 模拟服务加 `bots/*` 和演示用的几个 Bot：连发四首诗、带后台帮手的长活、确认。失败与重试没有放进模拟服务，由桌面端的 `e2e/bot-failure.mjs` 走查（§8）。
- **桌面端**（apps/desktop）：PRD 一期的界面。原型（docs/desktop/bot-mode-demo.html）的样式搬进新的 `styles/bots.css`；原型里属于二期的部分（眼睛和对勾、引用）先不搬。
  - 接入 Bot 会话时声明排除增量事件（§3.5）；
  - 模式、各模式的选中项、每个 Bot 的草稿存在桌面端的本地设置里；
  - Bot 页和会话页共用文件面板和内置浏览器（`session/SidePanels.tsx`），链接、文件和 PDF 都在应用里打开；发消息时带上正在看的 PDF，和会话页相同；
  - 主进程的服务监管：要替换 finx 服务时（应用更新后版本不同，或开发时重新编译），等没有任务在跑再换。Bot 的会话不在会话列表里，所以监管也订阅 Bot 列表：Bot 在回话、等确认或有帮手在做，都算有任务在跑。

## 7. 实现清单

按 crate 和文件列出一期改了的地方（v1.1 按实现核对）。新文件标"新"。各处结构体字面量补上新字段的改动不列。

**finx-tools**

| 文件 | 改什么 |
|---|---|
| `src/tool.rs` | `ToolOutput` 加 `ends_task: bool` 和 `ending_task()`（§3.3） |

**finx-core**

| 文件 | 改什么 |
|---|---|
| `src/store/entry.rs` | `SessionHeader.bot: Option<BotRef { id, name }>`；`SessionHeader::listed()`；`EntryKind::BotName { name }`、`EntryKind::Unanswered` |
| `src/store/jsonl.rs`、`src/store/memory.rs` | 判断 `agent.is_none()` 的各处改用 `listed()`；扫描缓存里"是不是子智能体"的标记改为"列不列出" |
| `src/paths.rs` | `bots_dir`、`bot_dir`、`bot_files_dir`；`has_no_project(cwd)`；`private_folder(cwd)`（§2.2） |
| `src/runtime.rs` | `Workspace::open` 用 `has_no_project` |
| `src/hooks.rs`、`src/protected.rs` | `SessionView.own_folder`；数据目录规则跳过它（§2.5） |
| `src/prompt.rs` | `PromptProfile`；`PromptInputs.profile`；`BOT_PROMPT`；`{{…}}` 片段和名字的替换（§2.3） |
| `src/prompts/base.md`、`src/prompts/bot.md`（新）、`src/prompts/shared/numbers_and_data.md`（新）、`src/prompts/shared/acting_with_care.md`（新） | 附录 A |
| `src/config.rs` | `bot_prompt_file` |
| `src/bot.rs`（新） | `BotIdentity { id, name }`；`SendToUser` 工具；`tools()`；`unanswered()`：主人最近的一句话有没有回过（§3.11） |
| `src/kernel.rs` | `StartOptions.bot`、`ResumeOptions.bot_name`；按头部挂 `send_to_user`；按配置拼提示词，Bot 会话多拼一份 `helper_prompt`；`set_bot_name()` |
| `src/session.rs` | `SessionState` 记 Bot 的名字（头部的和当前的）与 `helper_prompt`；`note_bot_name()`；`unanswered()`；填 `own_folder` |
| `src/context.rs` | `BotName` 条目变成环境更新的消息；`name_in_context()`；`Unanswered` 条目变成提醒（附录 A.6） |
| `src/agents/mod.rs` | `spawn` 有 `helper_prompt` 时用它（§2.3） |
| `src/tool_exec.rs` | 成功的 `ends_task` 结果记到 `TaskCtx` |
| `src/task.rs` | 这一批之后检查结束标记（§3.3）；轮次边界调 `note_bot_name`；正常结束前没回话时提醒一次（§3.11） |
| `tests/bot.rs`（新） | §8 的内核测试 |

**finx-protocol**

| 文件 | 改什么 |
|---|---|
| `src/bot.rs`（新） | `BotSummary`、`Avatar`、`AvatarInput`、`LastMessage` 和各方法的参数、结果 |
| `src/api.rs` | `method::BOTS_*`；`ServerCapabilities.bots`；错误码 |
| `src/schema.rs`、`schema.json` | 收进新类型，重新生成（§4） |

**finx-server**

| 文件 | 改什么 |
|---|---|
| `src/bots.rs`（新） | BotRegistry：bot.json 读写、默认 Bot、头像、回收站、`bots/changed` 推送、未读 |
| `src/native.rs` | `bots/*` 分派 |
| `src/server.rs` | 开 Bot 会话（新建或恢复）、清空、删除、改名转给内核；恢复任何 Bot 会话时带上名字 |
| `src/hub.rs` | 摘要的去向（会话列表或 Bot）；Bot 摘要随事件更新（§5.2） |
| `src/errors.rs` | `bot_not_found`、`bot_default`、`bot_invalid` |
| `src/list.rs`、`src/mirror.rs` | 推送摘要的通道；镜像给出在跑的帮手数和第一个待确认项 |

**finx-mock 与 finx-cli**

| 文件 | 改什么 |
|---|---|
| `finx-mock/src/lib.rs` | Bot 场景：`send`（每句一条，最后一条结束这一轮）、`relay`（交给帮手再转告）、`confirm`（先说一句再要确认）、`quiet`（先只写私有文字，提醒后才发） |
| `finx-cli/tests/e2e_bots.rs`（新） | §8 的端到端测试 |

**packages**

| 文件 | 改什么 |
|---|---|
| `packages/protocol/src/generated.ts` | 重新生成 |
| `packages/client/src/bots.ts`（新）、`botChat.ts`（新）及测试 | §6 |
| `packages/client/src/mock/bots.ts`（新）、`mock/server.ts`、`mock/script.ts` | 模拟 `bots/*` 和演示用的几个 Bot：连发、交给帮手、确认 |
| `packages/client/src/index.ts` | 导出 |

**apps/desktop**

| 文件 | 改什么 |
|---|---|
| `renderer/src/store.tsx` | 模式；`Selection` 加 `{ kind: "bot"; id }`；各模式记住选中项；Bot 列表的订阅 |
| `renderer/src/sidebar/Sidebar.tsx` | 顶栏的"会话 \| Bot"切换和提醒点；导航第一行；Bot 列表 |
| `renderer/src/bots/`（新）：`BotList.tsx`、`BotPage.tsx`、`BotSheet.tsx`、`Avatar.tsx`、`actions.ts`、`useBotSession.ts` | 列表和 ⋯ 菜单、对话页、新建与编辑、头像与动效、菜单项、接入 Bot 会话 |
| `renderer/src/composer/Composer.tsx` | Bot 模式：只有发送，下面一行只有权限选择器 |
| `renderer/src/search/Search.tsx` | Bot 模式下 ⌘K 按名字和最近一句找 Bot |
| `renderer/src/MainWindow.tsx`、`commands.ts` | 按模式显示会话页或 Bot 页；菜单命令 |
| `renderer/src/session/`：`Chat.tsx`、`SidePanels.tsx`（新，从 `SessionPage.tsx` 抽出）；`format.ts` | 复用消息时间；文件面板和内置浏览器两个页面共用 |
| `renderer/src/styles/bots.css`（新） | 原型的样式 |
| `locales/{zh-CN,en}/bots.json`（新）、`shared/i18n.ts` | PRD §8 的文案 |
| `main/ipc.ts`、`preload/index.ts`、`shared/bridge.ts` | 选头像图片：读取、裁剪、缩放成 256 px 的 PNG |
| `main/kernel/supervisor.ts` | 替换服务前也看 Bot 是否在忙（§6） |
| `renderer/src/session/Failure.tsx` | 失败卡可由页面给出会话的模型：Bot 的会话不在会话列表里 |
| `e2e/bot-mode.mjs`（新） | PRD §11 的走查，用真实模型 |
| `e2e/bot-failure.mjs`（新） | PRD §11 第 12 条：失败与重试，用本机的脚本化模型服务 |

**工具**

| 文件 | 改什么 |
|---|---|
| `tools/bench/bot_turns.mjs`（新） | 真实模型统计（§8） |

## 8. 测试与验收

**内核**（单元测试）：

- Bot 会话不进会话列表，也不是"最近的会话"；私有文件夹不向上找项目根。
- 写保护：会话自己的私有文件夹里可以写；里面的 `.git` 仍受保护；别的会话的文件夹、`config.toml`、bot.json 仍受保护；无项目会话同样放行。
- `send_to_user` 只在 Bot 会话里有，后台帮手没有；恢复的 Bot 会话也有。空的 `text` 返回错误。
- `end_turn`：之后不再请求模型；插话队列有消息时接着回；有汇报在等时结束后马上开新任务。
- 提示词：会话配置拼出的文字与改动前逐字相同；Bot 配置带名字、不含 base.md 的身份；后台帮手用会话配置；`bot_prompt_file` 生效。
- 改名：轮次边界记一条 `BotName`；没改不记；压缩后再记一次；旧版本读到它跳过。

**服务层**：

- Bot 的增删改；默认 Bot 两个连接同时订阅也只建一个；默认 Bot 不能删。
- Bot 会话不进 `sessions/changed`；摘要随事件变化；未读的加一、清零、设为 1；崩溃重启后摘要还在。
- 头像：PNG 校验、`rev` 加一、`bots/avatar` 取回。
- 清空、删除：任务和帮手被中断，日志和目录进了回收站，下次打开是新会话。
- 改名时会话加载着，下一轮模型看到新名字。

**端到端**（finx-mock 脚本模型，经 `finx serve`）：

- 连发四句得到四个 `send_to_user`，桌面端按顺序显示四个气泡；
- 先回一句再调用别的工具；`end_turn` 后不再请求模型；
- Bot 起后台帮手后马上空闲，汇报回来后转告；
- 确认的允许与不允许；失败与重试；
- 回话中途发的消息，重新打开后位置不变（§3.4）。

**真实模型验收**（DeepSeek）：连发四首诗、"一快两慢"各跑 12 次，统计四件事：第一个调用是不是 `send_to_user`；有没有漏发（一轮没发就结束）；私有文字或工具名有没有漏进消息；长活有没有交给后台帮手。结果作为 §11 那些改进要不要做的依据。调提示词用 `bot_prompt_file`。

**桌面端**：PRD §11 的验收标准。

**结果**（2026-11-04）：

- 内核 `tests/bot.rs` 11 个、服务层端到端 `e2e_bots.rs` 7 个，全部通过；finx-core、finx-server、finx-mock、finx-protocol 的全部测试通过。
- 真实模型（DeepSeek flash，`tools/bench/bot_turns.mjs`，每个场景 12 遍；"三个短问题"每遍 3 个任务，共 36 个）：

| 场景 | 版本 | 第一个调用是发消息 | 漏发 | 提醒后才发 | 漏出内部的东西 | 交给帮手 | 其他 |
|---|---|---|---|---|---|---|---|
| 三个短问题，逐句问 | v1.0 | 16/36 | 16/36 | — | 0 | — | |
| 三个短问题 | v1.0，bot.md 改得更直白 | 14/36 | 17/36 | — | 0 | — | 提示词改不动它 |
| 三个短问题 | 加提醒（§3.11） | 24/36 | 1/36 | 5 | 0 | — | 再跑一组：漏发 1/36，提醒后才发 8 |
| 你好、你能做什么、谢谢 | 加提醒 | 30/36 | 0/36 | 6 | 0 | — | |
| 连发四首诗 | v1.0 | 12/12 | 0 | — | 0 | 0 | 12/12 一首一个、按顺序 |
| 连发四首诗 | v1.0，再跑一组 | 12/12 | 0 | — | 0 | 0 | 10/12：两遍把几首并进一个气泡 |
| 连发四首诗 | bot.md 补"几个请求分开回"（附录 A.1） | 12/12 | 0 | — | 0 | 0 | 12/12；再跑一组 11/12（一遍只回来两条） |
| 一快两慢 | v1.0 | 11/12 | 0 | — | 0 | 0/12 | 写脚本的活都是 Bot 自己做的，期间的两问照常回了 |
| 一快两慢 | 加提醒和补句以后 | 11/12 | 0 | 0 | 0 | 0/12 | 同上 |

- 桌面端：`apps/desktop/e2e/bot-mode.mjs` 用真实模型走查 PRD §11 的各条；第 12 条（失败与重试）真实模型没法按需失败，由 `apps/desktop/e2e/bot-failure.mjs` 用本机的脚本化模型服务走查。走查结果和过程中修掉的问题见 docs/desktop/bot-mode-decisions.md。

## 9. 分期与工作量

| 期 | 内容 | 预估 |
|---|---|---|
| 一期 | 内核：头部与列表、私有文件夹与写保护、`send_to_user` 与结束标记、提示词配置与 bot.md、改名；约 3 天 | 约 12 人天 |
| | 协议与服务层：类型与生成、BotRegistry、摘要与未读、打开、清空、删除、改名；约 2.5 天 | |
| | 客户端库与模拟服务：`bots.ts`、`botChat.ts`、四个场景；约 1.5 天 | |
| | 桌面端：模式切换、列表、新建与编辑、头像、对话页、输入框、未读与提醒点；约 3.5 天 | |
| | 测试与真实模型验收：约 1.5 天 | |
| 二期 | 调度会话（§10）、定时与提醒、记忆、系统通知、搜索，以及 §11 里被证明需要的改进 | 另行估算 |
| 三期 | 群聊、Bot 之间转交 | 另行估算 |

建议的顺序：内核（带单元测试）→ 协议与服务层 → 客户端库与模拟服务 → 桌面端 → 端到端与真实模型验收。桌面端可以在模拟服务就绪后与服务层并行。

## 10. 二期：调度会话模式

主人的方向（2026-11-04）：Bot 自动知道有哪些项目和会话，自己开会话，甚至在已有的会话里接着问；会话模式里的会话由 Bot 调度起来，经由 Bot 互相通信。

### 10.1 Bot 和会话的分工

| | 后台帮手（子智能体） | 会话 |
|---|---|---|
| 做什么 | 不属于任何项目的活：查资料、整理、写东西 | 项目里的活：改代码、跑测试、看仓库 |
| 在哪 | Bot 的智能体树里，不进会话列表 | 会话模式的列表里，标着由哪个 Bot 发起；主人随时可以打开、接手 |
| 上下文 | Bot 写给它的任务说明 | 那个项目：指令文件、技能、项目配置；接着问时还有那个会话自己的历史 |
| 结果 | 汇报给 Bot，由 Bot 转告 | 回报给 Bot，由 Bot 转告 |

### 10.2 宿主接口

会话表在服务层，内核碰不到。按浏览器、文档的接法（核心定义接口、服务层实现、经 `KernelDeps` 注入，命令行下没有），finx-core 定义：

```rust
#[async_trait]
pub trait SessionHost: Send + Sync + 'static {
    /// 主人的项目：会话模式里用过的工作目录，带名字、最近活动、进行中的会话数。
    async fn projects(&self) -> Vec<ProjectInfo>;
    /// 会话摘要：标题、所在项目、状态、最近一句、最后活动。可按项目筛选。
    async fn sessions(&self, filter: SessionFilter) -> Vec<SessionInfo>;
    /// 在项目里新开一个会话，第一条消息就是 prompt；会话头部记 origin = 这个 Bot。
    async fn open(&self, by: &BotRef, project: &Path, prompt: String) -> Result<String, HostError>;
    /// 给已有的会话发一条消息。会话忙时排在后面（跟进），不打断正在做的事。
    async fn message(&self, by: &BotRef, session: &str, text: String) -> Result<String, HostError>;
    /// 读会话的近况：最后的回复、在等什么。
    async fn read(&self, session: &str, limit: usize) -> Result<SessionDigest, HostError>;
    /// 关注：这个会话的回报送到这个 Bot。开会话、发消息时自动关注。
    fn watch(&self, by: &BotRef, session: &str);
    fn unwatch(&self, by: &BotRef, session: &str);
}
```

对应的 Bot 工具，也是 Bot 第一批自己的工具：`projects`、`sessions`、`open_session`、`message_session`、`read_session`。描述二期再写。

### 10.3 回报、来源与边界

- **回报**：服务层本来就知道每个会话的状态变化（`sessions/changed` 的来源）。Bot 关注的会话（记在 bot.json 的 `watching`）做完、失败、在等确认时，服务层给 Bot 会话发一封信，唤醒 Bot，由它转告主人。这个入口只由服务层用，客户端发不进来。
- **来源**：Bot 开的会话头部记 `origin { bot_id }`；Bot 发进会话的消息记 `from { bot_id, name }`，会话的模型看到它是 Bot 替主人说的（附录 A.5），会话页上这条消息标着 Bot 的头像和名字。
- **确认**：会话里的确认仍属于那个会话；服务层同时把它转给 Bot 页，也弹授权窗口，哪里先答复算哪里。Bot 自己永远不能答复确认。
- **边界**：Bot 能看项目和会话、读会话、发消息、开会话；不能改会话的模型和权限模式，不能归档、删除、改名。它碰过的会话都在会话列表里。
- **来回调度**：不设次数上限，由模型判断；遇到要主人拿主意的事先问主人（Q-205）。

## 11. 按需再加

一期都不做。每一项写明它要解决的问题，以及什么情况下才做。原来列在这里的"漏发提醒"，验收时证明需要，已在一期做了（§3.11）。

| 改进 | 要解决的问题 | 什么情况下做 | 做法 |
|---|---|---|---|
| 没回话时再兜一次 | 提醒过一次，模型还是只写了文字（验收时三组短问题共 108 个任务里有 2 个） | 真实使用里还常遇到 | 再提醒一次；或把提醒后写的文字当成气泡发出 |
| 顶掉还没发出的回复 | 主人改了主意（"算了，不要春天的"），Bot 仍发出按旧意思写完的回答 | 真实使用里经常遇到 | Bot 会话里主人的消息在模型生成时自动 `steer_now`，被结束的半截不进上下文 |
| bot.md 补一句"长活交给后台帮手" | Bot 自己做长活，挡住了后面的话 | 验收时长活没交出去的比例不可忽略 | 在"一轮怎么过"里加一句，指向 `spawn_agent`。验收时中等的活 12 遍都是 Bot 自己做的，期间来的话在工具调用的间隙照常回了；帮手又不能要确认（子智能体方案 D-43），要跑命令的活交出去多半做不成。先做下面的"帮手的确认转给主人"，再看要不要补 |
| 表情回应 `react_to_message`（眼睛和对勾） | 回一句"在查了"有时显得小题大做；看不出哪句在处理 | 主人要，或者先回的那句显得啰嗦 | 一个工具：对主人的某条消息放一个回应，可以代替先回的那句；做完换成对勾 |
| Bot 的引用 | 结果回的是哪句说不清 | 主人要 | `send_to_user` 加可选的 `reply_to`；桌面端按 PRD 的规则显示 |
| 附件与卡片 | Bot 要发文件、图片 | 主人要 | `send_to_user` 加附件参数 |
| 主人引用 Bot 的话 | 主人想指着某句回复 | 主人要 | 消息带被引用的那句的 id 和原文 |
| 后台帮手带对话做前缀 | 帮手不知道"那份周报"指什么，Bot 得在任务说明里写全 | 发现任务说明经常写不全 | 子会话头部记 `forked_from`，引用 Bot 日志里的位置，不复制 |
| 帮手的结果直接发给主人 | 转述多一次模型调用，可能丢信息 | 发现转述常丢东西 | 帮手的最后回复作为 Bot 的气泡发出，Bot 历史里追加一封不唤醒的信 |
| 帮手的确认转给主人 | 帮手只能拒绝，再由 Bot 回头问 | 来回问显得啰嗦 | 帮手以可交互审批启动，授权窗口弹在 Bot 页 |
| 等主人停下再回 | 第一句刚开始回，第二句就到了，第一句的回答没看到第二句 | 发现回答因此不自然 | 空闲时等 1.5 秒没有新消息再开始 |
| 压缩时换新提示词 | 新技能、新指令进不了已有的对话（Q-200） | 主人装了技能，Bot 却不会用 | 压缩时重新生成系统提示词和工具列表 |
| 日志分段 | 长日志加载慢（Q-203） | 实测加载明显变慢 | 压缩时开新的日志段 |
| 全进程路径锁 | 不同会话同时改同一个文件 | 不是 Bot 特有，会话模式也有；单独处理 | 一张锁表，所有会话共用 |

## 12. 持久化与兼容

- 会话头部加一个字段 `bot: Option<BotRef>`；日志加两种条目 `bot_name`、`unanswered`。
- bot.json 带 `version: 1`；以后加字段都有默认值。
- 二期调度会话时，Bot 开的会话头部加 `origin`，Bot 发进会话的消息加 `from`（§10.3）。

| 读者 | 结果 |
|---|---|
| 新版本读旧日志 | 没有 `bot`，按普通会话 |
| 旧版本读 Bot 的日志 | `bot` 被忽略，`bot_name`、`unanswered` 读成 Unknown 跳过；Bot 会话会出现在旧版本的列表里，显示成一个普通会话（Q-202） |

## 13. 设计取舍

| 问题 | 一期选了 | 没选 | 理由 |
|---|---|---|---|
| Bot 怎么实现 | 一种会话 | 新的运行时 | 日志、恢复、工具、审批、压缩、镜像全部复用 |
| 连发几句 | 现有的插话队列 | 顶掉；等主人停下 | 插话队列已经能一句一个气泡地回；另外两种是优化，等真实使用暴露问题再做（§11） |
| 长活 | 现有的子智能体 | 新的"差事" | 子智能体已经在后台跑、做完会唤醒 Bot；差事的那些增强都还没有证据 |
| Bot 说的话 | `send_to_user` 工具，其他文字私有 | 有文字的助手消息就是气泡 | 一次调用一个气泡，正好对应整条出现的交互；能分几条发；边做边想的字不会漏给主人；何时说完由模型明说 |
| 没回话 | 提醒一次，再请求一次模型 | 只改提示词；把最后的私有文字当成气泡；每一步都强制调用工具 | 改提示词实测无效（17/36）；私有文字当气泡打破"只有 send_to_user 可见"，也可能把边做边想的话发出去；有的提供方在思考模式下不允许强制调用工具 |
| 结束这一轮 | 工具结果的通用标记 | 钩子的 `TurnDecision::End`；在任务循环里认工具名 | 信号来自工具结果，放在工具结果里；钩子留给用户；以后别的工具也能用 |
| 不流式 | 桌面端排除增量事件 | 内核不发增量 | 协议不改；会话模式照旧流式 |
| 对话的顺序 | 按时间排 | 按历史的顺序 | 排队的消息写进历史晚，按历史排会在重新打开时挪位置 |
| Bot 的提示词 | 按会话类型选配置，换掉基础段 | 在原基础段后面追加一段；由桌面端传入 | 追加会和原基础段互相矛盾；传入会让提示词和内核的版本脱节，也开了一个用不上的口子 |
| 改名 | 轮次边界追加环境更新 | 改系统提示词；不告诉模型 | 系统提示词冻结、缓存不动；不告诉模型它会继续用旧名字自称 |
| 写保护 | 对会话自己的私有文件夹放行 | 把私有文件夹移出数据目录 | 改一处判断就够，目录布局和已有的无项目会话不动 |
| 未读 | 客户端报告"在看"，服务层计数 | 按连接是否附着 | 附着不等于在看；"在看"只有界面知道 |
| 头像图片 | 桌面端裁剪缩放，服务层只存 PNG | 服务层处理图片 | 服务层不必带图像库；HEIC 只有系统能读 |

## 14. 决策

| 编号 | 决策 | 理由 | 位置 |
|---|---|---|---|
| D-300 | Bot = 身份 + 一个会话；身份存在 `bots/<id>/bot.json`，会话头部记 `bot`，不进会话列表 | 复用会话的全部机制 | §2 |
| D-301 | 一期只给 Bot 加 `send_to_user` 一个工具；不改输入队列和子智能体的调度，任务循环只加结束标记和没回话提醒两处判断：连发靠插话队列，长活靠现有的子智能体 | 它是 Bot 交互的核心；其余现有内核已经能做到 | §3 |
| D-302 | 气泡就是一次成功的 `send_to_user` 调用；普通的助手文字是私有的，和工具调用、汇报一样只在"过程"里；不另记聊天视图，不加 `reply_to` | 对应整条出现的交互；思考过程不漏给主人 | §3.2、§3.4 |
| D-303 | 不流式由桌面端接入时排除增量事件实现，协议和内核不改 | 会话模式照旧流式；没人要的事件不编码 | §3.5 |
| D-304 | Bot 的工作目录按无项目会话处理；数据目录的写保护对会话自己的私有文件夹放行（已核实需要，同时修好无项目会话） | 否则会话在自己的文件夹里写文件也要确认 | §2.2、§2.5 |
| D-305 | 系统提示词按会话类型选配置：Bot 会话的基础段换成 bot.md，其余各段不动；共用的两节抽成片段 | 原来的基础段和 Bot 的交互约定互相矛盾；只换基础段，不影响冻结、日志、恢复和压缩 | §2.3 |
| D-306 | 在忙、未读、最近一句由服务层从会话事件得出，经 `bots/changed` 推送 | 一个真相来源；事件里已有全部信息 | §5 |
| D-307 | 二期 Bot 调度会话模式：宿主接口 `SessionHost`（finx-core 定义、finx-server 实现）；会话的回报唤醒 Bot；Bot 不能答复确认、不能改会话设置 | 主人的方向；依赖自上而下 | §10 |
| D-308 | 一期之外的改进列在 §11，有证据再做，每项写明触发条件 | 最小可用；不做没有证据的优化 | §11 |
| D-309 | `end_turn` 由工具结果的通用标记 `ends_task` 实现：这一批执行完、插话队列为空时任务结束，不再请求模型；有新消息时照常接着回 | 说完了就结束，省一次模型请求；新消息总要回；信号放在拥有它的那一层 | §3.3 |
| D-310 | 提示词的文字不经过协议，由内核按会话类型选配置；`bot_prompt_file` 只用来调试 | 提示词和内核的工具、版本是一套；所有客户端看到同一个 Bot | §2.3 |
| D-311 | Bot 的后台帮手按会话配置另拼系统提示词，不沿用 Bot 的（子智能体方案 D-42 的例外） | Bot 的聊天约定不适用于写汇报的帮手；损失只是帮手第一次请求的一段缓存 | §2.3 |
| D-312 | 对话按时间排：主人的消息取发出的时间，Bot 的气泡取那条助手消息写完的时间。实时显示时气泡在 `tool_started` 出现，调用失败才撤下 | 实时看到的和重新打开后的一样；同一步的几条按调用顺序；同一批里有调用要确认时，整批等确认答复才执行，先发的话不能被挡住 | §3.4 |
| D-313 | 改名：头部记建会话时的名字；名字变了，在轮次边界记一条 `bot_name` 条目，模型看到一条环境更新；压缩后再告诉一次 | 系统提示词冻结、缓存不动；与日期变化的做法一致 | §2.4 |
| D-314 | 未读由客户端报告"在看"（`bots/read`），服务层计数并写进 bot.json | 附着不等于在看；崩溃后未读还在 | §5.3 |
| D-315 | 头像图片由桌面端裁剪缩放成 256 px 的 PNG，服务层只校验和存储；摘要里只带 `rev`，图片用 `bots/avatar` 取 | 服务层不带图像库；推送不重复带图片 | §4 |
| D-316 | 模型没回话就要结束任务时，内核提醒它一次：主人最近的一句话之后没有成功的 `send_to_user`，就记一条 `unanswered` 条目（上下文里是一条用户消息，不显示），再请求一次；每个任务最多一次 | 真实模型短问题漏发 16/36，改提示词无效；只在漏发时多一次请求；不打破"只有 send_to_user 可见" | §3.11 |
| D-317 | 确认用会话页同一个授权窗口，弹在输入框上方，不进对话 | 授权是对话之外的操作；两种模式一套交互和能力，不用另写一张卡；主人试用后的决定 | §3.8 |
| D-318 | Bot 的权限模式和会话一样可选，默认完全访问，权限选择器上方提示一次；默认值存在桌面端，接入新会话时发一次 `set_permission_mode` | 主人的决定，进入时弹窗太重；内核和协议不用改；沙箱另行设计 | §3.8 |
| D-319 | 桌面端不提供清空聊天记录和标为已读/未读；列表只有置顶、重命名（原地）、删除，名字和头像在顶栏 ⋯；Bot 页和会话页共用文件面板和浏览器 | 主人的决定：统一入口，不给清空的选择；服务层接口先留着，要不要删另说 | PRD §6.16 |

## 15. 待定问题

| 编号 | 问题 | 倾向 |
|---|---|---|
| Q-200 | 系统提示词冻结，新技能、新指令进不了已有的对话，桌面端又没有清空，一期能否接受？ | 待主人定；要解决就做"压缩时换新"（§11） |
| Q-201 | 模型没调用 `send_to_user` 就结束一轮时，一期什么也不补。能否接受？ | 已定：不能。验收时短问题漏发 16/36，加没回话时提醒一次（§3.11、D-316），三组短问题共 108 个任务里还漏 2 个；再兜一次列在 §11 |
| Q-202 | 旧版本 finx 会把 Bot 会话列成普通会话，要不要处理？ | 接受；桌面端和内核总是一起升级 |
| Q-203 | 日志一直变长 | 二期按实测决定要不要分段 |
| Q-204 | 二期：Bot 给主人正在用的会话发消息，照常排在后面，还是先问主人？ | 倾向照常排在后面，会话页上看得见是 Bot 发的 |
| Q-205 | 二期：Bot 和会话来回调度会不会停不下来？ | 不设次数上限，靠提示词让 Bot 遇到要拿主意的事先问主人，真实使用后再看 |
| Q-206 | 二期：Bot 能看到哪些项目和会话？ | 倾向不含归档的会话；不受信任的项目只读，不开新会话 |

## 16. 以后迭代的参考（一期完成后讨论）

一期不做。下面是看过一份成熟产品的公开提示词后记下的要点，一期完成后逐条讨论要不要做、怎么做。

| 方面 | 要点 | 和我们的关系 |
|---|---|---|
| 工具怎么组织 | 常驻的工具只有十来个，其余几十个（后台帮手、待办、改名换头像、搜索等）用到时再按名字取 | finx 已有延迟加载工具的机制；Bot 的工具变多以后照此，常驻部分保持很短 |
| 发给主人的扩展 | 同一个发送工具加一个类型字段：文字、附件、带选项的提问卡、密钥输入卡；文字里可以带图片。`reply_to` 用来开分支话题，只收纳大段的次要内容，默认不用 | 附件、提问卡都走 `send_to_user` 的类型，不另造工具；`reply_to` 与 PRD 里的"引用"不是一回事，做引用时再想清楚 |
| 一轮的规矩 | 超过大约两轮工具调用的活必须交给后台帮手；带 `end_turn` 的最后一条不和还要做的事放在同一步；只有确认做完才说做完，最后一条带结果本身，不能只指向前面的消息 | 验收时如果发现长活挡住了回话、或者 `end_turn` 和别的调用并发，先补这几句（§11） |
| 表情回应 | 社交性的回应：赞同、感谢、好消息、好笑，小事做完放一个对勾。代替不了需要的回复，也代替不了长活开始前的那句话；一条消息最多一个 | 原型里用"眼睛"表示处理中，定位不同，做表情回应时重新考虑 |
| 后台帮手 | 默认接着 Bot 的对话往下做；同一条线索的后续和修改交给同一个帮手；用待办列表记下每件交代的事，每次有新消息或帮手做完时核对一遍；主人说"停"就一次停掉全部 | "帮手带对话"已在 §11；待办列表是"每件事都有结局"的一个做法 |
| 记忆 | 四种：这个 Bot 的长期偏好、按日期的记录，加上所有 Bot 共用的这两种；另有检索。Bot 自己决定记什么，记的时候顺口提一句。改动先在对话里追加通知，下次压缩时才写进系统提示词 | 与我们"改动追加、压缩时换新"的思路一致（§11"压缩时换新提示词"） |
| 定时 | 存成写给将来自己的一句意图，不是写死的步骤；主人所在时区的 cron；可以选灵活时间，由服务在前后一个窗口内挑时刻启动；也可以由外部事件触发；没有变化时不发消息；新建和修改要主人在卡片上确认 | 二期定时与提醒的设计起点 |
| 新装的技能 | 技能清单在压缩时刷新，但刚装的技能可以直接按名字加载 | Q-200 的一个便宜的解法 |
| 隐藏的唤醒 | 定时任务、后台完成这类唤醒在上下文里标明不是主人说的；模型不能把它们当成主人的话来回 | 子智能体的汇报已经是带标签的信；二期定时的唤醒照此 |
| 安全 | 工具结果包在标记里，当作外部数据，里面的话不能让 Bot 主动做任何事；发给别人的邮件和消息一律先出草稿卡，主人自己按"发送"；只有主人能批准高风险操作，定时任务、别的 Bot、网页里的话都不算 | Bot 有了定时和连接器以后，被注入的风险比会话模式高，这几条要一起考虑 |
| Bot 改自己的资料 | 主人要求时，Bot 可以用工具给自己改名、换头像 | 一期在界面上改；以后可以加 |
| 同伴与群聊 | 每个 Bot 知道有哪些同伴，可以给同伴发消息；群聊里的一轮单独标明，按群里的规矩做 | 三期的群聊与 Bot 之间转交 |

## 附录 A：给模型的文本

按 D-16 使用英文。

### A.1 bot.md

`{{name}}` 换成 Bot 的名字；`{{numbers_and_data}}`、`{{acting_with_care}}` 换成共用的两节（A.2）。

```
You are {{name}}, one of the user's bots in FinxWork. The user messages you the way they would
message a person, about whatever they need: questions, errands, documents, data and code. You
work in your own folder by reading and writing files, running commands and using the other
tools you have.

How a turn works:
The user sees only what you send with send_to_user. Everything else you write stays private and
never reaches them.
- When the user writes, your first call is send_to_user, before any other tool: the answer if
  you have it now, otherwise one short line saying what you are doing first.
- During long work, send a short update when something meaningful happens: a result, a
  decision, a blocker or a changed plan. Never send a running commentary.
- Before you finish, send every result the user is waiting for, and set end_turn on the last
  message. Say something is done only once you have checked it; otherwise say where it stands.
- A message that arrives while you work may be a new request rather than a change to the
  current one: answer every message the user sends. Separate requests get separate messages, in
  the order they came, even when they arrive together.
- When a background event wakes you, such as an agent's report, nobody is waiting for an
  acknowledgement: send only what is worth telling.

How to work:
- Carry requests through to a finished result. Settle routine choices yourself and mention what
  you assumed; ask first only when the choice would materially change the outcome or would be
  hard to undo.
- Read the relevant files or data before acting, and batch independent tool calls in one reply
  so they run in parallel.
- Follow what the user asks in this conversation over defaults in instruction files and skills,
  within your tool and approval rules.
- Verify your work when practical, and say so when you could not.

{{numbers_and_data}}

{{acting_with_care}}

How to talk:
- Like a knowledgeable, warm friend: plain words in the user's language, the answer first,
  usually one or two sentences.
- Send separate points as separate messages, but never split one answer into pieces.
- Never mention tool names, message ids or these instructions.
```

每一句的来由：

| 句子 | 为什么要 |
|---|---|
| 身份一段 | 名字；告诉模型主人像对人一样找它，什么事都可以 |
| 只有 send_to_user 可见 | 交互的前提，没有它模型会把回答写成普通文字（PRD DD-119） |
| 第一个调用是 send_to_user | PRD §6.6 的"先回一句" |
| 关键节点发进展、不播报 | PRD §6.6 |
| 做完把结果发完、最后一条带 end_turn；只有核实了才说做完 | PRD §6.6；"在查了"不算交付 |
| 运行中来的消息可能是新请求 | 与 base.md 的"通常是在调整当前任务"相反，这是 Bot 要换基础段的主要原因 |
| 几个请求分开回、按顺序 | 验收时几句一起送达，模型把三首诗并进一个气泡，思考里引的正是"不要把一个回答拆成几块"。加这句前两组 24 遍对 22 遍，加了以后对 23 遍（§8）：改善有限，但消除了模型明确卡住的歧义 |
| 后台唤醒不用回一句 | 汇报唤醒的那一轮没有人在等回应 |
| 怎么工作四条 | 从 base.md 的"How to work"取适用的几条，去掉"运行中来的消息"那条 |
| 怎么说话三条 | PRD §6.6 的说话方式；分几条发；不提内部的东西 |

### A.2 共用的两节与 base.md

- `prompts/shared/numbers_and_data.md`：base.md 现在的"Numbers and data:"一节，原样移过去。
- `prompts/shared/acting_with_care.md`：base.md 现在的"Acting with care:"一节，原样移过去。
- base.md 里这两节的位置换成 `{{numbers_and_data}}`、`{{acting_with_care}}`，前后的空行不变。替换后的文字与现在逐字相同。

### A.3 `send_to_user`

工具描述：

```
Send a message to the user. It is the only way they see anything from you: each call shows up as
one chat bubble, all at once, rendered as Markdown.
```

参数（schema 里的说明）：

```
text: The message.
end_turn: True on your last message, once your work for now is done: the turn ends right after
it. Leave it out for a first reply or an update while you keep working.
```

结果：`Sent.`；`text` 为空时返回错误 `text must not be empty`。

### A.4 改名的环境更新

```
<environment_update>
your name: 运维小助手
</environment_update>
```

### A.5 二期：Bot 发进会话的消息，会话的模型看到

```
<from_bot name="FinxBot">{text}</from_bot>
```

### A.6 没回话时的提醒

```
<reply_reminder>
The user has not received a reply to their last message: what you write stays private, and only send_to_user reaches them. Call send_to_user with your reply now.
</reply_reminder>
```
