# 群聊开发进度

按 brief 第 6 节记录。每条给提交号、做了什么、验收命令和结果、自己定的事。

## M2 — `e2662267`（席位会话、群信件和不说话）

- `SessionHeader.group`、`StartOptions.group`、席位会话的启动/恢复；席位工作目录是 `groups/<id>/files/`。
- `PromptProfile::Group` 和 `prompts/group.md`（英文初稿）；席位不加载 `AGENTS.md` 和项目指令。
- `MailKind::Group`、`GroupBatch`、`Kernel::deliver_group`；外部成员的属性/文字转义。
- `stay_silent`、`send_to_user` 的 `thread_on`/`reply_to`；群里拒绝 `question`；附件限制在群文件夹。
- `GroupGuard` 文件边界，T1 的 `GroupExternal` 落盘标记；席位不记 `ReplyNudge`、不报 `no_reply`，被 @ 提醒一次。
- 验收：`cargo test -p finx-core --test group`、`--test bot`、`--lib`、`-p finx-server`、`-p finx-protocol`、`cargo check --workspace --all-targets`、`cargo build --bin finx`、`pnpm typecheck`、`pnpm test` 全过（desktop 曾有一次 supervisor flake，复跑通过）。
- 自己定的：群邮件用群的 id/name 合成 `AgentRef`；`GroupBatch` 的 `while_thinking` 文案放在闭合标签之后；被 @ 提醒用 `GroupUnanswered` 条目；席位会话不挂 `bash`/`cua_*`。

## M2 边界修复 — `037d6457`

- 席位工具改成白名单：`read`、`write`、`edit`、`doc_*`、`docx_*`、`deck_*`、`sheet_*`、`spatial_*`（不含 `spatial_script`）、`web_search`、`send_to_user`、`stay_silent`；名单只在 `group_guard::tool_allowed` 一处，`GroupGuard` 也按它拒绝。席位不再挂连接器、浏览器、MCP、子智能体工具。
- `GroupGuard` 对 `doc_*`/`docx_*`/`deck_*` 的 id 参数查对应文档库的真实路径，再按群文件夹判断；查不到拒绝。
- `@` 标记只增不减：`set_group_mentioned` 只把 false 置 true；`take_group_mentioned` 只在提醒或已回答后清除。补了“@ 之后又来一批没 @ 的，仍提醒”的测试。
- 技能目录：系统提示词清单里列出的技能目录，`read` 可读，`write`/其他工具被拒；有测试。
- 验收第 10 条补测：`read` 读私聊文件/AGENTS 绝对路径/群内符号链接均被拒；`doc_open`/`docx_read`/`deck_open`/`spatial_open` 读私聊文件均被拒（`GroupGuard` 单元测试按每个工具名验证）；文档 id 指向群外被拒（单元测试用 `GroupDocPaths` 的测试映射）。
- 文档：brief §4.3 改为工具白名单；design Q-416 写明这一期不挂连接器和浏览器，以后按保险丝 3 管。
- 验收：`cargo test -p finx-core --test group`（10 通过）、`cargo test -p finx-core --lib group_guard`（3 通过）、`cargo test -p finx-core --test group`、`cargo check -p finx-core --tests`（除既有 `tests/bot.rs` unused_mut 警告外无新警告）。
- 自己定的：`GroupDocPaths` 的测试映射只在 `#[cfg(test)]` 用；技能目录按“清单里 `model_invocable` 的 SKILL.md 的父目录”算；`tool_allowed` 用前缀匹配 `doc_`/`docx_`/`deck_`/`sheet_`/`spatial_`。

## M3 — `c6c4efd9`（只有本地 Bot 的群）

- 服务层：`groups/send` 后为主人消息建立/复用每个“群 × 本地 Bot”的席位会话；按群成员档位投递。
  - `mentions` 档只收 @ 它的消息；`normal` 档主消息流静默 4 秒后送，最多从第一条起等 20 秒；`lazy` 档先按 4 秒（配置化留到 M4）。
  - 被 @ 的消息立即送；`@` 自动开话题；Bot 的 `send_to_user` 由 hub 转成群消息，再投给其他成员。
  - `group/activity`、`group/message`、`silence.jsonl`（显式/隐式、起止 seq、reason）。
- 席位会话：`ensure_group_seats` 串行创建，避免并发创建两个席位；席位 session id 写回 `group.json`；席位在群文件夹里运行，不加载 MCP/浏览器。
- `finx-mock` 增加群信件识别：收到 `<group_messages>` 时用 `send_to_user` 回一句，供 e2e 使用。
- 验收：`cargo test -p finx-cli --test e2e_groups`（4 通过：@ 立即回 + 自动话题、三人群只 @ 的那位回、mentions 档不收主消息流、normal 静默 4 秒后回）；`cargo test -p finx-core --test group`（10 通过）；`cargo test -p finx-core --lib group_guard`（3 通过）；`cargo test -p finx-server`、`cargo test -p finx-core --test bot` 通过。
- 自己定的：`normal` 的安静/最长等待先写成 4 秒/20 秒常量，M4 读 `[groups]`；`mentions` 档不按话题参与度投递（外部 Bot 的话题参与度在 M6 做）；`members_changed` 暂时每批都带；自动话题取“这一批里第一条主消息流且 @ 它的消息”；群消息事件发给所有 `groups/subscribe` 的连接，由客户端按 group_id 过滤。

## M4 — `8862bf3a`（保险丝 1）

- 新 `[groups]` 配置：`enabled`、`quiet_secs`、`max_wait_secs`、`lazy_secs`、`lazy_count`、`recent_count`、`summary_after`、`bot_per_minute`、`bot_run_without_owner`、`daily_tokens`、`daily_peer_calls`；默认值照 brief。
- 服务层：
  - 正常/懒档按配置计时；懒档攒到 `lazy_count` 立即发；
  - 每个 Bot 每分钟超过 `bot_per_minute` 条后，本分钟不再给它投递；
  - 主人最后一句话之后 Bot 们说满 `bot_run_without_owner` 条，整群停，写 system 行；主人说话恢复；
  - 席位会话 `TurnCompleted` 的 token 累加到 `fuse.tokens`，到 `daily_tokens` 整群停；`groups/update resume` 清停并给当天再一份额度（计数清零）；
  - `fuse.day` 换日清零；`groups/open` 的 `group.fuse`/`group.stopped` 已带出。
- 验收：`cargo test -p finx-cli --test e2e_groups`（7 通过，含：主人沉默 12 条停群并恢复、每日 token 停 + resume、每分钟上限、normal 静默、@ 立即/自动话题、mentions 档、三人群）。
- 自己定的：每分钟计数按 Bot 说出的条数算，超过后跳过后面的投递而不撤回已说的；`resume` 把 `fuse.tokens`/`peer_calls` 清零（再给一份）；`bot_run_without_owner` 默认 12；system 行文字为“群暂停了：…”；`daily_peer_calls` 的计数入口留给 M6。

## M5 — `82e1ec26`（桌面端群聊，只有本地 Bot）

- `packages/client`：`groups.ts` 补 `collageMembers`、`typingMention`、`insertMention`、`mentionChoices` 四个纯函数；`groups.test.ts` 补对应用例。协议未改。
- `store.tsx`：`Lists` 加 `groups`/`groupsLoaded`；订阅 `groups/subscribe`，处理 `groups/changed`、`group/message`、`group/activity`（thinking 由 activity 维护，`groups/changed` 里不清空）；`Selection` 加 `{ kind: "group"; id }`，加 `selectGroup`；保存/恢复 `lastGroup`；加 `groupSheet`、`groupPanel`、`groupThread` 状态。切换模式时群和 Bot 互相保留。
- 侧栏 / `bots/BotList.tsx`：群和 Bot 同一个列表，按置顶、最近活动排序；群行头像是成员头像拼图（最多 4 个），有外部成员带地球标记；未读、置顶、最近消息/正在想/暂停三态；`Sidebar` 在“添加 Bot”旁加“新建群”，列表标题改为“Bot 和群”。
- `groups/GroupSheet.tsx`：起名、勾现有本地 Bot、群说明（可空）；不列外部 Bot（确认页留 M7）。
- `groups/GroupPage.tsx`：主消息流，每条发送者头像/名字，外部 Bot 带标记；system 行居中灰字；顶栏群名、成员拼图、设置按钮；`groups/read` 已读；`group/activity` 的“X 正在想…”；保险丝停止行 + “继续”（`groups/update { resume: true }`）；话题第一条下“N 条回复 · 最后一条时间”，点开右侧面板，面板有自己的输入框并发 `thread`；悬停“在话题中回复”“引用”，引用卡显示原文、点了滚回原消息并闪一下；`@` 弹成员列表，选中插入 `@名字`；发送支持 `thread`/`reply_to`。
- `groups/GroupPanel.tsx`：改名、群说明、置顶、每个成员的接收档位、添加/移出成员、删除群；外部成员暂时只显示标记和说明。
- 文案：新增 `apps/desktop/src/locales/{zh-CN,en}/groups.json`，并在 `shared/i18n.ts` 注册 `groups` 命名空间。样式追加到 `styles/bots.css`，复用 Bot 的列表行、气泡、面板和确认卡视觉。
- M7 预留：`GroupPage` 监听 `group/approval`，在输入框上方弹卡，写 cause 的 `name`/`text`，只提供“允许这一次”和“拒绝”；答复走 `session/resume` → `session/op`（approval）→ `session/detach`。
- 验收：
  - `pnpm typecheck`：通过（protocol / client / desktop 全部）。
  - `pnpm test`：通过（client 149、desktop 274，布局/单元测试全过）。
  - `node apps/desktop/e2e/bot-group.mjs`：通过；连续跑 3 次都过（真实 `finx serve` + 脚本化 OpenAI 兼容本地模型 + 临时 HOME）。
  - 截图：`docs/kernel/bot-group-chat-shots/` 的 `create.png`、`chat.png`、`mention.png`、`thread.png`、`quote.png`、`typing.png`、`fuse.png`、`settings.png`。
  - Rust 未改：确认已有 `target/debug/finx`（`finx 0.2.0`）可用，未重新 `cargo build`（同分支上 M6 正在改 crates）。
- 自己定的：M5 的建群表单只列本地 Bot，外部 Bot 的确认页和入群前记录设置留给 M7；话题面板直接用页面已加载的群消息和 `group/message` 事件渲染，不额外调 `groups/thread`（更早的话题分页以后接）；群设置多一个置顶开关；群里收到的文件只显示文件名，不做打开/预览（M5 范围外）；保险丝“继续”不再额外弹 toast。

## M6 — `25d3dfde`（外部 Bot 进群）

- `crates/finx-server/src/group_peers.rs`：外部成员不开席位会话，服务层直接走 A2A。
  - 每个成员、每个流（`main` 或话题第一条 id）一个 contextId + `sent_seq`；只发 `sent_seq` 之后、属于该流、不是它自己的消息；成功接到任务后才推进 `sent_seq`。
  - 投递时机照 brief §4.7：@ / 它参与的话题立即；`normal` 安静 `quiet_secs`、从第一条起最多 `max_wait_secs`；`lazy` 到 `lazy_secs` 或 `lazy_count` 条；正在回上一批时进 pending，结束再发，不并发。
  - 它只收自己参与的话题（说过话、被 @、话题由 @ 它的消息开）。
  - 批次是一个 A2A Message：声明扩展时多个 text part、part 的 `metadata.speaker`、Message 的 `group`/`seq`/`mentioned`/`members`；降级时一个 text part，每行 `【名字】内容`，首批带英文成员说明。
  - 外部回复：每个 `Said` 写成群消息；文件按通讯录 §5.3 落 `groups/<id>/files/`（只取最后一段文件名、清洗、50 MB 上限）；`Asked` 写成普通消息并把 taskId 留给下一批；失败/验证/断线写 system 行，不重试，连续 3 次暂停这个成员的投递。
  - `PASS`（trim、大小写不敏感）和正常结束没内容都算不说话，写 `silence.jsonl`，不进群消息。
- stateless：`groups/create` / `groups/add_member` 现在是 async，加外部成员时用新 context 跑 KIWI 两问探测；回答含 `KIWI` 才算有状态，失败/超时按无状态。`groups/set_member` 的 `stateless` 手动改会生效；无状态成员每批带摘要 + 最近 `recent_count` 条 + 新消息，不带 contextId。
- 入群前记录：`none` 不发旧消息/摘要；`summary` 只带摘要；`recent` 带摘要 + 最近 `recent_count` 条原文；拉进话题时带话题第一条 + 话题内最近 `recent_count` 条。
- 滚动摘要：`crates/finx-server/src/prompts/group_summary.md`（英文、按话题、≤400 词），用主人默认模型（`Server::session_model` / `finx_llm`），在 `summary_after` 条之后异步把除最近 `recent_count` 条以外的部分并进摘要；没有默认模型时降级为只发最近窗口。没有外部成员的群不算摘要。
- `crates/finx-a2a`：新增 `GroupMessage { id, parts, metadata, extension }` / `GroupPart` / `Client::send_group`，复用现有连接、凭证、SSE、大小上限、内网判断、超时和重连；直接聊的路径不变。名片解析出 `capabilities.extensions`，`bot.json` 的 source 增量记下（`extensions`，带默认值），供群聊判断是否声明扩展。
- `tools/a2a-fake`：`--group-ext`（名片声明扩展，按 speaker 回 `heard N messages from A, B`，首条 `silent` 回 `metadata.silent`，`file`/`file2` 仍回文件）、`--stateless`（不记 context）、降级时 `PASS`、`GET /requests`；写进 README 和 `tests.mjs`。
- 验收命令与结果：
  - `node tools/a2a-fake/tests.mjs`：`all checks passed`。
  - `cargo test -p finx-a2a -p finx-server`：通过（a2a 36 个 lib 测试，server 83 个 lib 测试和既有集成测试）。
  - `cargo test -p finx-cli --test e2e_groups_external`：4 通过（增量/一成员一批、contextId 与话题、stateless 探测与手改、扩展/降级/PASS/silent、入群前 none/summary/recent、文件说明与外部文件落盘）。
  - `cargo test -p finx-cli --test e2e_groups`：7 通过；`--test e2e_bot_external`：5 通过。
  - `cargo check --workspace --all-targets`、`cargo build --bin finx`：通过（只有 `crates/finx-core/tests/bot.rs` 既有的 `unused_mut` 警告）。
- 自己定的：
  - 外部成员的 quiet 计时在“安静期后没有新消息”就发，不会因为 pending 本身非空而一直等到 `max_wait_secs` 之后；本地成员的 M3 计时未改。
  - 话题首批按“话题第一条 + 最近 `recent_count` 条回复”截断；话题里更早的回复以后也不补发。
  - 降级 `PASS` 只认整条回复等于 `PASS`（或 `【名字】PASS` 这种单行）；扩展模式以 `metadata.silent` / 没有内容为不说话。
  - 外部成员的 `taskId` 只记在服务内存里，重启后不续（等待中的任务恢复留给后续）；`contextId` 和 `sent_seq` 落 `group.json`。
  - 滚动摘要在“群里有外部成员”时才计算；加外部成员时会同步补算一次，避免 `summary`/`recent` 的首批没有摘要可用。
  - 外部文件名的清洗先取路径最后一段再清洗，和直接聊的落盘规则一致。
- 仍未做：外部成员等待中的 A2A 任务在服务重启后的补查/续接；M7 的确认页、外部标记和保险丝 3 界面（由别人做）。


## M7 — `f47cda9e`（保险丝 2、3 和外部 Bot 的界面）

- 保险丝 2：群里第一次有外部成员时写一条 system 行（“群里有外部成员了：…，群里的消息会发到他们的服务”），只写一次；system 行不进外部成员的批次（外部成员只看群里的消息，不看本机的提示行）。
- 保险丝 3：`GroupGuard` 在 `SessionView.tainted` 为真时，除 `send_to_user`、`stay_silent`、只读且不联网的本地工具外，所有调用返回 `Gate::Ask`，不看权限模式；`web_search` 这类只读联网工具也问。确认卡只给“允许这一次/拒绝”（`Gate::Ask` 没有 session 级建议）。
- T1 污染标记：`GroupExternal` 条目落盘；重启从历史恢复 `group_tainted`。`note_group_batch` 记下当前批的 cause：直接由外部消息引起（`direct`，名字、message id、前 200 字），或此前有外部消息（`earlier`）。
- 审批转群聊页：席位会话的 `ApprovalRequested` 由 hub 发 `group/approval`（含 `group_id/bot_id/session_id/call_id/args/summary/cause`）；桌面端 `GroupPage` 弹卡，答复走 `session/resume` → 现有 `session/op` approval → `session/detach`。
- 外部界面：`GroupSheet` 在 `bots.external` 打开时列外部 Bot，逐行写域名，选“入群前不给看/给看摘要/给看最近 20 条”（默认不给看），建群时带 `history`；`GroupPanel` 显示外部成员的域名、提供“记不记得上下文”开关、添加外部成员前确认域名；`bots.external` 关闭时列表里没有外部 Bot。`GroupMember` 加 `stateless`（协议新增字段），`GroupSummary` 带出。
- 测试：
  - `cargo test -p finx-core --test group`：11 通过（含 T1 后写文件要确认、拒绝后不写）。
  - `cargo test -p finx-core --lib group_guard`：5 通过（路径/id/白名单/联网读/写）。
  - `cargo test -p finx-cli --test e2e_groups_external`：5 通过（含外部恶意文字触发本地 Bot 写文件，`group/approval` cause 为 direct，拒绝后没有 `pwned.txt`；第一条外部成员 system 行）。
  - `cargo test -p finx-cli --test e2e_groups`：7 通过；`cargo test -p finx-a2a -p finx-server`、`node tools/a2a-fake/tests.mjs` 通过。
  - `pnpm typecheck`、`pnpm test`（client 149、desktop 274）通过；`node apps/desktop/e2e/bot-group.mjs` 通过。
  - `cargo check --workspace --all-targets`、`cargo build --bin finx` 通过（只有既有 `tests/bot.rs` unused_mut 和 linker 提示）。
- 自己定的：外部成员不接触 system 行（本机提示行只给主人和本地 Bot）；T1 的 cause 在重启后没有原文时用“此前群里有外部消息”兜底；`GroupPanel` 添加外部成员用原生 `confirm` 写域名，入群前记录固定“不给看”，要改记录在群设置里重加；`GroupMember.stateless` 是新增字段，不改已有字段；第一条外部 system 行占一个群 `seq`，外部批次按“排除 system 行”处理。


## 复查修复（2026-11-15）

- `897353dd Groups: check document ids before asking (boundary fix)`：`GroupGuard` 的文档 id 真实路径检查移到保险丝 3 的 `Gate::Ask` 之前；被外部内容触发时用文档 id 改群外文档直接 `Deny`，不再先弹卡。补 `a_tainted_seat_still_refuses_a_document_id_outside_the_group` 单元测试。
- `140e8411 Desktop: confirm external members in group settings`：群设置添加外部成员不再用 `window.confirm`，改为和建群共用的确认页（域名、入群前 `none/summary/recent`，默认 `none`）。
- `2d1c0ce2 Groups: speak to the owner as you in pause lines`：暂停说明改成“你”，并说明在提示条上点“继续”，不再写“主人”“群设置里点”。
- `ce2fde4a Groups: resume external tasks and cover approvals after restart`：
  - `PeerFile` 落盘 `task_id`/`task_stream`；A2A `Thread` 事件一到就保存，不再等整批结束；服务启动时 `resume_external_tasks` 用 `Client::resume` 补查，结果照常写回群，失败写 system 行。
  - e2e：`a2a-fake` 的 `drop` 场景，中途重启服务，结果仍进群；外部恶意文字触发本地 Bot 的 `web_search`，`group/approval` 弹卡（被外部触发，`A2A Fake`）；拒绝后没有 `pwned.txt`；重启后同样的写文件仍弹卡，且 cause 为 `earlier`、文字含“此前群里有外部消息”。
  - `tools/a2a-fake --evil` 与群批次里的 `drop` 触发；`finx-mock` 在群信件里遇到 `pwned.txt` 时先调 `web_search` 再 `write`。
- `d8be0276 Groups: open group files and show external stateless`：`GroupSummary` 增加 `files_dir`，群消息里的文件可点开（按 DD-185 只对群文件夹里的文件生成的标签）；`GroupMember` 增加 `stateless`，群设置里显示外部成员的“记不记得上下文”。
- 已知覆盖：桌面端外部确认页和保险丝 3 确认卡的**桌面 e2e/截图**仍未做（功能已实现，Rust e2e 覆盖服务和审批事件）；这一期不做话题更早回复的分页，记入方案 v0.2 的“以后做”。
