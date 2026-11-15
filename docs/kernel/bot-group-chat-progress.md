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
