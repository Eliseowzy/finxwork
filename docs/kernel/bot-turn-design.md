# finx Bot 回合与插话改进方案

| 项 | 内容 |
|---|---|
| 版本 | v0.9 |
| 日期 | 2026-11-05 |
| 状态 | 已实现（分支 `feat/bot-turn`）；实施结果和与原方案的出入见 §13，主人已确认这些出入 |
| 关系 | 确认后改 [bot-design.md](bot-design.md) 的 §3、§11、附录 A，[PRD](../desktop/bot-mode-design.md) 的 §6.7、§6.9，以及 [子智能体方案](subagent-design.md) 的工具部分（§5.3 的两个工具是所有主会话共用的内核能力）。依赖子智能体方案 v2.3（子智能体的确认由主用户批准，在分支 `feat/subagent-approvals`） |

## 方案摘要

- **一句话**：Bot 的主会话只负责接话和转告，要花时间的活交给后台子智能体。主人的话在下一个边界直接追加进上下文，不打断任何东西。
- **不做打断**：原来 PRD 里的"顶掉"不做了。活都在后台，主会话的每一步都很短，主人的话很快就能进去；`send_to_user` 总是完整发出。
- **要改的有六处**（第 6 处是实施时统计逼出来的，见 §13）：
  1. Bot 的 `spawn_agent`、`send_message` 去掉 `wait`。这是现在挡住主会话的最大原因：真实统计里 Bot 16 遍有 16 遍都在干等子智能体。
  2. 重写 `bot.md` 的回合规则（§7）。现在每条规则只有一句话，范围、例外、措辞都没写死，模型有很多空子可钻：逐条对照见 §7.1。
  3. 任务结束前查一次"结果发出去了没有"。现在先发一句"在弄了"就算回过话，后面写成普通文字的结果主人收不到。
  4. 让已有的 Bot 拿到新提示词。系统提示词是冻结的，不处理的话，默认的 FinxBot 永远用旧规则。
  5. 内核给所有主会话（会话模式和 Bot）加两个按需加载的工具：`list_agents` 查子智能体的状态和近期操作，`stop_agents` 中止正在运行的子智能体（§5.3）。
  6. 主人的每句话后面跟一句很短的提示（bot-design §3.14）。只靠系统提示词，模型的第一条回复多半写成普通文字。
- **复用**：子智能体、汇报唤醒、插话队列、授权窗口、按需加载都是现成的。不加新的协议，桌面端基本不用改。

## 1. 现状核对

对照了一份成熟产品的公开提示词和它的实际表现（一万字的活在后台写，同时可以一直聊），逐条核对 finx 现在的情况：

| 要点 | finx 现在 | 差距 |
|---|---|---|
| 马上回应 | 只有一句话："第一个调用是 `send_to_user`，先回答或者说一句在做什么"。第一个调用是发消息的比例：连发 12/12，一快两慢 9 到 11/12，短问题 24/36，寒暄 30/36，没发的靠提醒补救 | 差得多：范围、先于思考、再快的工具也不行、确认怎么说、什么不算回应都没写。逐条见 §7.1 |
| 鼓励交给后台 | 只有 `spawn_agent` 描述里一句"多步骤的独立工作交出去"，`bot.md` 没提。中等的活 36 遍全是 Bot 自己做 | 要写。以前不写是因为子智能体不能要确认，这一点 v2.3 解决了 |
| 后台不挡主会话 | `spawn_agent` 有 `wait` 参数，模型爱用。真实统计（Bot，询问权限，交代"做完告诉我结果"）16 遍里 16 遍都没有走汇报信，都是 `wait=true` 干等 | **最大的洞**，见 §5.1 |
| 插话不打断 | 已有。插话队列在轮次边界写入，`end_turn` 遇到插话会接着处理，`steer_now` 只有会话页的按钮会发 | 不用改 |
| 插话及时到达 | 有一个缺陷：同步等待开始之前就到的话，不会结束等待。真实走查里"1 公里是多少英里"发出后，等了近一分钟才被读到 | 见 §4.3 |
| 结果一定送达 | 提醒只看"主人最新一句之后发过没有"。先发一句"在弄了"，后面写成普通文字就结束，主人收不到：允许 2/8，拒绝 7/8 | 见 §6 |
| 子智能体要确认 | v2.3 已做：转给主用户，一次一个，不挡主会话 | 没有 |
| 停下 | `send_message` 带 `interrupt`，走查通过，但子智能体还要处理这条消息，再交一份汇报 | 提示词没说停下优先；没有确定的停止动作，也不知道停干净了没有 |
| 查进度 | 没有办法，工具描述让 Bot 直接说"还在做" | 活都在后台以后，主人会常问；不查就说"还在做"可能是假的，子智能体卡住也发现不了 |
| 已有的 Bot | 系统提示词冻结，新提示词进不去 | 见 §8 |

## 2. 目标

| 目标 | 怎么算达到 |
|---|---|
| 马上有回应 | 主人发出后的第一个气泡，不随任务变长而变慢 |
| 主会话一直能接话 | 后台在做时，新消息的回答延迟和没有后台任务时一样 |
| 不打断 | 主会话不取消任何生成和工具，`send_to_user` 总是完整发出 |
| 长活在后台 | 中等以上的活交给子智能体，短问题不交 |
| 每件事都有结果 | 主人等着的结果一定发出来；普通文字不算 |
| 说停就停 | "别做了"之后子智能体停下，Bot 说清楚停了什么 |

## 3. 一轮怎么过

以"写一篇一万字的小作文"为例：

```
主人  写一篇一万字的小作文，主题随便
Bot   send_to_user("好，一万字比较长，我写好整理成文件发给你。")     ← 第一个调用，先于别的
Bot   spawn_agent(...)                                             ← 立即返回，子智能体在后台写
Bot   结束这一轮
                                                    （子智能体在写：读资料、写文件）
主人  刚才给你发啥了你知道么
Bot   send_to_user("知道，你让我写一篇一万字的作文……", end_turn)     ← 新任务，马上回
主人  为什么你在写的时候我还能给你发消息
Bot   send_to_user(...)
                                                    （子智能体写完，汇报）
汇报  <agent_report> 唤醒 Bot，开一个新任务
Bot   send_to_user("写好了，一共一万零二百字：[作文](…)", end_turn)   ← 交付
```

- 主会话的上下文里只有对话和汇报，没有写作过程，所以这段永不结束的对话长得很慢，压缩也少。
- 子智能体要确认时弹授权窗口，写明是哪个子智能体；它等答复时主会话照常说话（子智能体方案 §10）。
- 主人要改要求（"写短点"），Bot 用 `send_message` 告诉同一个子智能体，它在下一步读到。

## 4. 插话

### 4.1 规则

主人的新消息就是一次追加：**等当前这一步结束，写进历史，下一次请求带上**。主会话不取消任何东西。

- 这正是现有的插话队列，内核不用改。
- 已经开始的 `send_to_user` 完整发出。气泡在调用开始时出现，不会只显示一半。
- 模型正在写的回答如果已经过时（主人刚说"算了"），它照样发出，Bot 下一步读到新消息再回应，和人聊天时刚好错过一样。活都在后台，这种回答都很短，错过的代价很小。

### 4.2 新消息到达时主会话在做什么

| 主会话此刻 | 处理 | 主人的话何时进去 |
|---|---|---|
| 空闲（包括子智能体在后台工作、在等确认） | 马上开一个任务 | 立刻 |
| 模型在生成 | 不取消 | 这一步结束后 |
| 工具在运行（包括 `send_to_user`） | 不打断 | 这批调用结束后 |
| 这一批里有 `end_turn` | 这一轮不结束，接着处理（已实现） | 这批调用结束后 |
| 在等主会话自己的确认 | 窗口留着 | 答复之后 |
| 在压缩上下文 | 不打断 | 压缩后的请求带上（已实现） |

### 4.3 什么会让边界来得慢

插话是否及时，取决于下一个边界多久到来。逐个处理：

| 情况 | 现在最长要等 | 怎么办 |
|---|---|---|
| `wait=true` 等子智能体 | 子智能体跑多久就等多久 | Bot 去掉 `wait`（§5.1） |
| 等待开始之前就到的话 | 同上。等待只看开始之后到的输入 | 修掉：开始等待时队列里已有插话，就不等了，汇报之后走信件。会话模式也受益 |
| 主会话自己跑长命令 | 默认 120 秒，最长 600 秒 | 提示词要求交出去（§7）。先不加内核限制，用统计看实际情况（§9） |
| 主会话自己写长文 | 一次生成的时间 | 同上 |
| 主会话自己的确认没人答 | 一直等 | 窗口就在输入框上方，可以马上答。默认完全访问，活又都在后台，这种情况会很少（§9） |
| 模型请求失败重试 | 按重试窗口 | 不变 |

### 4.4 为什么不打断

之前考虑过"模型生成时收到新消息就作废半截"。不做了，依据：

- 活在后台以后，主会话的生成都很短，作废省不了什么。
- 作废也会误伤：一句"顺便问一下"会让正在写的回答重来，已经付的钱白花。内核分不清是改主意还是顺便问。
- 不打断时状态最简单：`send_to_user` 要么没开始，要么完整发出，上下文只追加，缓存不受影响。

`steer_now` 留给会话页的"立即送达"按钮，Bot 不用。

## 5. 后台工作

### 5.1 Bot 的工具没有 `wait`

- Bot 主会话的 `spawn_agent`、`send_message` 不提供 `wait`，子智能体永远在后台。会话模式不变。
- 依据：`wait` 的说明写着"只有下一步需要汇报时才用"，但"做完告诉我结果"正好让模型觉得下一步需要。统计里 Bot 16/16、会话 21/24 遍都没有收到过汇报信，也就是都走了同步等待。对 Bot 来说，干脆拿掉最确定，也不用再加一句提示词。
- 汇报全部走信件：Bot 空闲时唤醒，正在回时在下一个边界送达。这些都是现成的。
- 实现：`agent_tools()` 给 Bot 另一组定义（参数里没有 `wait`，描述里说"结束这一轮，汇报会唤醒你"），内部仍调用 `AgentTree::spawn`，`wait` 固定为 false。模型照旧传了 `wait` 也会被忽略。

### 5.2 确认

子智能体要确认的调用弹授权窗口，等答复时不挡主会话（子智能体方案 §10）。这是长活能交出去的前提：以前询问权限下交出去多半做不成。

### 5.3 查进度和中止：所有主会话共用的能力

这两件事不是 Bot 特有的，会话模式的主智能体同样需要。所以它们放在内核的子智能体工具里，所有主会话都有，子智能体没有。

- **按需加载**：不进工具列表，和浏览器、电脑操控走同一条路。系统提示词的目录 `<deferred_tools>` 里多一组 `agents`，模型用 `tool_search` 取定义，用 `call_tool` 调用。
- **谁有这一组**：有子智能体树的会话，也就是主会话，并且没有关掉子智能体。子智能体没有树，自然没有这一组。设置变化重建目录时（`prepare_system`）同样判断。
- **`list_agents`**：可以点名，不点名就是全部。返回每个子智能体的标签、状态、跑了多久、近期操作、上次有动静是多久以前。数据来自智能体树已经转发的事件，不用问模型。用来诊断，不是用来轮询的。
- **`stop_agents`**：要么点名，要么明确写 `all: true`，不给默认值，免得一个空调用停掉全部。就是现有的 `agent_interrupt`：子智能体当场停在这一步，保留会话，之后可以用 `send_message` 继续，汇报不唤醒主会话。结果写明停了哪些、哪些早已结束。
- **不需要确认**：和 `spawn_agent`、`send_message` 一样，只管自己派出去的子智能体。
- **名字**：不叫 `agent_status`，协议里已经有同名的事件。
- `send_message` 的 `interrupt` 留着，用于改方向。

**代价**：

- 停下要多一步取定义，不如常驻直接。Bot 页没有停止键，说话是唯一的办法，所以要在统计里确认它可靠（§11）。
- 联网搜索默认开着，它同样按需加载，所以 `tool_search`、`call_tool` 本来就在工具列表里；只有关掉它的会话才因为这一组多这两个定义。
- 目录多一行，系统提示词变了。已有的会话恢复时写一条新的 `system_prompt` 条目（现有机制），缓存失效一次。

**Bot 和会话模式的差别只在提示词**：Bot 的 `bot.md` 写明什么时候查、停下优先（§7.2）。会话模式不加提示词，靠目录那一行和 `spawn_agent` 的描述。

### 5.4 汇报唤醒

汇报不是主人说的话：不用确认，也不当成主人的提问来回。主人等着的结果要发；过时或重复的可以不发。现在 `bot.md` 写的是"只发值得说的"，汇报全走信件以后，这句可能让结果被漏掉，要改（§7）。

### 5.5 只有主 Bot 跟主人说话

子智能体不能给主人发消息，它的话都经 Bot 转告。这一点现在已经成立，改动时要保持：

- **工具**：子智能体的工具列表在 Bot 加上 `send_to_user` 之前就定了，所以它没有这个工具，也没有 `spawn_agent`、`send_message`。§5.3 的两个工具也只有主会话有。测试 `a_bots_sub_agents_get_a_sessions_prompt_and_no_send_to_user` 守着这一条，新工具要加进去。
- **提示词**：子智能体用会话的提示词，不是 `bot.md`，任务说明告诉它回复交给派它的智能体。
- **主人看得到、但不算它在说话的**：
  - 授权窗口：只有子智能体要确认时才弹，写明是谁（子智能体方案 §10）。包括要主人去网页上操作一步的那种，这是唯一由它的模型写字、直接给主人看的地方。
  - 进度：气泡里的名字（§13.6）。
  - "过程"里的汇报卡片：主人主动展开才看到。
- **汇报不等于告诉了主人**：汇报只有主 Bot 看得到，转告是它的责任（§6）。

### 5.6 边界情况

- **子智能体看不到对话**：任务说明要写全。`spawn_agent` 描述已经写了。写不全的问题多了，再考虑带上对话前缀（bot-design §11）。
- **浏览器**：子智能体的标签页在它交差时关掉（D-206），所以要留给主人看的页面由 Bot 自己开。
- **文件**：子智能体和 Bot 工作目录相同，私有文件夹的写入豁免同样有效。
- **数量**：不设上限，由 Bot 决定。

## 6. 结果一定送达

### 6.1 问题

提醒（bot-design §3.11）从历史末尾往回找，碰到成功的 `send_to_user` 就算回过话。开场那句"在弄了"之后，结果写成普通文字就结束，不会触发提醒。

### 6.2 改法

任务要结束、这一步没有调用时，从末尾往回找，看先碰到什么：

| 先碰到 | 判断 | 处理 |
|---|---|---|
| 成功的 `send_to_user` | 该发的发了 | 正常结束 |
| 主人的话 | 没回话（现有规则） | 提醒一次，还不发就是 `no_reply` 失败 |
| 汇报信 | 汇报还没转告 | 提醒一次，还不发就正常结束 |
| 别的工具结果（不算 `spawn_agent`、`send_message`） | 干了活没交代 | 提醒一次，还不发就正常结束 |

- 交出去以后结束这一轮不会被提醒：往回找时跳过 `spawn_agent`，先碰到开场那句。
- 后两种可能真的没什么要说（过时的结果），所以还不发也不算失败。
- 这条提醒和没回话的提醒分开记（新条目 `undelivered`），文字不同：

```
<reply_reminder>
What you wrote stays private and has not reached the user. If they are waiting for any of it, call send_to_user with it now; otherwise end your turn without writing anything.
</reply_reminder>
```

- 每个任务最多提醒一次；主人的新消息写进历史时重新计算，"主人的下一句另算"（bot-design §3.11）。
- 和 main 的修复（bot-design D-400）合在一起以后：没回话的提醒排在排队的话之前，提醒的那次请求不带排队的话，因为连发时写成文字的第一句回答，会被后面发出的消息盖过去；结果没发的提醒排在排队的话之后，新消息来了就不用再催这件事。
- 代价：只在漏发或者确实没话说时多一次请求，前面的内容都在缓存里。

## 7. 提示词

### 7.1 逐条对照

参考的那段提示词细节很多，每一处都在堵一个模型会钻的空子。下面逐条看 finx 有没有，防的是什么。"新"指 §7.2 的新文本。

| 环节 | 细节 | 防的是什么 | finx 现在 | 新 |
|---|---|---|---|---|
| 回应 | 一轮的开始包括连发和工作中收到的消息 | 只在新任务时先回，工作中被问就埋头做 | 没写 | 有 |
| 回应 | 先于长时间思考 | 思考长的模型第一个气泡很慢；日志里常是先思考再发 | 没写 | 有 |
| 回应 | 先于所有工具，逐个点名：查询、命令、读文件、派子智能体都不例外 | "就查一下再回"。一快两慢有 1 到 3 遍第一个调用不是发消息 | 只有 before any other tool | 有 |
| 回应 | 同一步有多个调用时放第一个 | 气泡排在别的调用后面 | 没写 | 有 |
| 回应 | 能马上答就答，否则一句确认并点明第一步 | 空洞的"好的" | 只有"说一句在做什么" | 有 |
| 回应 | 说在做什么，不说不知道什么，带正反例子 | "我还不确定"这样的开场 | 没写 | 有 |
| 回应 | 不用没核实的答案填空 | 为了快先猜一个 | 没写 | 有 |
| 回应 | 界面上看得到的东西不算回应 | 以为主人看到进度就算回过了 | 没写 | 有（子智能体状态、文件） |
| 回应 | 答案到了先说答案 | | 有（How to talk） | 保留 |
| 工作 | 只在有意义的节点更新 | 播报 | 有 | 保留 |
| 工作 | 不播报重试 | 把内部的失败说给主人 | 没写 | 有 |
| 工作 | 不提唤醒、提醒，不提"发不发"的考虑 | 括号旁白，例如"（等秋天那首诗的报告。）"（decisions §5.5） | 只禁了工具名、消息 id | 有 |
| 收尾 | 开场的"在弄了"不算交付，私有文字里的草稿也不算 | 结果丢失 2/8、7/8 | 只有"发出每个结果" | 有 |
| 收尾 | `end_turn` 放在最后一条；发完就结束，不用再写 | 发完又写一段私有文字，多一次请求 | 只有参数说明 | 有 |
| 收尾 | 确认和进度不带 `end_turn` | 这一轮提前结束 | 只有参数说明 | 有 |
| 收尾 | 最后一条不和还要结果的调用并行 | 结果没读就结束 | 没写 | 有 |
| 收尾 | 子智能体还在做也可以结束这一轮 | 以为要等做完，这正是 `wait=true` 的诱因 | 没写 | 有 |
| 唤醒 | 不是主人说的话，不用确认，不当成主人的话回答 | 对着汇报说"好的" | 只有"不用确认" | 有 |
| 唤醒 | 过时、重复的可以不发，不写"(no change)"这种填充 | 没话找话 | 只有"只发值得说的" | 有 |
| 委派 | 不在自己的回合做重要工作；超过约两轮工具调用就交出去 | 中等的活 36 遍全是自己做 | 没写 | 有 |
| 委派 | 什么算重要工作，逐项列出 | 模型自己判断时偏向"这不算" | 只有工具描述一句 | 有 |
| 委派 | 交出去是为了腾出手，不是把一件事拆成几份；同一条线的后续归同一个子智能体 | 开一堆新的 | 工具描述提了后续 | 有，但范围比参考窄：只有紧接着同一件工作的才归原来那个，不相关的事各开一个（§13.6） |
| 委派 | 交出去以后接着做别的或结束，汇报会唤醒你，不空等不反复查 | 干等（16/16） | 只有工具描述 | 有 |
| 委派 | 查进度的时机：跑得久、被问到、说"还在做"之前；停滞了要如实说 | 假装还在做 | 工具描述让它直接说"还在做" | 有 |
| 停下 | 任何语言、任何措辞；优先于之前的一切 | 只认"停止"两个字 | 没写 | 有 |
| 停下 | 这是唯一排在开场那句之前的调用 | 先回一句，子智能体还在跑 | 没写 | 有 |
| 停下 | 不继续、不完成、不恢复、不重新派 | 嘴上说停，手上接着做 | 没写 | 有 |
| 停下 | 确认停了才说停了，可能还在跑的要说 | 谎报已停 | 没写 | 有 |
| 措辞 | 用第一人称说工作本身 | 主人看到"子智能体"这样的内部词 | 没写 | 有（§12） |

没有采用的：表情回应、语音、小部件、群聊、对等智能体和云智能体，finx 现在没有这些能力；子智能体数量的软上限，finx 不设上限；待办队列，见 §9。

### 7.2 新文本

替换 `bot.md` 的"How a turn works"，用我们自己的措辞和工具名。下面是统计以后定下的文字，和主人看过的第一版有几处不同（§13.2）：

```
How a turn works:
The user sees only what you send with send_to_user. Everything else you write stays private and
never reaches them.

1. Reply first. Whenever the user writes (one message, several in a row, or a message that lands
   while you are busy), your first call is send_to_user, before any long reasoning and before any
   other tool, however quick: no lookup, command, file read or new agent comes before it. Send it
   on its own, and make your other calls in the next step.
   - If you have the answer now, call send_to_user with it.
   - If not, call send_to_user with one short line that acknowledges the request and names your
     first step. Say what you are doing ("Pulling the March figures."), not what you don't know
     ("I'm not sure yet."), and never fill the gap with a guess.
   - Something the user can see of your work, such as an agent's status or a file, is not this
     reply.
   Once you have the answer, lead with it.

2. While you work. Send a short update only at a real turning point: a result, a decision, a
   blocker or a changed plan. No command-by-command commentary and no word about retries. Keep the
   machinery out of your messages: tool names, message ids, reminders, wake-ups, and whether you
   are deciding to send something.

3. Hand back. Before you end the turn, send every result someone is waiting for. "On it" delivers
   nothing, and neither does a draft in your private text. When your reply is complete, set
   end_turn on the last send_to_user: that send closes the turn, and nothing more is needed after
   it. Leave end_turn off acknowledgements and updates while you still have work to do, and don't
   make the last send alongside calls whose results you still need. Once your own part is done,
   you can end the turn while agents keep working.

Background wake-ups, such as an agent's report or message, are not the user writing: they need no
acknowledgement, and you never answer one as if the user had said it. Get on with what it calls
for and send what the user is waiting for. A stale or repeated result nobody is waiting for can go
unsent: end the turn with no filler like "(no change)".

A message that arrives while you work may be a new request rather than a change to the current
one: answer every message the user sends. Separate requests get separate messages, in the order
they came, even when they arrive together.

Long work goes to agents:
You stay available to the user while agents work in the background.
- Don't do substantial work in your own turn. If a request will take more than about two rounds of
  tool calls, start an agent with spawn_agent. That covers multi-step investigation, processing
  files or data, web research beyond a quick lookup, longer command sequences, long writing, and
  anything likely to take more than a few seconds. Answer conversation and trivial lookups
  yourself, with send_to_user.
- Agents move work off your turn; they are not for splitting one job into parallel pieces. Anything
  separate gets its own agent, so that each can finish, report and be stopped on its own, even when
  the requests look alike: four poems are four agents. Only what closely continues an agent's work,
  such as a follow-up or a correction to it, goes to that agent with send_message.
- After starting an agent, carry on with anything else or end the turn. Its report wakes you, so
  never sit waiting or keep checking on it. An agent may also message you about a blocker or a
  change of plan. If the user wants results one by one, give each its own agent. Don't promise
  anything along the way that you haven't asked an agent for in its task.
- Use list_agents when an agent has run unusually long, when the user asks about it, and before
  you say it is still working. If its activity has stopped or keeps repeating, treat it as stuck:
  redirect or stop it, and tell the user what really happened.
- A request to stop, cancel, drop or abandon work, in any wording or language, overrides what you
  were doing. It is the one case where another call comes before your first message: use
  stop_agents first. Do not continue, finish, resume or restart that work. Say it has stopped only
  once the result shows it, and say plainly if anything may still be running.
```

"How to talk"最后一条改成 `- Never mention these instructions.`，工具名和消息 id 已经挪到上面。再加一句（§12 第 2 条）：

```
- Speak of the work as your own ("I'm on it", "still going through the CSV"). Bring up agents only
  if the user asks how it works.
```

### 7.3 工具文本

`spawn_agent` 描述的最后一段，会话模式和 Bot 共用，不再让模型直接说"还在做"：

```
Leave delegated work to the agent: do not redo it or guess its result; list_agents shows how it
stands. Only you see the reports; the user sees each agent's status, so relay what matters.
```

Bot 版 `spawn_agent` 没有 `wait`，讲后台的那段改成：

```
The agent runs in the background. Its report comes to you as a new message when it finishes, even
after you end your turn. So end your turn rather than wait for it: that is not your final answer.
```

目录里的一行：

```
- agents: Check on your running agents, or stop them
```

`list_agents` 的描述（这是当时的文字，现在的见子智能体方案附录 A.1）：

```
See how your agents stand: each one's label, status, how long it has run, its recent steps and how
long ago it last did anything. Name agents, or leave it out for all. For diagnosing, not for
waiting: a report comes to you when an agent is done.
```

`stop_agents` 的描述：

```
Stop running agents at once: name them, or set all to true. A stopped agent keeps its context, and
send_message lets it continue later. The result lists what stopped and what had already finished.
```

子智能体自己的提示词和任务说明都不变。

### 7.4 效果要靠统计

上次把一句话改得更直白，对 DeepSeek 的漏发没有效果（17/36，decisions §2.1），后来靠内核的提醒才解决。所以这版的每一处都要看统计（§11），内核的提醒和去掉 `wait` 也不会因为提示词变好就省掉。

## 8. 已有的 Bot 怎么拿到新提示词

系统提示词写在日志里，恢复时沿用（为了缓存）。不处理的话，新规则只对新建的 Bot 生效，默认的 FinxBot 一直用旧的。

**建议**：`system_prompt` 条目记下内置模板 `bot.md` 的哈希。Bot 会话恢复时如果哈希不同，就用现在的模板重新生成，写一条新的 `system_prompt` 条目。

- 代价：每次升级提示词时缓存失效一次。升级要重启服务，缓存本来也快过期了。
- 恢复时写新条目的机制已经有了（工具列表变化时就这样做）。
- 老日志没有哈希，算作不同，第一次恢复时换一次。
- 技能和全局指令也会在这一刻刷新；平时的刷新（Q-200，压缩时换新）不在这个方案里，主会话变短以后压缩更少，那件事要另外考虑。

## 9. 没有采用，或者按需再加

那份提示词里有，这里先不做的：

| 项 | 为什么 | 什么情况下再看 |
|---|---|---|
| 待办队列（每次收到消息或汇报时核对） | 内核已经保证汇报会唤醒 Bot、结果没发会提醒，先不让模型多维护一份状态 | 统计或使用中发现有请求被忘掉 |
| 子智能体数量的软上限 | finx 不设上限 | 不做 |
| 完全不提内部机制（被问到也不说） | 界面上看得到后台任务和"子智能体"，也不该对主人回避。改成默认不提，问到照实说（§7.2） | 看你的决定 |

其他按需再加：

| 项 | 要解决的问题 | 什么情况下做 |
|---|---|---|
| `send_to_user` 一写完就发 | 开场那句和 `spawn_agent` 在同一步时，气泡要等任务说明写完才出现。提示词要求它单独一步以后，长活的第一个气泡中位数从 5.8 秒降到 3 秒（§13.3） | 统计里还是明显慢 |
| 第一步用低思考强度 | 思考长的模型第一个气泡慢，提示词管不住 | 统计里第一个气泡明显慢 |
| 主会话的长命令转后台 | 主会话自己跑长命令时，主人的话要等它结束 | 统计里这种情况常见 |
| 主会话连续调用工具时提醒交出去 | 模型不听"交出去"那句 | 统计里交出去的比例还是低 |
| 新消息算作没答复主会话的确认 | 主人不答窗口直接说话时，这句话要等 | 真实使用里遇到 |
| 一句话后等主人说完再回 | 第一句的回答看不到紧接着的第二句 | 回答因此显得不自然 |

要从现有文档里去掉的：PRD §6.9 的"二期：顶掉"，bot-design §11 的"顶掉还没发出的回复"。

## 10. 实施清单

先合并 `feat/subagent-approvals`：这个方案依赖它，而且主干又往前走了，越晚合冲突越多。

| 文件 | 改动 |
|---|---|
| `crates/finx-core/src/agents/tools.rs` | Bot 版的 `spawn_agent`、`send_message`（没有 `wait`）；所有主会话共用的 `list_agents`、`stop_agents` |
| `crates/finx-core/src/agents/mod.rs`、`driver.rs` | 开始等待时队列里已有插话就不等（§4.3）；记下每个子智能体最近几步和上次动静；停全部时列出结果 |
| `crates/finx-core/src/deferred.rs`、`kernel.rs`、`system.rs` | 有子智能体树的会话多一组 `agents`；启动、恢复和设置变化时都这样判断 |
| `crates/finx-core/src/kernel.rs` | Bot 用它自己那组智能体工具；恢复时比较模板哈希（§8） |
| `crates/finx-core/src/bot.rs`、`task.rs` | 结果没发出去的判断和提醒；主人的新消息写入时重新计算（§6） |
| `crates/finx-core/src/store/entry.rs`、`context.rs` | 新条目 `undelivered`；`system_prompt` 加模板哈希 |
| `crates/finx-core/src/prompts/bot.md` | §7.2 |
| `crates/finx-mock/src/lib.rs` | 汇报后只写文字的场景 |
| `crates/finx-core/tests/`、`finx-cli/tests/` | 列出工具名的测试：主会话多了 `tool_search`、`call_tool` |
| `tools/bench/bot_turns.mjs` | §11 的新场景和指标 |
| `apps/desktop/e2e/bot-mode.mjs` | 一万字这条时序的走查 |
| `docs/` | bot-design、PRD、decisions；子智能体方案（工具一节、D-41）；MCP 方案的工具顺序 |

桌面端、协议、服务层、ACP 都不用改。

## 11. 验证

**内核测试**：

- Bot 的工具列表里没有 `wait`；传了也走后台。
- 模型生成和工具运行时来的话不打断，在边界进上下文，气泡完整。
- 开始等待时队列里已有插话，等待马上结束（会话模式）。
- 提醒的四种情况（§6.2），交出去以后结束不提醒，每个任务一次，主人新消息后重新计算。
- 恢复时模板哈希不同就换提示词，相同就不写新条目。
- `stop_agents`：点名和 `all`，两个都没有时报错；结果写明停了什么、早已结束的；汇报不唤醒主会话；停下后 `send_message` 能接着做。
- `list_agents`：状态、近期操作、上次动静；经 `tool_search` 取定义、`call_tool` 调用。
- 会话模式和 Bot 的主会话目录里都有 `agents` 这一组；子智能体、关掉子智能体的会话没有；设置变化重建目录后还在。
- 子智能体的工具里没有 `send_to_user`，也调不到 `list_agents`、`stop_agents`，新建和恢复后都一样。

**真实模型统计**（`bot_turns.mjs`，每个场景 12 遍）：

| 场景 | 看什么 | 现在 | 目标 |
|---|---|---|---|
| 一万字：写一万字，2 秒和 5 秒后各问一句 | 第一个气泡的时间；两句追问的回答时间；交给子智能体；结果送达 | 没测过 | 第一个气泡不随任务变慢；追问的回答和平时一样快；12/12 交出去；12/12 送达 |
| 一快两慢（已有） | 交给子智能体；期间的回答 | 0/36 交出去 | 明显上升，短问题照常直接回 |
| 停下：写一万字，5 秒后"算了不用了"，再换说法"这个先别弄了"和英文 | 有没有先停再说，包括取定义这一步；停了没有；说了没有 | 没测过 | 12/12 先停再说，没有继续 |
| 问进度：写一万字，10 秒后"写到哪了" | 有没有先取定义再查 `list_agents`；说的和实际一致吗 | 没测过 | 12/12 查了再说，没有编造 |
| 改主意：写春天的诗，1 秒后"算了写秋天的" | 最后交付的是什么 | 没测过 | 最后一条是秋天的；中间多出的春天的诗算可以接受 |
| 询问权限下交出去，允许和拒绝各一组 | 结果丢失 | 2/8、7/8 | 0 |
| 短问题、寒暄（已有） | 第一个调用是发消息；提醒后才发；第一个气泡的时间；不交出去 | 24/36、30/36；提醒 5、6 次 | 明显上升，提醒减少 |
| 一快两慢的第一个调用（已有） | 第一个调用是发消息 | 9 到 11/12 | 12/12 |
| 连发四首诗（已有） | 不退步 | 12/12，46 到 49 条 | 不低于现在 |
| 会话模式：让子智能体做事，中途问进度、叫停 | 有没有用上这两个工具；不退步 | 没测过 | 问进度时查了，叫停时停了 |
| 看气泡内容 | 确认有没有点明第一步；括号旁白；提到内部词 | 旁白见过 3 次，没系统统计过 | 确认都点明第一步，没有旁白 |

**桌面端走查**：`bot-mode.mjs` 加一万字这条时序，再跑 `subagent-approval.mjs` 等现有脚本。

**需要的条件**：测试用的 DeepSeek Key 余额用完了（402），真实模型这部分要充值或者换一个 Key。

## 12. 主人定下的事

主人回复"按这版开工"，四条都按建议：

1. **开工顺序**：先合并 `feat/subagent-approvals`，再按 §10 做。
2. **怎么说自己的工作**：默认说"我在写"，不提子智能体，主人问到就照实说（§7.2 最后一句）。
3. **§7.2 的提示词全文**：按这版做；统计以后改了几处说法，条款没有少（§13.2）。
4. **已有 Bot 的提示词**：按 §8 用模板哈希。

## 13. 实施结果

§10 全部做了，另外多了一处（§13.3）。数字都来自 DeepSeek flash 和 `tools/bench/bot_turns.mjs`，别的模型没有测过。

### 13.1 第一版提示词比旧的还差

§7.2 的第一版条款齐全，统计却比旧提示词差。为了让每遍互不影响，这里每个 Bot 只问一个短问题：

| 提示词 | 遍数 | 第一个调用是发消息 | 提醒后才发 | 提醒后还是没发（`no_reply` 失败） |
|---|---|---|---|---|
| 旧 | 240 | 30% | 63% | 7% |
| §7.2 第一版 | 120 | 17% | 61% | 22% |

逐段拆开，先用只留规则的小提示词，再每次加回一段（每组 48 遍，小提示词 60 遍）：

| 提示词 | 第一个调用是发消息 |
|---|---|
| 小提示词 | 75% |
| 加"How to work" | 79% |
| 加数字和操作两节 | 75% |
| 加"Long work goes to agents" | 56% |
| 加能力清单 | 50% |
| 加"How to talk" | 31% |
| 加"How to talk"，小标题和用词改成在说 `send_to_user` 发的内容 | 65% |
| 短身份加旧回合规则 | 81% |
| 短身份加第一版回合规则 | 46% |
| 短身份加第一版回合规则，每条都说成调用 | 73% |

结论：提示词里讲"怎么回答"的文字都在把模型推向直接写字，抽象的说法（"only voice""a send_to_user""that message is the answer"）比"调用"差得多。这些段落的影响叠加起来，所以单改一段不够。

### 13.2 和第一版的出入

条款一条没少，只改说法。§7.2 已经是定稿：

- 开头用回平实的那句 "The user sees only what you send with send_to_user."。
- 第 1 条每个条款都说成调用："your first call is send_to_user"、"call send_to_user with it"。
- "If you make several calls in one step, it goes first." 改成 "Send it on its own, and make your other calls in the next step."。和 `spawn_agent` 同一步时，气泡要等任务说明写完：长活的第一个气泡中位数 5.8 秒，单独一步约 3 秒。这条和参考的那段提示词不同，是统计定的。
- "How to talk" 改成 "How to write what you send with send_to_user"，"Most replies" 改成 "Most messages"，"Talk like" 改成 "Write like"。
- "Handle only conversation and trivial lookups yourself." 改成 "Answer conversation and trivial lookups yourself, with send_to_user."；开头的 "your message gives the conclusion" 改成 "your send_to_user message gives the conclusion"。

只改这些，整份提示词也只到 37%，提醒后还是没发 7%。

### 13.3 多了一处：每句话后面跟一句提示

主人的每句话后面记一条 `reply_nudge`，上下文里是 `<reminder>Reply with send_to_user.</reminder>`（bot-design §3.14、D-356）。这是原方案没有的，主人看过数字后同意保留。依据：

| 做法（同样每个 Bot 一个短问题） | 第一个调用是发消息 | 第一个气泡 |
|---|---|---|
| 只改系统提示词，最好的一版（规则说三遍、举例子） | 约 50%，提醒后还是没发约 16% | 约 1.3 秒 |
| 定稿提示词加这句（24 遍） | 92% 到 96% | 约 1.1 秒 |

试过的另外两种写法（"The user sees only what you send with send_to_user."、"Reply by calling send_to_user."）都差一些。强制工具调用走不通：DeepSeek 默认开着思考，这时指定工具直接返回 400。

### 13.4 统计结果

每个场景 12 遍，另有说明的除外：

| 场景 | 看什么 | 之前 | 现在 | 目标 |
|---|---|---|---|---|
| 三个短问题 | 第一个调用是发消息；提醒；第一个气泡 | 24/36；提醒 5 到 8 次 | 34/36；提醒 0 次；约 1.2 秒 | 达到 |
| 寒暄 | 同上 | 30/36；提醒 6 次 | 35/36；提醒 1 次；约 1.1 秒 | 达到 |
| 连发四首诗 | 不退步 | 12/12，46 到 49 条 | 第一个调用 11/12，47 条；按顺序 9/12（判断方法是看每首最先提到的季节，有的诗先提别的季节，会误判） | 大致不退步 |
| 一快两慢 | 第一个调用；交出去；期间的回答 | 9 到 11/12；0/36 | 10/12；0/12；期间的问题中位数约 1 秒 | 回答达到，交出去没达到 |
| 叫停（三种说法） | 先停再说；停了；说了；重新开工 | 没测过 | 12/12；12/12；12/12；0 | 达到 |
| 问进度 | 查了再说；期间能答 | 没测过 | 9/12；12/12，中位数约 0.9 秒 | 没达到 12/12 |
| 改主意 | 最后交付的是秋天的诗 | 没测过 | 11/12，另一遍 `no_reply` 失败；10 遍春天的诗也发了 | 大致达到 |
| 询问权限，允许 | 结果丢失；交出去 | 2/8 丢失 | 0/12；12/12 | 达到 |
| 询问权限，拒绝 | 结果丢失；交出去 | 7/8 丢失 | 0/12（其中 6 遍靠新提醒发出）；12/12 | 达到 |
| 长活的第一个气泡（12 遍） | 中位数 | 同一步 5.8 秒 | 约 3 秒 | 改善 |
| 长活的整条时序（两千字，3 遍） | 交出去；送达 | 没测过 | 2/3（另一遍 Bot 自己 23 秒写完）；3/3 | 达到 |
| 会话模式（6 遍） | 问进度时查；叫停时停 | 没测过 | 6/6；6/6 | 达到 |
| 看气泡内容 | 括号旁白；工具名；主动提子智能体 | 旁白见过 3 次 | 都是 0（询问权限那两组主人自己说了"交给子智能体"，不算） | 达到 |

**桌面端走查**：`e2e/bot-mode.mjs` 用真实模型全部走通，新加的长活一步（两千字）：第一个气泡 1.3 秒，两句追问分别 0.8 秒、1.9 秒回答，子智能体一直在做，写好后文件发了出来。`e2e/bot-turn.mjs` 用 finx-mock 走同一条时序，加上查进度和叫停。

### 13.5 还没解决的

- **交出去以后常多发一句**：先回的那句单独一步以后，交出去时常再发一句"已经动笔了"，有时还有一句"写好就发你"。两种措辞（"with no further message"、"without another message"）都没有用，每次交接 2 条多。不影响功能，但有点啰嗦。
- **中等的活还是自己做**：写脚本跑数据（两轮左右的工具调用）12 遍都是 Bot 自己做的，期间的问题照常很快回。规则写的是"超过大约两轮"，这不算违规。
- **问进度**：12 遍有 3 遍没查就说"还在写"。
- **提醒后还是只写文字**：加了提示以后很少（短问题 72 个任务里 0 个，改主意 13 个任务里 1 个），但还会有，那时主人看到失败卡。主人同意先保持失败卡：这种情况已经很少，不值得为它改"只有 `send_to_user` 可见"（D-302、D-321）。真实使用里还常遇到，再看 bot-design §11 的办法。
- **费用**：一万字的整条时序每遍大约 1 元以上，所以整条时序只用两千字跑了 3 遍。

### 13.6 主人试用后又改的两处

主人用自己的模型连发四首"一万字的诗"，看到两个问题：

**气泡里出现了命令**。点开"它在忙"能看到 `pwd && ls -la`、`tool_search`。主人定下：气泡最多只写哪些子智能体在跑、叫什么。一件事时只有名字，没有什么可点的；几件事时写"正在处理四件事"，点开一行一个名字。命令、步骤和用时都不显示（bot-design D-358）。

**四首诗交给了同一个子智能体**。原因是 §7.2 第一版那句 "Keep a line of work with one agent: related requests, follow-ups and corrections go to it"。这句对照的是参考里的"相关任务、后续跟进和修正应归属同一个执行器"，模型把四首诗当成了相关任务。参考里紧接着还有一句，用户明确在多任务时可以多开；当时因为 finx 不设上限，把那句整个删了，这个例外也跟着没了。主人定下的规则比参考更明确：不相关的事独立开，只有高度相关的才在同一个子智能体里继续（bot-design D-357）。§7.2 已经是新文字。

**这条还没有统计**。改完时测试用的 Key 余额用完了（402）。`bot_turns.mjs` 加了四个场景，有余额时跑：

| 场景 | 内容 | 目标 |
|---|---|---|
| `fan` | 连发四首一万字的诗 | 四个子智能体 |
| `apart` | 一篇作文，加一份不相关的调研 | 两个子智能体 |
| `whole` | 一篇作文，分四章 | 一个子智能体，不拆 |
| `follow` | 一篇作文，开工后说"写短一点" | 一个子智能体，修正用 `send_message` 发给它 |

**接下来讨论**：子智能体要不要、怎么在中途往外通知。任务开独立以后，这件事的急迫性小了，但长期可能还是需要。这次日志里，子智能体被告知"每完成一首就用报告通知我"，于是去连接器里搜 "message parent agent"，Bot 也跟主人说了"每完成一首就先发给你"：现在的机制做不到，子智能体只有一轮做完才汇报。

### 13.7 接着做的：智能体之间的通信

§13.6 最后留下的中途通知，做成了 [智能体通信方案](agent-messaging-design.md)。`check_agents` 因此改名 `list_agents`，本方案里的名字都跟着改了；子智能体现在也有这个工具和 `send_message`，§5.3 里"子智能体调不到"的部分以那份方案为准。
