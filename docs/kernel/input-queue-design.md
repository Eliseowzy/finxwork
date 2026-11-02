# finx 插话与跟进：运行中输入方案

| 项 | 内容 |
|---|---|
| 版本 | v0.2 |
| 日期 | 2026-11-02 |
| 状态 | 第一版已实现（分支 feat/input-queue，未合入 main），实现说明见 §10；界面原型见 docs/desktop/input-queue-demo.html |
| 关系 | 扩展 technical-design.md（下称总方案）§6.3、§6.4、§6.7、§8；protocol-design.md（下称协议方案）§3.3、§3.4、§6.6；取代 subagent-design.md §8.1 的 `input_queued`，以及 main 上随浏览器控制三期加入的 `input_queued` 事件，采纳其 §8.3；桌面端部分对应 desktop-design.md §5 的输入框 |

## 方案摘要

- **问题**：任务运行中发出的消息，从按下 ↩ 到送达模型之间，界面上什么都没有：发出后输入框清空，消息在送达前不出现，也不能撤回、修改或提前。任务失败时排队的消息被丢弃，只留一条 warning；中断时交还的消息，桌面端只取文字，输入框里有草稿时整段丢掉。
- **放在哪里**：放在内核。插话和跟进本来就存在内核会话状态里，送达时机由轮次边界决定，只有内核知道。方案是让这份状态可见、可寻址、可修改。桌面端只渲染，不另存一份队列。
- **协议增量**（版本 2 之内，capabilities 声明 `input_queue`，桌面端要求内核具备它）：
  - 排队的输入在入队时就有 id，也就是它将来那条用户消息的 `message_id`；
  - 新事件 `queue_changed { queued }` 带完整队列，按送达顺序排列；快照带 `queued`；
  - 新 Op：`withdraw { id }`（撤回，成功时发 `input_withdrawn { id }`）、`requeue { id, mode }`（插话与跟进互换）、`steer_now`（结束当前这一步，插话马上送达，任务继续）；
  - `task_failed` 增加 `returned_input`：失败与中断一样交还，不再丢弃。
- **三档送达时机**：跟进（任务完成后）→ 插话（下一步）→ 立即（结束当前这一步）。界面上每条排队消息的主动作就是"往前一档"：跟进的是"改成插话"，插话的是"立即送达"。这就是插队。
- **桌面端**：输入框上方一个排队托盘，与输入框同宽，像从它后面露出来的一格。一条一行：图标和文字分别与输入框的"+"和正文对齐，右侧写送达时机，悬停时换成动作。送达时，这一行从托盘离开，消息在对话里升起。↑ 编辑最后一条；停止、失败、编辑交还的内容连同附件放回输入框，与草稿合并。
- **不变的**：模型看到的仍是普通的用户消息，不加提示词；停止的语义不变；ACP 一期不变；没有数量上限。
- **顺带修的**：插话尽量晚取，等 MCP 或压缩期间到达的也赶得上这一次请求；任务结束时"取下一条输入"和"开始下一个任务"在同一把锁里完成，消掉一个可能同时跑两个任务的窗口。
- **工作量**：内核与协议约 1.5 天，客户端库、模拟服务与桌面端约 1.5 天，测试与真实模型验收约 0.5 天。

## 目录

- 方案摘要
- 0. 阅读说明
- 1. 现状与问题
- 2. 状态放在哪里
- 3. 内核
- 4. 协议
- 5. 桌面端
- 6. 客户端库与模拟服务
- 7. 测试与验收
- 8. 实施计划
- 9. 决策与待定问题
- 10. 实现说明

## 0. 阅读说明

- **术语**：
  - **插话（steer）**：任务运行中发出、在下一个轮次边界送达的输入。界面上叫"下一步送达"。
  - **跟进（follow_up）**：任务本来要结束时才送达的输入，送达后同一个任务继续。总方案 §6.7 里叫"追加"；界面上叫"排队"，时机写作"完成后送达"。
  - **排队输入**：已经交给内核、还没写进历史的插话和跟进。
  - **送达**：排队输入写进历史，发出它的 `message_completed`。从这一刻起，下一次模型请求就会带上它。
  - **一步**：一次模型回复，加上它发起的那一批工具调用。两步之间就是轮次边界。
- **编号**：决策从 D-200 起，待定问题从 Q-140 起，避开并行文档正在使用的编号。并入总方案时保持不变。

变更记录：

| 版本 | 日期 | 说明 |
|---|---|---|
| v0.1 | 2026-11-02 | 方案与原型 |
| v0.2 | 2026-11-02 | 第一版实现（§10）：在 main 已有的 `input_queued` 与发送方式开关上改；事件与快照字段用 `queued`；capability `input_queue` 由桌面端列为必需；删掉发送方式开关，↩ 插话、⌥↩ 排队；界面沿用"排队"的叫法 |

## 1. 现状与问题

### 1.1 内核现在怎么做

- `Op::Prompt` 带 `mode`（steer 或 follow_up，默认 steer）。会话空闲时直接开始任务；有任务时按 mode 放进 `SessionState.steer` 或 `follow_up` 两个队列（`crates/finx-core/src/task.rs` 的 `on_prompt`）。
- 每个轮次边界先投递子智能体的汇报，再把插话全部写进历史（`run_task` 循环开头）。这一轮有工具调用、或者还有插话时继续下一轮；否则取一条跟进写入，同一个任务继续。
- 任务结束时：
  - 正常结束：最后一次检查之后才到的输入，取一条开始下一个任务；
  - 失败：两个队列清空，发一条 warning（"N queued message(s) were discarded…"）；
  - 中断：两个队列清空，内容放进 `task_interrupted.returned_input` 交还前端，并设 `hold`。
- 入队时把 `input_seq` 加一，同步等待子智能体的工具监听它，用户一插话就不再等（subagent-design §8.2）。
- ACP 的 `session/prompt` 在有任务时返回 `prompt_in_progress`（协议方案 §7.4），不排队。

### 1.2 用户看到的

在桌面端预览（模拟服务）里复现：任务运行中先按 ↩ 发一条插话，再按 ⌥↩ 发一条跟进。

1. **发出后看不见**：两条消息发出后输入框清空，界面上没有任何痕迹。插话要等当前这一步结束才出现在对话里，跟进要等任务做完；这期间如果等审批，就一直看不见。
2. **改不了**：发错了不能撤回，想改不能改，想让跟进早点送达也没有办法。
3. **失败即丢**：任务失败时排队的消息被丢弃，只有一行英文 warning。
4. **中断交还不完整**：桌面端只取交还内容里的文字，图片和附件丢失；输入框里已经有草稿时，交还的内容整段不放回（`Dock.tsx` 只在草稿为空时放）。
5. **多端不一致**：同一个会话接入两个客户端时，A 排的队 B 看不到；重新接入拿到的快照里也没有队列。
6. **插话偶尔慢一步**：插话只在循环开头取。等 MCP 服务器就绪或做压缩期间到达的插话，赶不上紧接着的那次请求，要再等一整步。

### 1.3 目标

| 编号 | 目标 |
|---|---|
| G1 | 按下 ↩ 的同时就看到消息已收下、什么时候送达 |
| G2 | 送达前可以撤回、修改、提前；送达的那一刻看得见 |
| G3 | 输入不因停止、失败、撤回而丢失，附件也不丢 |
| G4 | 所有客户端看到同一个队列，断线重连、关闭窗口后都一致 |
| G5 | 安静：没有排队时什么都不多；与会话页现有的尺寸、颜色、动效一致 |
| G6 | 协议增量最小，与 ACP 的草案能直接对应，不增加转换开销 |

## 2. 状态放在哪里

### 2.1 三个选项

| | A. 桌面端缓存 | B. 服务层缓存 | C. 内核状态加事件（采用） |
|---|---|---|---|
| 做法 | 跟进留在桌面端，任务结束时再发；插话照常交给内核 | `finx serve` 的会话中枢替会话存一份跟进，内核空闲时提交 | 内核已有的两个队列加上 id、事件、快照和三个 Op |
| 插话的时机 | 只能交给内核，所以还是两份状态 | 同左 | 一份状态 |
| 多个客户端、重连 | 各看各的，重连就没了 | 一致 | 一致 |
| 关闭窗口 | 跟进丢失，但任务在常驻服务里继续跑 | 不丢 | 不丢 |
| 与汇报唤醒的先后 | 任务结束与子智能体汇报唤醒同时发生时，跟进可能成了下一个任务的插话 | 中枢看不到内核里的汇报唤醒，同样有竞争 | 内核在同一把锁里决定先后 |
| 空闲判断 | 内核发了 `idle`，前端手里还有跟进：列表显示已完成，ACP 和 `finx exec` 以为做完了 | 同左 | `idle` 本来就要求两个队列为空（`check_idle`） |
| 撤回与送达的竞争 | 前端不知道插话是不是刚刚送达 | 同左 | 只有内核能原子地判断"撤回成功"还是"已经送达" |
| 进程内 API、命令行 | 用不上 | 用不上 | 都能用 |
| 改动量 | 小，但每个客户端各写一遍 | 中 | 中，一次写在内核里 |

### 2.2 结论

选 C。队列一直在内核里，缺的只是可见、可寻址、可修改。A 和 B 都要在内核之外再存一份，并和内核对账：

- 插话的送达时机只有内核知道，前端或中枢最多只能存跟进，于是一份输入被拆成两份状态；
- 对账要处理"已提交但没确认""插话没赶上、转成跟进""中断后要不要重发"这些中间状态，每个客户端都要写一遍；
- 常驻服务里任务不随窗口关闭而停（协议方案 §3.8），存在窗口里的跟进会跟着窗口一起没。

外部做法也指向同一个结论：

- 有一个成熟的编码 agent，最初在客户端排队、插话交给内核，客户端为此维护了"待确认""被拒的插话""中断后重发"等多种状态。后来它把排队搬进了服务端：每条有 id，可以增删改排，变化时通知所有客户端，任务完成或失败后按先后自动送出，中断后暂停。
- ACP 的草案（prompt-delivery，仍在讨论）把两种送达方式定义为 `session/prompt` 的 `delivery` 字段（steer 或 queue），由 agent 决定插入时机，用 agent 给的 `messageId` 对应送达，送达前可以用 `$/cancel_request` 撤回。也就是说，状态在 agent 一侧。
- 主流编辑器和编码 agent 产品的界面都把排队的消息放在输入框附近，提供编辑、删除和"立即发送"。编辑有两种做法：放回输入框改完再发，或者在队列里原地改。

## 3. 内核

### 3.1 排队输入与 id

```rust
// crates/finx-core/src/session.rs
pub(crate) struct Input {
    /// 入队时分配，也是送达后这条用户消息在日志里的条目 id（message_id）。
    pub(crate) id: String,
    pub(crate) message: UserMessage,
    pub(crate) skills: Vec<SkillText>,
}
```

- **id 就是将来的消息 id**：入队时用 `history.new_id()` 分配（同时避开正在排队的 id），送达时用 `record_with_id` 写入。助手消息已经是先分配、后写入（`message_started` 先于 `message_completed`），这里沿用同一种做法。
- 好处：`message_completed` 不用加字段，客户端拿排队项的 id 直接找到对话里那条消息；ACP 草案里 agent 给的 `messageId` 也就是它。
- 会话空闲时的 prompt 不排队，照旧在开始任务时分配 id。

### 3.2 送达规则

| | 什么时候送达 | 怎么送达 |
|---|---|---|
| 插话 | 下一个轮次边界：这一步的模型回复和工具调用都结束之后、下一次请求之前 | 全部按发出顺序一起写入；先投递汇报，再写插话，用户的话在最后（不变） |
| 跟进 | 任务本来要结束时（这一步没有工具调用，也没有插话） | 一次一条，写入后同一个任务继续 |
| 任务结束后才到的 | 结束的那一刻 | 插话优先，取一条开始下一个任务，其余照常排队 |

**插话尽量晚取（D-206）**：现在只在循环开头取插话，之后还有等 MCP 就绪、压缩这些可能较久的步骤。改为在组装这一次请求之前再取一次，这期间到达的插话也能赶上这次请求。

**取下一条输入与开始下一个任务在同一把锁里完成（D-207）**：现在 `finish_task` 先在锁里清掉 `active_task`、取出下一条输入，出了锁再调用 `start_task`。这两步之间，提交循环里的 `on_prompt` 或 `on_mail` 看到会话空闲，可能另起一个任务，于是两个任务同时运行。改为在同一个临界区里登记下一个任务的 `ActiveTask`。

### 3.3 三个新 Op

| Op | 作用 | 条件与结果 |
|---|---|---|
| `withdraw { id }` | 撤回一条排队输入 | 还在队列里：移出，发 `input_withdrawn { id }`，再发 `queue_changed`。已经送达或不存在：什么也不做 |
| `requeue { id, mode }` | 在插话与跟进之间换 | 移到目标那一类的末尾，id 不变，发 `queue_changed`；类别相同或不存在时什么也不做 |
| `steer_now` | 结束当前这一步，让等待中的插话马上送达 | 见下 |

`steer_now` 的语义：

- **只在有插话在等、并且这一步正在模型请求或工具执行中时生效**，否则什么也不做。没有插话时不打断：模型可能正在回应刚刚送达的那条插话。
- **结束的是这一步，不是任务**。正在生成的回复照中断的规则保留已收到的文字（总方案 §6.5）；正在执行的工具按取消处理，结果是 `Cancelled by user.`；还没开始的调用补一条 `Tool call was not executed (interrupted).`。随后进入轮次边界，插话写入，同一个任务继续。不发 `task_interrupted`，也不设 `hold`。
- **等待审批时不生效**：审批卡片本身就能拒绝并附上说明，插话会紧接着送达。桌面端在有审批时把"立即送达"置灰（§5.4）。
- **子智能体不受影响**：中断是整棵树（subagent-design §12），`steer_now` 只结束根会话这一步。
- **实现**：每一轮从任务的取消令牌派生一个这一轮的子令牌，流式请求和工具执行改用它；`steer_now` 只取消这一轮的令牌。循环据此区分：任务令牌被取消时任务中断，只有这一轮的令牌被取消时继续下一轮。

### 3.4 停止与失败：交还

- **中断（不变）**：整棵树停下；排队输入按送达顺序放进 `task_interrupted.returned_input`，队列清空，设 `hold`。
- **失败（D-204，即 subagent-design §8.3）**：与中断一样交还，`task_failed` 增加 `returned_input`，不再丢弃，也不再发那条 warning。已经在边界送达的插话属于历史，重试时模型会看到。
- **不变量（D-205）**：队列只在任务运行时非空。入队只发生在任务运行中，任务的三种结局都会清空队列：完成时取一条开始下一个任务，失败和中断时交还。所以：
  - 不需要"暂停的队列"这种额外状态；
  - 常驻服务只在没有任务运行时替换（desktop-kernel-integration §6.4），这时队列必然为空；
  - 队列不写盘（Q-140）。

### 3.5 事件与顺序

| 事件 | 字段 | 何时 |
|---|---|---|
| `queue_changed`（新） | `queued: [QueuedInput]`，按送达顺序：插话在前，跟进在后 | 队列每次变化：入队、送达、撤回、换类别、交还 |
| `input_withdrawn`（新） | `id` | `withdraw` 成功 |
| `task_failed` | 新增 `returned_input: [UserMessage]` | 任务失败 |
| `message_completed` | 不变；排队输入送达时 `message_id` 就是它的 id | 送达 |

```rust
// crates/finx-protocol
pub struct QueuedInput {
    pub id: String,                // 送达后就是这条消息的 message_id
    pub mode: PromptMode,          // steer | follow_up
    pub message: UserMessage,      // 内容与发出时间
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<SkillUse>,     // 提及的 Skill，与 message_completed 相同
}
```

- **全量而不是增量**：队列很短，全量事件不怕漏收、不用对账，重新接入时与快照同一种形状，撤回、换类别也不用各发一种事件。subagent-design §8.1 计划的 `input_queued { input_id, mode }` 只覆盖入队，由它取代（D-202）。
- **一条输入离开队列时，原因由紧挨着的事件说明**：
  - 撤回：先 `input_withdrawn { id }`，再 `queue_changed`；
  - 送达：先 `queue_changed`，紧接着这条消息的 `message_completed`；
  - 交还：先 `queue_changed`（空），紧接着终止事件，内容在它的 `returned_input` 里。
- **事件都在同一把锁里发出**，seq 的顺序就是状态变化的顺序（总方案 §6.2）。
- 总方案 §8.3 第 6 条（任务之外的事件）补上 `queue_changed`：任务结束时取出下一条输入，发生在上一个任务的终止事件与下一个任务的 `task_started` 之间。

### 3.6 不变的部分

- **模型看到的内容**：插话和跟进写进历史就是普通的用户消息，不包任何说明，不加提示词（D-209）。
- **命令**：`/compact` 在任务运行中仍然只给 warning，不排队；`/context` 仍然立即回答（§5.6 说明桌面端怎么处理）。
- **子智能体**：`send_message` 仍是对子会话提交 `Op::Prompt { mode: steer }`；子会话也会发 `queue_changed`，暂不转发给根会话（Q-142）。
- **数量**：不限制排队的条数。

## 4. 协议

### 4.1 原生协议

全部是增量修改，`PROTOCOL_VERSION` 保持 2。

| 位置 | 变化 |
|---|---|
| Op | 新增 `withdraw`、`requeue`、`steer_now`（JSON 见下） |
| Event | 新增 `queue_changed`、`input_withdrawn`；`task_failed` 增加 `returned_input` |
| 快照 | `SessionSnapshot.queued: [QueuedInput]`（已有字段，QueuedInput 增加 `id`），为空时省略 |
| capabilities | `ServerCapabilities` 增加 `input_queue: bool`；桌面端把它列入 `required`，缺它的旧服务会被换掉（desktop-kernel-integration §6.4） |
| 会话镜像 | `queue_changed` 时整体替换镜像里的队列；终止事件时清空 |
| Schema | 重新导出 `crates/finx-protocol/schema.json`，TS 类型随之生成 |

```json
{"type":"withdraw","id":"3f9a01c2"}
{"type":"requeue","id":"3f9a01c2","mode":"steer"}
{"type":"steer_now"}
{"type":"queue_changed","queue":[{"id":"3f9a01c2","mode":"steer","message":{"content":[{"type":"text","text":"顺便把错误提示的颜色改成橙色"}],"ts":1793600000000}}]}
```

- `session/op` 照旧原样转交，服务层不做字段映射（协议方案 §6.4）。三个新 Op 的结果都通过事件体现，与 `set_model` 等一致。
- 服务层不像审批那样替这三个 Op 做预检：撤回与送达的先后只有内核能判断，预检省不掉内核那一步。

### 4.2 ACP

- **一期不变**：有任务时 `session/prompt` 仍返回 `prompt_in_progress`；插话送达时照旧发 `user_message_chunk`（协议方案 §7.5）；`queue_changed`、`input_withdrawn` 不投影。
- **草案落地后（Q-143）**，按下表投影，不需要新的内核概念：

| ACP（草案） | finx |
|---|---|
| `session/prompt` 带 `delivery: steer / queue` | `Op::Prompt { mode: steer / follow_up }` |
| 送达时回复 `messageId`，`user_message` 带同一个 id | 排队 id 就是 `message_id`（D-201） |
| 送达前 `$/cancel_request` 撤回 | `withdraw { id }`；`input_withdrawn` 时回复 −32800 |
| 能力 `prompt.delivery.{steer, queue}` | capabilities 的 `input_queue` |

- 草案里 `session/cancel` 之后等待中的插话会开始下一轮；finx 的中断交还排队输入。这一处的对应留到草案定稿再定（Q-143）。

## 5. 桌面端

原型：docs/desktop/input-queue-demo.html。会话页的部分照 app.css、composer.css 抄，新增的只有排队托盘一段和 `--tray` 色值。

### 5.1 原则

- **贴着输入框，不进对话**：没送达的消息还不是对话的一部分，模型也还没看到。所以它们放在输入框旁边，送达那一刻才进对话。
- **与输入框对齐，而不是另起一套**：托盘沿用输入框内部的网格，图标、文字都落在输入框已有的线上。
- **安静**：没有排队时不多一个像素；托盘比窗口暗一级，不用彩色，只用图标和一行灰字区分两类。
- **操作就近**：动作在每一行上，悬停才出现，与侧栏会话行的做法一致（`.srow.has-act`）。

### 5.2 位置与形态

- **位置**：`Dock` 的 `above` 里最后一个，紧挨输入框；关键提醒卡片与审批卡片在它上面。
- **形态**：与输入框同宽（754，两侧各比对话列多 12，与输入框相同）；上面两个角 `--r-xl`，与输入框一致；下沿伸到输入框下面 12 px，被输入框压住，像从输入框后面露出来的一格。输入框 `position:relative; z-index:1`，浮在托盘上面。
- **颜色**：新 token `--tray`，浅色 `#f4f4f7`，深色 `#19191c`。两套主题里都比窗口（`--win`）暗一级，像凹下去的一格，浮起的输入框因此更清楚；外圈 0.5 px `--pill-bd`。深色试过比窗口亮一级（`#232327`），与输入框（`#28282c`）几乎连成一块，分不出边界，没有采用。
- **网格**：内边距上 4、左右 6、下 16（其中 12 被输入框压住）。行高 30，圆角 `--r-md`。图标列 32 宽，与输入框的"+"同宽，图标中心落在"+"的中心线上；文字左边距 4，与输入框正文起点对齐。在原型里量过：图标中心 x 都是 45，文字起点 x 都是 69。
- **高度**：最多约 5.5 行（`max-height: 184px`），再多在托盘里滚动。

### 5.3 一行的内容

| 部分 | 插话 | 跟进 |
|---|---|---|
| 图标（`--l3`，15 px） | 新图标 `steer`：一条线拐进来 | 已有的 `clock` |
| 文字（14 px，`--l1`） | 第一行原话，超长省略；带附件时文字后跟回形针和个数 | 同左 |
| 右侧（12 px，`--l3`） | "下一步送达" | "完成后送达" |
| 悬停时右侧换成 | "立即送达"、编辑、删除 | "改成插话"、编辑、删除 |

- 文字用 `--l1`：这是用户自己的话，属于主要信息；送达时机属于次要信息，用 `--l3`。
- 动作：主动作是文字按钮（24 高，12.5 px，`--l1`，悬停底色 `--fill2`）；编辑、删除是 24 的图标按钮（`--l2`，悬停 `--l1`），最右一个与发送按钮的中线对齐。
- 键盘：Tab 进入一行时，动作与悬停时一样显示（`:focus-within`）。

### 5.4 三档时机与动作

```
跟进（完成后送达） ──改成插话──▶ 插话（下一步送达） ──立即送达──▶ 结束当前这一步，马上送达
```

| 动作 | 在哪 | 做什么 | 内核 |
|---|---|---|---|
| ↩ | 任务运行中的输入框 | 发一条插话 | `prompt`（steer） |
| ⌥↩ | 同上 | 发一条跟进 | `prompt`（follow_up） |
| 改成插话 | 跟进行 | 这一行滑到插话的末尾 | `requeue { id, steer }` |
| 立即送达 | 插话行 | 结束当前这一步；有审批在等时置灰，提示"先回答审批" | `steer_now` |
| 编辑 | 每一行；或在空输入框里按 ↑，取最后一条 | 撤回，原话和附件放回输入框，光标在末尾 | `withdraw { id }` |
| 删除 | 每一行 | 撤回并丢弃；提示条"已删除一条排队的消息"带"撤销"，撤销即按原类别重新发出，排到末尾 | `withdraw { id }` |
| 停止（⌘. 或红色按钮） | 输入框 | 不变：整棵树停下，排队的消息放回输入框 | `interrupt` |

- **编辑是撤回到输入框，不在托盘里原地改（D-212）**：原地改的过程中，这一条可能已经在边界送达，改完的内容就落空了；撤回是原子的。代价是改完重发会排到末尾，与 ACP 草案的做法一致。
- **撤回失败**：如果在点下去之前这一条已经送达，客户端会先收到它的 `message_completed`。这时托盘里已经没有这一行，提示"这条刚刚已经送达"，不往输入框里放东西。
- **不做拖动排序**（Q-141）：同一类里调整先后的需求少，"改成插话"已经覆盖了最常见的插队。

### 5.5 动效

- **托盘出现、收起**：从输入框后面升起（下方 14 px、透明 → 原位，0.3 s，`--ease-out`）；最后一行离开后按相反方向收回去。
- **一行进、出**：高度 0 ↔ 30，同时淡入淡出，0.22 s。
- **改成插话**：这一行从原位滑到新位置（FLIP），不闪。
- **送达**：这一行收起的同时，对话里出现这条消息，从下方 16 px 升起（0.42 s）。动作方向始终向上：输入框 → 托盘 → 对话。
- **减少动态效果**：`prefers-reduced-motion` 时全部改为直接出现。

### 5.6 交还与合并

- **交还的来源**：停止（`task_interrupted.returned_input`）、失败（`task_failed.returned_input`）、编辑（自己发起的 `withdraw`，收到 `input_withdrawn` 时取托盘里的那一行）。
- **附件一起回来**：新增 `fromInput(content)`，是 `toInput` 的逆过程：文字、图片、附加的文件和文件夹都还原成输入框里的样子。
- **与草稿合并（D-213）**：交还的内容按送达顺序排在前面，空一行，后面接着原有的草稿；附件按路径去重后合并。不再因为输入框里有字就丢掉。
- **提示**：停止、失败时提示"排队的 N 条消息已放回输入框"。编辑不提示，光标直接到输入框里。
- **命令**：任务运行中输入 `/compact` 时，发送按钮不可用，占位处说明"任务结束后才能压缩"，草稿留在输入框里，不会发出后被内核丢掉。

### 5.7 文案

| 键 | 中文 | English |
|---|---|---|
| `composer.steer` | 不改："插话：任务下一步时就交给它（⌥↩ 改为排队）"；开关和 `composer.follow_up` 等文案删掉 | 同左 |
| `queue.label` | 待送达的消息 | Messages waiting to be delivered |
| `queue.steer` / `queue.follow` | 插话 / 跟进 | Steer / Follow-up |
| `queue.next` / `queue.after` | 下一步送达 / 完成后送达 | Next step / After the task |
| `queue.now` | 立即送达 | Send now |
| `queue.nowTip` | 结束当前这一步，马上送达（正在运行的命令会被停下） | End the current step and deliver now (a running command is stopped) |
| `queue.nowApproval` | 先回答上面的审批 | Answer the approval first |
| `queue.promote` | 改成插话 | Steer instead |
| `queue.promoteTip` | 下一步就送达，不等任务完成 | Deliver at the next step, without waiting for the task |
| `queue.edit` | 编辑：放回输入框 | Edit (back to the composer) |
| `queue.delete` | 删除 | Delete |
| `queue.deleted` | 已删除一条排队的消息 | Queued message deleted |
| `queue.returned` | 排队的 {{count}} 条消息已放回输入框 | {{count}} queued messages are back in the composer |
| `queue.delivered` | 这条刚刚已经送达 | That message was just delivered |
| `queue.attachments` | {{count}} 个附件 | {{count}} attachments |

### 5.8 不做的

- 对话里的"排队中"占位气泡：送达前它还不是对话的一部分，放进对话会让人以为模型已经看到。
- 在已送达的消息上标"插话"：它在对话中的位置已经说明了一切，日志也不记 mode。
- 侧栏显示排队数（Q-144）、子智能体的队列（Q-142）。

## 6. 客户端库与模拟服务

- **`@finx/protocol`**：由 schema 重新生成。
- **`@finx/client` 的 `SessionView`**：
  - `queued: QueuedInput[]`（已有）改为来自快照的 `queued` 和 `queue_changed`；终止事件时清空；
  - `returned` 也接 `task_failed.returned_input`；
  - 记下最近一次 `input_withdrawn` 的 id，`Dock` 只在 id 是自己撤回的那一条时放回输入框。
- **模拟服务**（`packages/client/src/mock/server.ts`）：实现队列、三个 Op、失败交还，让网页预览和桌面端的端到端测试能演示整个流程。

## 7. 测试与验收

### 7.1 内核端到端（ScriptedApi）

1. 运行中入队：`queue_changed` 的 id、类别与顺序正确；插话送达时 `message_completed.message_id` 等于它的 id，紧接在把它移出的 `queue_changed` 之后。
2. 跟进在任务本来要结束时送达，同一个任务继续，一次一条。
3. 撤回：送达前撤回发出 `input_withdrawn` 和 `queue_changed`，之后不再送达；送达后撤回什么也不发生。
4. 换类别：跟进改成插话后在下一个边界送达；id 不变。
5. `steer_now`：长时间运行的命令被取消，结果为 `Cancelled by user.`，插话送达，同一个任务继续，没有 `task_interrupted`；正在工作的子智能体不受影响；没有插话时什么也不做；等审批时什么也不做。
6. 失败：`task_failed.returned_input` 按送达顺序给出，队列清空，没有 discarded warning。
7. 中断：行为不变。
8. 插话在压缩期间、等 MCP 就绪期间到达，赶上紧接着的那次请求。
9. 竞争：任务结束的同时连续提交输入（压测循环），任何时刻最多一个任务在运行。
10. 队列不为空时不发 `idle`（已有，补一例）。

### 7.2 服务层与协议

- 会话镜像：中途接入的快照带 `queued`，之后的事件与快照严格衔接；两个连接看到的队列一致。
- Schema 测试与 TS 类型生成测试（已有，更新）。

### 7.3 客户端与桌面端

- 客户端 reducer：快照、`queue_changed`、`input_withdrawn`、失败交还。
- `fromInput` 与 `toInput` 互逆（文字、图片、文件、文件夹）。
- 桌面端端到端（模拟服务）：发插话与跟进、托盘出现、编辑、删除与撤销、改成插话、立即送达、停止交还、失败交还。

### 7.4 真实模型验收

DeepSeek `deepseek-flash`，经 `finx serve` 与打包后的桌面端：

1. 让它跑一个较长的任务（例如跑测试并修复），运行中发一条插话、一条跟进。插话在下一步送达，跟进在完成前送达。
2. 在一条长命令运行时点"立即送达"，命令停下，模型马上回应插话并继续。
3. 断开模型网络制造失败，排队的跟进回到输入框；恢复后重试能接着做。

## 8. 实施计划

| 阶段 | 内容 | 预估 |
|---|---|---|
| 一 | 内核与协议：§3、§4.1，内核端到端用例，镜像与快照，schema | 1.5 天 |
| 二 | 客户端库、模拟服务、桌面端：§5、§6 | 1.5 天 |
| 三 | §7 的端到端与真实模型验收；回写总方案 §6.3、§6.4、§6.7、§8，协议方案 §3.3、§6.6，subagent-design §8.1、§11.1，desktop-design §5 | 0.5 天 |

代码落点：

| 位置 | 改动 |
|---|---|
| `crates/finx-protocol/src/op.rs`、`event.rs`、快照类型、`schema.json` | 新 Op、新事件、`QueuedInput.id`、`returned_input`、capability `input_queue` |
| `crates/finx-core/src/session.rs` | `Input.id`；发 `queue_changed`；撤回、换类别；每一轮的取消令牌 |
| `crates/finx-core/src/task.rs` | 入队分配 id；插话晚取；`steer_now`；失败交还；结束与开始同一临界区 |
| `crates/finx-core/src/kernel.rs` | 提交循环分发三个新 Op |
| `crates/finx-server/src/mirror.rs` | 镜像与快照的 `queued` 改为跟随 `queue_changed` |
| `packages/protocol`、`packages/client`（含 mock） | 类型、`SessionView.queue`、交还、模拟服务 |
| `apps/desktop/src/renderer/src/session/Queue.tsx`（新） | 排队托盘 |
| `session/Dock.tsx`、`composer/PromptEditor.tsx`、`composer/attachments.ts` | 挂托盘、↑ 编辑、交还合并、`fromInput` |
| `styles/tokens.css`、`styles/composer.css`、`icons.tsx`、`locales/*/session.json` | `--tray`、`.cq*`、`steer` 图标、文案 |

## 9. 决策与待定问题

### 9.1 决策

| 编号 | 决策 | 理由 | 位置 |
|---|---|---|---|
| D-200 | 排队输入只存在内核会话状态里；协议把它暴露出来；桌面端只渲染，不另存 | 送达时机由轮次边界决定，只有内核知道；多端、重连、关闭窗口后都一致；撤回与送达的先后只有内核能原子地判断 | §2 |
| D-201 | 排队输入在入队时分配 id，就是它送达后的 `message_id` | `message_completed` 不加字段；与 ACP 草案的 `messageId` 直接对应 | §3.1 |
| D-202 | `queue_changed` 带完整队列（按送达顺序），快照带 `queued`；取代 subagent-design §8.1 的 `input_queued` 与 `message_completed.input_id`，也取代 main 上已有的 `input_queued { message, mode }`（按时间戳对应送达） | 队列很短；全量不怕漏收，重连与快照同一种形状；撤回、换类别不用各发一种事件 | §3.5 |
| D-203 | 新 Op：`withdraw`、`requeue`、`steer_now`；撤回成功发 `input_withdrawn` | 覆盖编辑、删除、插队；结果都走事件，与现有 Op 一致 | §3.3 |
| D-204 | 失败与中断一样交还排队输入（`task_failed.returned_input`），不再丢弃 | 用户写的话不能因为网络或服务商的错误而消失；即 subagent-design §8.3 | §3.4 |
| D-205 | 队列只在任务运行时非空；不写盘，没有"暂停的队列" | 三种结局都清空队列；状态最少；常驻服务替换时队列必然为空 | §3.4 |
| D-206 | 插话在组装请求之前再取一次 | 等 MCP、压缩期间到达的插话不必再等一整步 | §3.2 |
| D-207 | 任务结束时取下一条输入与开始下一个任务在同一临界区完成 | 消掉可能同时运行两个任务的窗口 | §3.2 |
| D-208 | `steer_now` 只结束根会话的这一步，任务继续；没有插话或在等审批时不生效 | "立即"的意思是不等这一步做完，不是停下任务；不误伤正在回应插话的模型和子智能体 | §3.3 |
| D-209 | 不改模型看到的内容，不加提示词 | 插话就是用户在对话中途说的话，模型从位置就能理解 | §3.6 |
| D-210 | 停止的语义不变（整棵树停下、交还）；"立即送达"是单独的动作 | 停止必须是停止；想马上插话的人有直接的按钮 | §3.4、§5.4 |
| D-211 | 桌面端的排队托盘贴在输入框上方、与输入框同宽、从它后面露出；对齐输入框的网格；`--tray` 比窗口暗一级 | 消息还不是对话的一部分；与输入框一体又有层次；两套主题同一个逻辑 | §5.2 |
| D-212 | 编辑是撤回到输入框，不在托盘里原地改 | 原地改的过程中可能已经送达；撤回是原子的 | §5.4 |
| D-213 | 交还的内容连同附件放回输入框，排在草稿前面，不丢弃 | 输入不因停止、失败、编辑而丢失（G3） | §5.6 |
| D-214 | 三档时机，每行的主动作是"往前一档"：跟进 → 插话 → 立即 | 一个按钮就完成插队；不需要拖动 | §5.4 |

### 9.2 待定问题

| 编号 | 问题 | 倾向 |
|---|---|---|
| Q-140 | 排队输入要不要写盘，服务崩溃时不丢 | 暂不。队列只在任务运行时存在，常驻服务里关窗口不丢；崩溃时正在运行的任务本身也要重来 |
| Q-141 | 同一类里要不要拖动排序 | 暂不。"改成插话"覆盖了最常见的插队；有真实需求再加 `requeue` 的位置参数 |
| Q-142 | 子智能体的队列（父发给它、还没送达的消息）要不要在后台面板里显示 | 可以经 `agent_event` 转发 `queue_changed`，等面板有需要时再做 |
| Q-143 | ACP 的 prompt-delivery 草案定稿后怎么投影，特别是 `session/cancel` 时等待中的插话 | 草案定稿后按 §4.2 的表实现；cancel 的语义届时再定 |
| Q-144 | 侧栏的会话行要不要显示排队数 | 暂不；会话在运行中，点进去就能看到托盘 |
| Q-145 | `send_message` 的 `interrupt: true` 要不要改用 `steer_now` | 倾向改：子智能体不必中断再重启，驱动里交还再重发的逻辑可以去掉；行为变化要单独验证 |

## 10. 实现说明

### 10.1 状态（2026-11-02）

- 代码在分支 `feat/input-queue`（工作树 `.claude/worktrees/input-queue`），未提交，未合入 main。
- §3、§4.1 全部实现，包括 D-206（插话晚取）和 D-207（结束与开始在同一临界区）。§5、§6 实现，差异见 §10.2。
- 测试：
  - Rust 全工作区通过，其中内核端到端新增 8 例（§10.3）；
  - 客户端库与模拟服务 40 例通过；桌面端单元测试 60 例通过；
  - 桌面端端到端 `apps/desktop/e2e/send-modes.mjs`：真实的 finx 与 Electron，加一个本机的慢速模拟服务商，9 步全部通过：插话等候与送达、插话排在前、立即送达（插话在 1.5 秒内送达，任务没有中断）、↑ 编辑、删除、停止交还、失败交还。

### 10.2 与方案的差异

- **main 上已有一版**：浏览器控制三期（提交 7d47472）顺带加入了 `input_queued { message, mode }`、快照的 `queued`、输入框上方的排队卡片，以及任务运行时的"插话 / 排队"发送方式开关（↩ 按开关发，⌥↩ 反过来）。第一版在它上面改：
  - 事件换成带 id 的 `queue_changed`，字段名与快照沿用 `queued`；
  - 卡片换成托盘；
  - 发送方式开关删掉（2026-11-02 定）：任务运行中 ↩ 一律插话、⌥↩ 一律排队，由占位文字"插话：任务下一步时就交给它（⌥↩ 改为排队）"提醒；"排队"的叫法保留。
- **capability 是必需的**：桌面端只在版本号不同或缺少必需 capability 时换掉已在运行的服务。不加它，一个与已装应用同版本号的新包会连上旧内核，托盘永远不出现。所以 `input_queue` 列入桌面端的 `required`。
- **送达动画只做了一半**：托盘和行的出现有动效；对话里"消息从下方升起"没有做，要把刚送达的 id 传给对话行，留到下一版。
- **子会话的失败汇报**里列出没处理的消息（subagent-design §8.3 后半）没有做。
- **D-207 的测试**（`a_burst_of_input_goes_in_once_each_in_order`）检查的是一次只有一个任务、每条输入恰好送达一次、顺序不变。在旧代码上它也复现不出那个竞争，那个窗口只在锁释放到下一次加锁之间。这一处的修复靠结构保证，不靠测试。
- D-206 没有单独的测试。§7.4 的真实模型验收没有做。

### 10.3 测试清单

| 位置 | 用例 |
|---|---|
| `crates/finx-core/tests/kernel.rs` | `queued_input_joins_under_its_id_steering_first`、`withdrawn_input_never_joins`、`a_follow_up_made_steering_joins_at_the_next_turn`、`steer_now_ends_a_running_command_and_the_task_goes_on`、`steer_now_ends_a_reply_being_written`、`steer_now_without_steering_input_changes_nothing`、`a_failed_task_hands_waiting_input_back`、`a_burst_of_input_goes_in_once_each_in_order`；改写 `follow_up_runs_after_the_task_would_end` |
| `crates/finx-server/src/mirror.rs` | `the_queue_is_the_last_one_announced` |
| `packages/client/src/queue.test.ts` | 队列跟随 `queue_changed`、撤回、失败交还、快照 |
| `packages/client/src/mock/server.test.ts` | 插话与排队的送达顺序和 id；停止交还与撤回 |
| `apps/desktop/e2e/send-modes.mjs` | 真实 finx 与 Electron 上的 9 步 |

