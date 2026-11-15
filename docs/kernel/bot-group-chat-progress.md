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

## M2 边界修复 — `a52d081d`

- 席位工具改成白名单：`read`、`write`、`edit`、`doc_*`、`docx_*`、`deck_*`、`sheet_*`、`spatial_*`（不含 `spatial_script`）、`web_search`、`send_to_user`、`stay_silent`；名单只在 `group_guard::tool_allowed` 一处，`GroupGuard` 也按它拒绝。席位不再挂连接器、浏览器、MCP、子智能体工具。
- `GroupGuard` 对 `doc_*`/`docx_*`/`deck_*` 的 id 参数查对应文档库的真实路径，再按群文件夹判断；查不到拒绝。
- `@` 标记只增不减：`set_group_mentioned` 只把 false 置 true；`take_group_mentioned` 只在提醒或已回答后清除。补了“@ 之后又来一批没 @ 的，仍提醒”的测试。
- 技能目录：系统提示词清单里列出的技能目录，`read` 可读，`write`/其他工具被拒；有测试。
- 验收第 10 条补测：`read` 读私聊文件/AGENTS 绝对路径/群内符号链接均被拒；`doc_open`/`docx_read`/`deck_open`/`spatial_open` 读私聊文件均被拒（`GroupGuard` 单元测试按每个工具名验证）；文档 id 指向群外被拒（单元测试用 `GroupDocPaths` 的测试映射）。
- 文档：brief §4.3 改为工具白名单；design Q-416 写明这一期不挂连接器和浏览器，以后按保险丝 3 管。
- 验收：`cargo test -p finx-core --test group`（10 通过）、`cargo test -p finx-core --lib group_guard`（3 通过）、`cargo test -p finx-core --test group`、`cargo check -p finx-core --tests`（除既有 `tests/bot.rs` unused_mut 警告外无新警告）。
- 自己定的：`GroupDocPaths` 的测试映射只在 `#[cfg(test)]` 用；技能目录按“清单里 `model_invocable` 的 SKILL.md 的父目录”算；`tool_allowed` 用前缀匹配 `doc_`/`docx_`/`deck_`/`sheet_`/`spatial_`。

## M3 — `d4d5aa0a`（只有本地 Bot 的群）

- 服务层：`groups/send` 后为主人消息建立/复用每个“群 × 本地 Bot”的席位会话；按群成员档位投递。
  - `mentions` 档只收 @ 它的消息；`normal` 档主消息流静默 4 秒后送，最多从第一条起等 20 秒；`lazy` 档先按 4 秒（配置化留到 M4）。
  - 被 @ 的消息立即送；`@` 自动开话题；Bot 的 `send_to_user` 由 hub 转成群消息，再投给其他成员。
  - `group/activity`、`group/message`、`silence.jsonl`（显式/隐式、起止 seq、reason）。
- 席位会话：`ensure_group_seats` 串行创建，避免并发创建两个席位；席位 session id 写回 `group.json`；席位在群文件夹里运行，不加载 MCP/浏览器。
- `finx-mock` 增加群信件识别：收到 `<group_messages>` 时用 `send_to_user` 回一句，供 e2e 使用。
- 验收：`cargo test -p finx-cli --test e2e_groups`（4 通过：@ 立即回 + 自动话题、三人群只 @ 的那位回、mentions 档不收主消息流、normal 静默 4 秒后回）；`cargo test -p finx-core --test group`（10 通过）；`cargo test -p finx-core --lib group_guard`（3 通过）；`cargo test -p finx-server`、`cargo test -p finx-core --test bot` 通过。
- 自己定的：`normal` 的安静/最长等待先写成 4 秒/20 秒常量，M4 读 `[groups]`；`mentions` 档不按话题参与度投递（外部 Bot 的话题参与度在 M6 做）；`members_changed` 暂时每批都带；自动话题取“这一批里第一条主消息流且 @ 它的消息”；群消息事件发给所有 `groups/subscribe` 的连接，由客户端按 group_id 过滤。

## M4 — `cc4217f4`（保险丝 1）

- 新 `[groups]` 配置：`enabled`、`quiet_secs`、`max_wait_secs`、`lazy_secs`、`lazy_count`、`recent_count`、`summary_after`、`bot_per_minute`、`bot_run_without_owner`、`daily_tokens`、`daily_peer_calls`；默认值照 brief。
- 服务层：
  - 正常/懒档按配置计时；懒档攒到 `lazy_count` 立即发；
  - 每个 Bot 每分钟超过 `bot_per_minute` 条后，本分钟不再给它投递；
  - 主人最后一句话之后 Bot 们说满 `bot_run_without_owner` 条，整群停，写 system 行；主人说话恢复；
  - 席位会话 `TurnCompleted` 的 token 累加到 `fuse.tokens`，到 `daily_tokens` 整群停；`groups/update resume` 清停并给当天再一份额度（计数清零）；
  - `fuse.day` 换日清零；`groups/open` 的 `group.fuse`/`group.stopped` 已带出。
- 验收：`cargo test -p finx-cli --test e2e_groups`（7 通过，含：主人沉默 12 条停群并恢复、每日 token 停 + resume、每分钟上限、normal 静默、@ 立即/自动话题、mentions 档、三人群）。
- 自己定的：每分钟计数按 Bot 说出的条数算，超过后跳过后面的投递而不撤回已说的；`resume` 把 `fuse.tokens`/`peer_calls` 清零（再给一份）；`bot_run_without_owner` 默认 12；system 行文字为“群暂停了：…”；`daily_peer_calls` 的计数入口留给 M6。
