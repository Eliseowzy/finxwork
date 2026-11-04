# finx Skill 技术方案

| 项 | 内容 |
|---|---|
| 版本 | v1.6 |
| 日期 | 2026-10-31 |
| 状态 | 已定稿；一期、二期、2d（任意位置提及与桌面端输入框，§6.3）已实现，真实模型验收通过（§13.1–§13.3）；2e（技能来源收敛，§4.1、§4.4、§10，D-170–D-177）已实现，待提交（§13.4）；三期待实施 |
| 关系 | 扩展 technical-design.md（下称总方案）的 §7.2 系统提示词、§7.6 上下文压缩、§10 配置、§11.5 受保护路径；对外协议部分与 protocol-design.md（下称协议方案）衔接 |

## 方案摘要

- **是什么**：Skill 是一个目录，里面有一个 `SKILL.md`（YAML 头部加 Markdown 正文），还可以带脚本、说明文档和资源文件。格式遵循 Agent Skills 开放规范（agentskills.io）。
- **不加工具**：
  - 会话启动时扫描所有位置，把可用 Skill 的名字、描述和 SKILL.md 的路径写进系统提示词里的 `<available_skills>` 段。
  - 模型判断任务与某个 Skill 匹配时，用 read 读它的 SKILL.md，再按其中的指引读同目录的文件、用 bash 运行脚本。
- **从哪里加载**（2e，D-170–D-172）：项目里用共享标准，用户级只认 finx 自己的目录。
  - 项目层：从 cwd 到项目根的每一级目录，看 `.agents/skills`（默认启用）和 `.claude/skills`（列出，默认不启用）；不读项目里的 `.finx/skills`；主目录本身不算项目层。
  - 用户层：只读 `~/.finx/skills`（`FINX_HOME`）。`~/.agents/skills`、`~/.claude/skills` 是本机其他应用的目录，默认不读，由 `skills.other_apps` 打开。
  - 内置 Skill 和配置里列出的额外路径。
  - `.finx` 只放 finx 独有、没有共享标准的东西：项目配置 `.finx/config.toml` 和数据目录 `~/.finx`。
- **默认不启用的 Skill**（D-173、D-174）：在列表里、开关是关着的，不进清单，也不能提及；用户逐个打开，记在 `skills.opt_in`。它不参与同名先到先得。
- **同名时谁生效**：离当前工作越近越优先，先找到的生效。
  - 项目层优先于用户层，用户层优先于额外路径；
  - 项目层里，子目录优先于项目根；
  - 同一位置，`.agents` 优先于 `.claude`。
  - 被遮蔽的 Skill 不进清单，`finx skills` 里能看到。
- **清单放在哪**：
  - 系统提示词里，指令段之后、environment 之前，随系统提示词一起冻结；
  - 一句固定说明，每个 Skill 一行；
  - 没有可用的 Skill 时整段省略。
- **预算**：清单不超过上下文窗口的 2%，最多 10,000 token。超出时先统一截短描述，仍放不下再从优先级最低的开始整条去掉。
- **权限**：
  - 读 Skill 的文件不用审批；运行其中的脚本照常审批；
  - 写 Skill 目录属于受保护路径；
  - 项目层 Skill 与 AGENTS.md 一样，不受项目信任状态影响；
  - 不支持 `allowed-tools` 预先放行。
- **用户显式调用（二期）**：
  - 用户消息以 `/名字` 开头时，内核查命令表：先查内置命令（`/compact`），再查 Skill；是 Skill 就把 SKILL.md 的正文展开进这条消息。
  - 只解析用户的输入，智能体之间的消息不展开。
  - ACP 通过 `available_commands_update` 公布这些命令，原生协议用 `skills/list`。
  - 2d：Skill 改写成带命名空间的 `/skill:名字`，可以出现在消息的任意位置、可以有多个，内核不再从普通的词里猜；用户的话原样保留，Skill 的正文放在前面；桌面端输入框改用 Lexical，选中的 Skill 显示成标签（§6.3）。
- **压缩（二期）**：用过的 Skill 在压缩后重新附上正文，不会只剩摘要里的一句话。
- **子智能体**：系统提示词与父相同，自然拥有同一份清单。
- **开关**：默认开启，`skills.enabled = false` 关闭。
- **实施**：分三期。一期做发现、解析、清单注入和 `finx skills`（§13.1）；二期做显式调用、压缩保留、`skills/list` 和 ACP 的命令（§13.2）；2d 把显式调用改成任意位置的 `/skill:名字`，桌面端输入框换成 Lexical（§13.3）。都已完成。2e 收敛技能来源（§13.4），内核、命令行、协议和桌面端一次改完。

## 目录

- 方案摘要
- 0. 阅读说明
- 1. 目标与原则
- 2. 现状盘点
- 3. Skill 的格式
- 4. 发现与优先级
- 5. 写进系统提示词
- 6. 激活
- 7. 与上下文管理的关系
- 8. 权限与安全
- 9. 持久化
- 10. 配置
- 11. 命令行、协议与前端
- 12. 代码落点
- 13. 分期实施与验收
- 14. 测试
- 15. 备选方案与取舍
- 16. 决策与待定问题
- 附录 A：给模型的文本
- 附录 B：示例

## 0. 阅读说明

- **章节引用**：§x 指本文；"总方案 §x"指 technical-design.md；"协议方案 §x"指 protocol-design.md；"子智能体方案 §x"指 subagent-design.md；"桌面端方案 §x"指 desktop-design.md。后两份还在各自的分支上。
- **编号**：决策 D-60–D-89、D-170–D-177，待定问题 Q-60–Q-69。D-60–D-89、D-170–D-179 与 Q-60–Q-89 留给本文，不与总方案（服务性能用 D-90 起）、协议方案、子智能体方案、MCP 方案、模型目录方案和自定义页方案冲突。

变更记录：

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-10-29 | 定稿 |
| v1.1 | 2026-10-29 | 一期实现，DeepSeek 真实模型验收通过（§13.1）。按实现修正：清单在同一个根里按路径排序（§5.2）；遍历逐层进行，同一层的 SKILL.md 最多 4 个线程并行读取，读到头部的结束行就停（§3.3、§4.5）；启动开销改为实测值（§4.5）；`skills.dirs` 里内置列表之外的目录名也受保护（§8.3）；非项目配置里的相对路径相对 cwd（§10）；`finx skills` 的输出与实现一致（§11.1）；测试与实现对应（§14）。新增 Q-68 |
| v1.2 | 2026-10-29 | 二期规划定稿（§13）：`Op::Prompt` 新增 `commands` 字段，只解析用户的输入，智能体之间的消息不展开（§6.2）；内核命令表，内置命令 `/compact` 优先，其次 Skill，以后加 MCP 的 prompts（§6.2）；读到 SKILL.md 的 bash 命令也算"在用"（§7.2）；Skill 列表取最近一条带 `skills` 的 system_prompt 条目（§6.2、§9）；读取头部的 `argument-hint`（§3.2）；二期不升协议版本（§11）；二期等子智能体合入 main 后开工（§12.3）。新增决策 D-73–D-78 |
| v1.3 | 2026-10-29 | 二期实现，DeepSeek 真实模型验收通过（§13.2）。按实现和验收修正：展开块不带 SKILL.md 的路径，否则模型会照清单的说明再读一遍（§6.2、附录 A.2，D-79）；输入的 `/compact` 总是作为一个任务运行，没有可压缩的内容时发 warning 并结束（§6.2）；文件已删除的在用 Skill 沿用上次保留的副本，放不下的跳过、后面较小的仍可放入，`compaction_completed` 带 `kept_skills`（§7.2）；`skills/list` 与 `finx skills --json` 共用一个结果类型，会话形式按当前文件描述、名字和可见性按会话冻结（§11.1、§11.4，D-80）；ACP 在 `session/new`、`load`、`resume` 的应答之后发送命令（§11.5，D-81）；代码落点与测试与实现对应（§12、§14）。新增决策 D-79–D-81 |
| v1.4 | 2026-10-29 | 2d 方案（§6.3、§13）：Skill 的提及改写成带命名空间的 `/skill:名字`，可以在任意位置、可以有多个，二期的 `/名字` 不再表示 Skill，内核不再从普通的词里猜，也不再有与内置命令重名的问题；用户的话原样记录，Skill 的正文作为单独的文字项放在前面；意图只由文字表达，协议不加标记字段；识别规则内核与桌面端共用一套；反引号转义，写错名字发 warning；事件和历史的 `skill` 换成 `skills`；桌面端输入框改用 Lexical。新增决策 D-82–D-88 |
| v1.5 | 2026-10-29 | 2d 实现，DeepSeek 真实模型验收通过（§13.3）。按实现和验收修正：清单的说明句加上条件，对话里已经有某个 Skill 的 `<skill>` 块时不必再读它的 SKILL.md（§5.2、附录 A.1，D-89）；组成给模型的消息在 `context::entry_message`（§6.3.4）；桌面端输入框的标签用 DecoratorNode，正在输入的提及等光标离开再变成标签，菜单只在有匹配的项时打开（§6.3.7）；`finx skills --json` 与 `skills/list {cwd}` 都带 `commands`（§11.1、§11.4）；附录 A.2 改为 2d 的块，A.4 补上 2d 的 warning；代码落点与测试与实现对应（§12、§14）；桌面端方案里 Skill 这一项改为 P13（与子智能体的 P12 重号）。新增决策 D-89 |
| v1.6 | 2026-10-31 | 2e 方案：收敛技能来源。原来项目层和用户层都读 `.finx`、`.agents`、`.claude` 三个目录名，开发机上 39 个生效的 Skill 全部来自其他应用，清单约 8,300 token。现在项目里用共享标准 `.agents/skills`，`.claude/skills` 列出但默认不启用，不再读项目里的 `.finx/skills`；用户层只读 `~/.finx/skills`，其他应用的用户目录由 `skills.other_apps` 打开；主目录本身不算项目层；新增 `skills.opt_in`，删除 `skills.dirs`；SkillEntry 新增 `default_enabled`。改写 §1.1 的 G1、§4.1、§4.2、§4.4、§8.3、§10、§11.1 和附录 B.1，新增 §13.4。新增决策 D-170–D-177 和 Q-69，Q-68 由 D-171 解决 |
- **术语**：沿用总方案 §2，新增的如下。

| 术语 | 定义 |
|---|---|
| Skill | 一个包含 `SKILL.md` 的目录，用来教模型完成某类任务 |
| SKILL.md | Skill 的入口文件：`---` 包住的 YAML 头部，加 Markdown 正文 |
| 头部 | SKILL.md 开头的 YAML 部分，至少有 `description` |
| Skill 目录 | SKILL.md 所在的目录。Skill 里的相对路径都相对它 |
| Skill 根 | 扫描的起点，例如 `~/.finx/skills`。一个根下可以有很多 Skill |
| 层 | Skill 根的来源：项目层、用户层、额外路径。同名时按层和位置决定优先级（§4.2） |
| 默认启用 | 用户没有打开或关掉时，Skill 是否可用。由所在的位置决定（§4.1）；默认不启用的 Skill 在列表里，但不进清单 |
| 清单 | 系统提示词里的 `<available_skills>` 段，列出可用 Skill 的名字、描述和路径 |
| 激活 | Skill 的正文进入上下文：模型用 read 读取（模型激活），或用户用 `/skill:名字` 提及（显式调用；二期的写法是开头的 `/名字`） |
| 遮蔽 | 同名的 Skill 中，优先级较低的那个不生效 |

## 1. 目标与原则

### 1.1 目标

| 编号 | 目标 |
|---|---|
| G1 | 兼容开放规范：按规范写的 Skill 不用修改就能使用；项目里用规范的共享位置 `.agents/skills`，不另立 finx 自己的目录标准；本机其他应用装的 Skill 不会自己进来（2e） |
| G2 | 不增加工具：激活只依靠已有的 read 和 bash |
| G3 | 结果确定：同一组文件，任何时候加载的结果和生成的清单都相同；被遮蔽、被停用、加载失败的原因都查得到 |
| G4 | 不破坏缓存：清单放进冻结的系统提示词，会话内不变；同一项目的不同会话，系统提示词的前缀尽量相同 |
| G5 | 提示词最少：只写模型要据此行动、又无法从别处得知的内容，全部是固定文本 |
| G6 | 不拖慢启动：25 个 Skill 时启动时间增加不超过 1 ms（§4.5） |
| G7 | 不改变安全边界：Skill 只是文本和文件，不能放宽任何权限判定 |
| G8 | 各前端一致：CLI、原生协议、ACP、桌面端共用内核里的同一套实现 |

### 1.2 原则

- **内核负责发现和公布，模型负责判断**：内核不做关键词匹配，也不替模型挑选 Skill。
- **宽松加载，诊断明确**：只要还能用就加载，问题写进诊断；只有缺少描述、头部无法解析的才不加载。
- **复用已有机制**：项目根、AGENTS.md 的逐级查找、受保护路径、系统提示词冻结、压缩检查点，都沿用总方案的做法。
- **项目里用共享标准，`.finx` 只放 finx 独有的东西**（2e）：规则用 `AGENTS.md`，MCP 读 `.mcp.json`，Skill 用 `.agents/skills`。`.finx` 只放没有共享标准的东西：项目配置 `.finx/config.toml` 和数据目录 `~/.finx`。
- **加载要经过用户同意**（2e）：放进 finx 自己的目录、仓库的共享目录、配置里的路径，就算同意了；其他应用的目录要用户自己打开。

### 1.3 本期不做

- 会话进行中刷新清单（Q-60）。
- 内置 Skill（Q-61）。
- `allowed-tools`，以及模型覆盖、子智能体执行、钩子等扩展字段（Q-62）。
- `$ARGUMENTS` 一类的占位符替换（Q-63）。
- 按文件路径自动激活、嵌套目录里同名 Skill 的命名空间（Q-66）。
- 从网络安装、更新 Skill。

## 2. 现状盘点

| 方面 | 现状 | 对 Skill 的影响 |
|---|---|---|
| 系统提示词 | `prompt.rs` 按 base → `<tool_guidelines>` → `<user_instructions>` / `<project_instructions>` → `<extra_instructions>` → `<environment>` 组装；会话启动时生成，写进 system_prompt 条目，之后不变（总方案 §7.2、D-15） | 清单作为新的一段插进去，随之冻结 |
| 项目根与指令文件 | `instructions.rs` 向上找 `.git` 确定项目根，再从项目根到 cwd 逐级查找 AGENTS.md | 项目层 Skill 用同样的目录链 |
| read | 只读工具，任何权限模式下都直接执行；接受绝对路径；单次最多 2,000 行或 10,000 token | 模型激活不需要任何改动 |
| bash | 不是只读命令时按权限模式审批 | Skill 里的脚本照常审批 |
| 受保护路径 | `.finx`、`.agents` 已在列表中（`.agents` 的理由正是"存放给编码智能体的指令和脚本"），数据目录 `~/.finx` 也受保护；`.claude` 不在 | 需要补上 `.claude` 和额外路径（§8.3） |
| 压缩 | 新上下文只有保留的用户原话和摘要（总方案 §7.6.4） | 模型读过的 SKILL.md 是工具结果，压缩后就不在了（§7.2） |
| 配置 | 严格校验，未知的键直接报错 | 需要新增 `[skills]` |
| 子智能体 | 子会话的系统提示词与父相同（子智能体方案 D-42） | 子自然拥有同一份清单 |
| 测试 | 测试把 `FINX_HOME` 指向临时目录，但主目录还是开发机的真实主目录 | 开发机上 `~/.agents/skills` 已有 24 个 Skill，会改变测试里的系统提示词；测试必须隔离主目录（§14） |

## 3. Skill 的格式

### 3.1 目录结构

```
pdf-tools/
├── SKILL.md           # 必需：头部 + 正文
├── scripts/           # 可选：可执行的脚本
│   └── extract.py
├── references/        # 可选：按需读取的说明文档
│   └── formats.md
└── assets/            # 可选：模板、数据等资源
    └── template.json
```

```markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when reading, converting or inspecting PDFs.
---

# PDF tools

Read `references/formats.md` before converting a document. Run `scripts/extract.py <file>`
to get the text.
```

规范建议 SKILL.md 不超过 500 行（约 5,000 token），细节放进 `references/`，由正文说明什么时候读哪个文件。

### 3.2 头部字段

| 字段 | 规范的要求 | finx 的处理 |
|---|---|---|
| `name` | 必填；1–64 个字符；只用小写字母、数字和连字符；不以连字符开头或结尾，不含连续的连字符；与目录名相同 | 可以省略，缺省取目录名。不符合规范只记诊断，照常加载 |
| `description` | 必填；1–1,024 个字符；写清做什么、什么时候用 | 必填，缺失或为空时不加载。连续的空白（包括换行）压成一个空格；超过 1,024 个字符时截断并记诊断 |
| `disable-model-invocation` | 不在规范里，是常见的扩展 | 为 true 时不进清单，只能由用户显式调用（二期） |
| `argument-hint` | 不在规范里，是常见的扩展，例如 `'[app directory path or GitHub URL]'` | 二期读取：作为 ACP 命令的 `input.hint` 和 `/` 菜单里的参数提示（D-77） |
| `license`、`compatibility`、`metadata` | 可选 | 忽略。模型激活时读的是整个文件，需要时自己能看到 |
| `allowed-tools` | 可选，实验性 | 不生效（D-68），`finx skills` 里注明已忽略 |
| 其他字段 | — | 忽略，不记诊断。其他客户端定义的字段很多，逐个提示只会制造噪音 |

### 3.3 解析（D-64）

1. 从文件开头读到头部的结束行为止，最多 64 KB，通常一次读取就够；去掉 BOM，CRLF 按 LF 处理。发现阶段只要头部，正文在激活时才读。
2. 第一行必须是 `---`，到下一个只有 `---` 的行为止是头部。没有头部或找不到结束行：不加载。
3. 用 YAML 解析头部，库为纯 Rust 实现的 yaml-rust2（YAML 1.2，关闭编码转换特性）。
   - 不能手写简化的解析：现成的 Skill 大量使用 `description: >-` 这类折叠块（开发机上的 24 个全是）。
   - 解析一个约 700 字符描述的头部约 3 µs，不是瓶颈（§4.5）。
4. 解析失败时修复一次再试：顶层的 `key: value` 行里，值没有加引号、也不是块标记，却含有 `: ` 时（例如 `description: Use when: the user asks about PDFs`），把值整体加上单引号。修复后仍然失败：不加载。
5. 头部必须是映射；`name`、`description` 必须是字符串，其他类型按缺失处理。

### 3.4 诊断

| 情况 | 处理 | 在哪里提示 |
|---|---|---|
| 没有头部、头部无法解析、不是 UTF-8 | 不加载 | 会话 warning，`finx skills --all` |
| `description` 缺失或为空 | 不加载 | 同上 |
| `name` 不符合规范、与目录名不同 | 照常加载 | `finx skills --all` |
| `description` 超过 1,024 个字符 | 截断后加载 | `finx skills --all` |
| 同名被遮蔽 | 不进清单 | `finx skills --all`，运行日志（info） |
| 被停用 | 不进清单 | `finx skills --all` |
| 扫描达到上限（§4.3） | 已找到的照常加载 | 会话 warning，`finx skills --all` |
| 根目录无法读取（没有权限等） | 跳过这个根 | 会话 warning，`finx skills --all` |
| 清单超出预算（§5.4） | 截短描述或去掉条目 | 会话 warning |

- 会话 warning 只用于需要用户处理的问题，每个会话开始时发一次。
- 遮蔽不发 warning：项目覆盖个人的同名 Skill 是有意为之的用法，每次启动都提醒会变成噪音。

## 4. 发现与优先级

### 4.1 位置与默认启用（D-61，2e 改为 D-170–D-173）

| 层 | 位置 | 默认 | 说明 |
|---|---|---|---|
| 项目层 | 从 cwd 到项目根的每一级目录 D：`D/.agents/skills` | 启用 | 开放规范推荐的共享位置，仓库的人维护，给所有在这里工作的智能体用 |
| 项目层 | 同上：`D/.claude/skills` | **不启用** | 列出，用户逐个打开（§4.4） |
| 用户层 | `$FINX_HOME/skills`（默认 `~/.finx/skills`） | 启用 | 上传、从目录安装、在对话里创建的 Skill 都在这里；内置 Skill 在它的 `.system` 下 |
| 用户层 | `~/.agents/skills`、`~/.claude/skills` | **不读** | 本机其他应用的目录，`skills.other_apps = true` 时才读，读进来的默认启用 |
| 额外路径 | 配置项 `skills.paths` 列出的目录 | 启用 | 可以是一个 Skill 根，也可以直接是一个 Skill 目录 |
| 内置 | `$FINX_HOME/skills/.system` | 启用 | 在所有根之后 |

- **项目根**：同总方案 §7.3，向上找 `.git`；找不到项目根时只看 cwd。
- **项目里不读 `.finx/skills`**（D-170）：项目里一律用共享标准，`.finx` 只放项目配置。finx 还没有发布，不做兼容读取，也不迁移。
- **为什么两层的 `.agents` 处理不同**（D-171）：
  - 项目里的 `.agents/skills` 由仓库的人挑选和维护，正是给在这个仓库里工作的智能体用的。
  - 用户级的 `~/.agents/skills` 是任何工具都可能写入的共享安装位置，没有人替 finx 挑选过。开发机上实测：那里有 24 个、`~/.claude/skills` 里有 15 个（其中 14 个是另一个客户端按账号同步下来的，一半依赖那个客户端自己的工具），清单约 8,300 token，没有一个是为 finx 装的。
- **主目录不算项目层**（D-172）：从 cwd 往上找时跳过主目录本身。否则把主目录当工作目录打开、或者主目录本身是一个 git 仓库（放 dotfiles 的）时，`~/.agents/skills` 会作为项目层被读进来，绕过 `other_apps`。
- **默认启用只看位置**（D-173）：`$FINX_HOME/skills`、内置、`skills.paths`、项目层的 `.agents/skills` 默认启用，项目层的 `.claude/skills` 默认不启用。放进 finx 自己的目录、仓库的共享目录、配置里的路径，就算用户同意了；`.claude` 是另一个应用的目录，要用户自己打开。
- **不往下找**：项目层只看 cwd 和它的上级，不扫描 cwd 下面的子目录，与 AGENTS.md 的查找方式相同。

### 4.2 同名时的优先级（D-62）

按下面的顺序扫描，**同名的 Skill 先找到的生效**：

1. 项目层，从 cwd 开始，逐级往上到项目根（不含主目录）；
2. 用户层：`$FINX_HOME/skills`，`other_apps` 打开时再接 `~/.agents/skills`、`~/.claude/skills`；
3. 额外路径，按配置的顺序；
4. 内置。

- 同一级目录里：`.agents` → `.claude`。
- **不可用的不参与**（D-174）：默认不启用而用户没有打开的，以及按路径停用的，不遮蔽别的同名 Skill，排在它后面的同名候选照常生效。例如仓库的 `.claude/skills/deploy` 默认不启用，生效的是 `~/.finx/skills/deploy`；用户打开仓库那份之后，按"近的优先"由仓库那份生效。
- 同一个 Skill 根里出现同名（例如 `skills/a/lint` 和 `skills/b/lint`），按路径的字典序，先到先得。
- 同一个 SKILL.md 经不同的根出现多次（按真实路径判断，例如 `~/.agents/skills` 是指向 `~/.claude/skills` 的链接），只保留优先级最高的那一处，不算遮蔽。

一个 monorepo 的例子，cwd 为 `/work/repo/packages/web`，项目根为 `/work/repo`，扫描顺序是：

```
/work/repo/packages/web/.agents/skills
/work/repo/packages/web/.claude/skills      （默认不启用）
/work/repo/packages/.agents/skills
/work/repo/packages/.claude/skills          （默认不启用）
/work/repo/.agents/skills
/work/repo/.claude/skills                   （默认不启用）
~/.finx/skills
~/.agents/skills                            （other_apps 打开时）
~/.claude/skills                            （other_apps 打开时）
skills.paths 中的各项
~/.finx/skills/.system
```

**为什么近的优先**：
- 与配置分层一致：项目配置覆盖用户配置（总方案 §10.1）。仓库里的 Skill 体现这个仓库的约定，在这里应该替换个人的通用版本；monorepo 里子项目的 Skill 应该替换根目录的。
- 开放规范的集成指南也把"项目层覆盖用户层"列为各实现通行的约定。
- 遮蔽不带来额外权限：finx 的 Skill 不能放宽任何判定（§8），仓库替换了用户的同名 Skill，得到的只是一段不同的指令，所有操作仍然要审批。用户更看重"自己的 Skill 不被替换"时，有 Q-64 的可选做法。

### 4.3 遍历规则（D-63）

- **什么算 Skill**：一个目录里有名为 `SKILL.md` 的普通文件（或者指向普通文件的符号链接），这个目录就是一个 Skill。
- **找到就停**：从根开始逐层往下找；一个目录是 Skill，就不再进入它的子目录。
  - 理由：Skill 自己的 `assets/`、`templates/` 里常有 SKILL.md 模板，不能当成另一个 Skill。
- **根本身也可以是 Skill**：根目录里直接有 SKILL.md 时，根就是一个 Skill，这样 `skills.paths` 可以直接指向一个 Skill。
- **跳过**：名字以 `.` 开头的目录，以及 `node_modules`。
- **符号链接**：
  - 跟随指向目录的符号链接，把 Skill 链接进来是常见的安装方式；
  - 按真实路径记录访问过的目录，遇到环就跳过。
- **上限**：每个根往下最多 6 层，最多访问 2,000 个目录。达到上限就停止扫描这个根，已经找到的照常使用，并发 warning。
- **不读 `.gitignore`**（Q-65）。Skill 根里很少有需要忽略的构建产物，深度和目录数的上限已经能防止扫描失控。
- **根目录不存在**：静默跳过。这是最常见的情况，每个会话要检查十来个可能的位置。

### 4.4 启用、停用与过滤

| 方式 | 效果 |
|---|---|
| `skills.enabled = false` | 不扫描，系统提示词里没有清单 |
| `skills.other_apps = true` | 用户层再读 `~/.agents/skills`、`~/.claude/skills`，读进来的默认启用 |
| `skills.opt_in` 中写路径（Skill 目录或 SKILL.md） | 打开一个默认不启用的 Skill（D-173）；只收路径，写名字是配置错误 |
| `skills.disabled` 中写名字 | 这个名字的 Skill 全部停用，包括被它遮蔽的，所以不会"停掉一个，冒出另一个" |
| `skills.disabled` 中写路径 | 只停用这一个；同名的下一个候选随之生效，例如停用仓库里的版本，用回自己的 |
| 头部 `disable-model-invocation: true` | 不进清单，仍然可以显式调用 |

- **状态**：默认不启用而没有打开的 Skill，`state` 是 `disabled`，与用户停用的相同：不进清单，不能用 `/skill:名字` 提及，不在 `/` 菜单里。两者靠 SkillEntry 的 `default_enabled` 区分（D-177）。
- **`opt_in` 只收路径**：写名字会打开所有仓库里同名的 Skill，范围太大；而默认不启用的 Skill 本来就是"这一份要不要用"的问题。
- **同时命中**：一个 Skill 既在 `opt_in` 里又被 `disabled` 停用时，按停用算。
- **开关怎么写**（D-175）：`skills/set_enabled { path, enabled }` 和 `finx skills enable/disable <路径>` 按这个 Skill 的默认状态决定写哪个列表，都写用户配置 `~/.finx/config.toml`，不改仓库：

| 这个 Skill 默认 | 打开 | 关掉 |
|---|---|---|
| 启用 | 从 `disabled` 删掉指向它的路径，以及它的名字形式 | 把路径加进 `disabled` |
| 不启用 | 把路径加进 `opt_in` | 从 `opt_in` 删掉指向它的路径 |

  每次写入时，顺手删掉另一个列表里指向它的路径，配置里不留互相矛盾的记录。写名字的 `finx skills disable <名字>` 照旧写进 `disabled`，停用全部同名。

### 4.5 性能

- **时机**：会话启动时完成，与 AGENTS.md 的查找放在一处（`kernel.rs` 的 `build_prompt`）。
- **做法**：
  - 每个根只 stat 一次，不存在就跳过。
  - 逐层遍历。每个目录直接尝试打开其中的 SKILL.md，打不开就不是 Skill；子目录的身份取目录项自带的 inode，不再逐个 stat，只有符号链接才 stat。
  - 同一层的目录达到 16 个时，最多分给 4 个线程，并行打开、读取、解析和检查；再多线程在 macOS 上已没有收益。
  - 每个 SKILL.md 读到头部的结束行就停。
  - 清单的预算计算按每行预先计数，二分查找截短的长度，最后只渲染一次。
- **实测**（release 构建，`tools/bench/bench_startup.py --skills 0 25 80 200`，与加入 Skill 之前的版本交替运行 60 次，取从启动到发出第一个模型请求的 p50）：

| 用户目录里的 Skill 数 | 之前 | 现在 | 增加 |
|---|---|---|---|
| 0 | 7.12 ms | 7.06 ms | 无可测差异 |
| 25 | 6.92 ms | 7.97 ms | 1.0 ms |
| 80 | 6.85 ms | 9.00 ms | 2.2 ms |
| 200 | 7.06 ms | 11.43 ms | 4.4 ms |

- **构成**：每个 SKILL.md 约 18 µs，用在打开、取文件信息、读取和解析上；其余来自更长的系统提示词和请求体。优化之前 200 个 Skill 要多 16 ms，主要花在清单超出预算时逐条去掉、每次重新渲染整段上。
- **目标**：G6 的"25 个 Skill 不超过 1 ms"达到，处在上限。
- **常驻服务**：`finx serve` 中每个新会话各自扫描一次。以后如果有需要，按根目录的修改时间缓存（暂不做）。

## 5. 写进系统提示词

### 5.1 位置（D-65）

| 段 | 内容 | 变化频率 |
|---|---|---|
| base | 角色、工作方式、沟通风格 | 只随版本变化 |
| tools | 工具使用规则 | 只随配置变化 |
| instructions | 用户与项目的指令 | 偶尔 |
| **skills（新增）** | `<available_skills>` 清单 | 偶尔 |
| environment | cwd、日期、git 分支等 | 每天、每个分支都不同 |

- **放在 environment 之前**：environment 里有日期和 git 分支，是整个系统提示词里变化最频繁的部分，应该留在最后。这样同一项目里新开的会话，系统提示词直到 environment 之前都相同，厂商的前缀缓存能命中更长的一段。
- **冻结**：清单随系统提示词一起写进 system_prompt 条目，resume 时沿用日志里的版本（D-15）。
  - 会话进行中新增或修改的 Skill，从下一个会话起出现在清单里（Q-60）。
  - 已经列出的 Skill，文件内容被修改后，模型读到的是新内容。
- **整体替换基础提示词时**：`system_prompt_file` 只替换 base，清单照常加在后面，与 tools、instructions 两段相同。

### 5.2 格式（D-66）

```
<available_skills>
The following skills provide specialized instructions for specific tasks. When a task matches a skill's description, read its SKILL.md with the read tool before acting, unless the conversation already has its instructions in a <skill> block. Resolve relative paths in a skill against the directory that contains its SKILL.md.
<skill name="pdf-tools" path="/work/repo/.agents/skills/pdf-tools/SKILL.md">Extract text and tables from PDF files. Use when reading, converting or inspecting PDFs.</skill>
<skill name="commit" path="/Users/me/.finx/skills/commit/SKILL.md">Write commit messages in the team format. Use when the user asks to commit.</skill>
</available_skills>
```

- **一句说明**：说三件事：清单是什么；任务匹配时，先用 read 读 SKILL.md 再动手，对话里已经有它的 `<skill>` 块（用户提及的、压缩后保留的）就不必再读（D-89）；相对路径相对哪个目录。具体怎么做由 SKILL.md 自己写。
- **每个 Skill 一行**：`name` 和 `path` 是属性，描述是内容。
  - 结构清楚，每条的格式开销约 10 个 token；每个字段各占一个子元素的写法约 25 个。
- **path**：SKILL.md 的绝对路径，保留发现时的路径，不解析符号链接。
  - 它可以直接交给 read；
  - 它的上级目录就是 Skill 目录，模型据此知道 Skill 在哪个目录、相对路径怎么拼。
- **转义**：`&`、`<`、`>`、`"` 换成 XML 实体，描述里写不出 `</available_skills>` 这样的边界。
- **排序**：按 §4.2 的优先级顺序，同一个根里按 SKILL.md 的路径。排序只取决于文件的内容和位置，同一组 Skill 每次生成的文本逐字节相同（G3、G4）。
- **工具不同时**：
  - read 没有启用、bash 启用时，说明里的 "with the read tool" 改为 "with bash"；
  - read 和 bash 都没有启用时，整段省略，因为模型没有办法读取。
- **没有可用的 Skill**：整段省略，不留空标签。

### 5.3 不写什么

| 可以写的内容 | 不写的理由 |
|---|---|
| 用户点名某个 Skill 时必须使用 | 模型自然会照做；用户显式调用时，内核直接展开正文（§6.2） |
| 多个 Skill 都匹配时怎么取舍、先后顺序，要不要宣布正在用哪个 | 属于沟通风格，任务不同要求也不同 |
| 要把 SKILL.md 读完，不要读无关的文件 | SKILL.md 一般一次 read 就能读完；读哪些说明文档，SKILL.md 自己会说明 |
| Skill 读不到时怎么办 | read 失败的结果已经说明了原因 |
| 子智能体能不能用 Skill | 子智能体拥有同一份清单，用法相同 |

这与总方案 D-35、子智能体方案 D-51 的做法一致：只写模型要据此行动、又不能从别处得知的内容，并且全部是固定文本。

### 5.4 预算（D-67）

- **上限**：`min(2% × 上下文窗口, 10,000)` token，按会话开始时的模型计算。
  - `skills.max_catalog_tokens` 可以改，0 表示自动；
  - 估算沿用总方案 §7.5.3 的规则；
  - 说明句和标签也算在内。
- **单条描述**：先截到 1,024 个字符，即规范的上限。
- **超出预算时**：
  1. 统一截短描述：求出最大的长度 L，让每条描述都截到 L 个字符以内时，整段放得下；被截的描述末尾加 `…`。所有描述一起变短，不会让排在后面的 Skill 整条失去关键词。
  2. L 降到 0 仍放不下：从优先级最低的一条开始整条去掉，直到放得下。
  3. 发一次 warning，说明截短到多少个字符、去掉了哪些 Skill，并建议调高 `skills.max_catalog_tokens` 或停用不常用的 Skill。
- **实测**：开发机上 `~/.agents/skills` 里有 24 个现成的 Skill，描述平均约 730 个字符，整段约 20 KB、5,000 token；只保留名字和路径也要约 620 token。

| 上下文窗口 | 预算 | 结果 |
|---|---|---|
| 1M（如 deepseek-flash） | 10,000 | 全部完整放下 |
| 200K | 4,000 | 描述统一截到约 615 个字符 |
| 128K | 约 2,600 | 描述统一截到约 330 个字符 |

## 6. 激活

### 6.1 模型激活（一期）

1. 模型看到清单，判断任务与某个 Skill 匹配，调用 `read(path=<SKILL.md 的绝对路径>)`。read 是只读工具，任何权限模式下都直接执行。
2. 读到正文后，按其中的指引用 read 读 `references/…`，用 bash 运行 `scripts/…`。模型按清单里的说明，把相对路径拼成绝对路径。
3. 读取结果是普通的工具结果，按总方案 §5.7 裁切。SKILL.md 超过 2,000 行或 10,000 token 时，模型会看到省略说明，再按 offset 读余下的部分。

- 内核不判断模型是否应该使用某个 Skill，也不记录激活。二期的压缩保留从历史中推导激活（§7.2），同样不需要额外的状态。

### 6.2 用户显式调用（二期，D-70、D-73、D-74）

**命令表**（D-74）：用户消息的第一段文本以 `/` 开头时，内核取第一个词，按下面的顺序查找：
1. **内置命令**：目前只有 `/compact`。会话空闲时作为一个任务运行压缩；没有可压缩的内容时发 warning（`nothing to compact`）并结束这个任务，所以 `finx exec` 和 ACP 的 prompt 都能正常结束；有任务在运行时发 warning。后面跟的文字暂不使用。
2. **Skill**：名字与本会话某个 Skill 完全相同，后面的文本是参数。
3. **以后**：MCP 服务器提供的 prompts（MCP 方案的三期），排在 Skill 之后。

- 都找不到（例如 `/usr/bin/env 报错了`）：原样作为普通消息。
- `disable-model-invocation: true` 的 Skill 也可以这样调用；被停用、被遮蔽的不行。
- Skill 与内置命令重名：内置命令优先，`finx skills` 里提示这个 Skill 不能显式调用。
- 协议方案 §7.4 原计划只在 ACP 层把 `/compact` 换成 `Op::Compact`，现在改由内核统一处理，所有前端同时生效。

**只解析用户的输入**（D-73）：`Op::Prompt` 新增可选字段 `commands`，默认为 true。
- 前端发来的用户输入不带这个字段，照常解析。
- 智能体之间的消息设为 false：子智能体的任务说明和 `send_message` 都通过 `Op::Prompt` 送达，其中的 `/名字` 不展开（D-72）。
- 前端想把以 `/` 开头的文本原样发给模型时，也可以设为 false。

**展开**：内核读取 SKILL.md，去掉头部，把这条消息的文本换成：

```
<skill name="pdf-tools">
Relative paths in this skill are relative to /work/repo/.agents/skills/pdf-tools.

（SKILL.md 的正文）
</skill>

extract report.pdf
```

- 正文按工具输出的上限裁切（总方案 §5.7）。完整内容就是 SKILL.md 本身，省略说明直接给出它的路径。
- **块里不写 SKILL.md 的路径**（D-79）：清单的条目是 `<skill name=… path=…>`，清单的说明句要求任务匹配时先 read 这个路径。展开块如果也带 `path`，模型会把它当成清单条目再读一遍文件：真实验收里 DeepSeek 就这样做了，正文在上下文里出现两次，还多一次往返。去掉 `path` 之后不再重复读取（§13.2）。只有正文被截断时，省略说明里才给出路径。
- 同一条消息里的图片等其他内容，照常保留在后面。
- 读取失败：不展开，原样发送，并发 warning。

**在哪里展开**：内核收到 `Op::Prompt` 时（`task::on_prompt`），在放进插话或追加队列之前。排队的消息只展开一次，之后不再读文件；任务被中断时退回给前端的排队消息（`task_interrupted` 的 `returned_input`）是用户输入的原文。CLI、原生协议、ACP 和桌面端都不需要各写一遍（G8）。

**记录**：
- 历史里存展开后的文本，也就是模型看到的内容。
- 日志的 message 条目、`message_completed` 事件和原生协议 `session/history` 的历史条目，都附带 `skill: {name, path, input}`，`input` 是用户输入的原文。
  - 前端据此显示 `/pdf-tools extract report.pdf`，把正文折叠起来。
  - ACP 回放历史时，发的是 `input`；会话列表的首条消息预览也用 `input`。
- `/compact` 不产生用户消息，记录与 `Op::Compact` 相同。

**名字从哪里来**（D-76）：本会话最近一条带 `skills` 的 system_prompt 条目（§9），与模型看到的清单一致；恢复会话后同样如此。MCP 会在工具集合变化时重写 system_prompt 条目（MCP 方案 D-104），重写时带上原来的 `skills`。

**公布可用的命令**：都从命令表生成（`commands::available`）：先是内置命令，再是本会话可以显式调用的 Skill，按优先级排列；与内置命令重名的、文件已经读不出头部的不列。
- ACP：`session/new`、`session/load`、`session/resume` 的应答之后发一次 `available_commands_update`（§11.5）。每项有 name、description；Skill 头部有 `argument-hint` 时，作为这一项的 `input.hint`（D-77）。
- 原生协议：`skills/list` 带 `session_id` 时返回同样的命令（§11.4），桌面端用它做 `/` 菜单。
- 命令行：`finx exec`、`finx resume -p` 的任务直接以 `/名字` 开头即可。`finx chat` 只用模型层、不经过内核，不支持。

**为什么用 `/名字`**：
- 这是用户最熟悉的写法；编辑器的 ACP 命令菜单本来就以 `/` 开头，Skill 进菜单不需要额外的映射。
- 不加命名空间一类的前缀，名字短。与内置命令的冲突靠"内置优先"解决，内置命令只有几个。

### 6.3 在消息任意位置提及 Skill（2d，D-82–D-89）

**目标**：
- 桌面端输入框在任意位置输入 `/` 都能弹出菜单，选中的 Skill 变成一个标签；一条消息可以提到多个 Skill。
- 桌面端、ACP、命令行是同一种写法、同一套规则，内核只有一份实现。
- 尽量不误判：普通文字里的路径、网址、日期、命令，都不能被当成 Skill。

**误判从哪里来**：只在"从普通文字里猜用户的意图"时才会误判。二期的 `/名字` 是一个普通的词：用户在开头写 `/deploy 返回 404`，指的是接口，内核会当成 deploy 这个 Skill；如果再放开到句中，`看看 /deploy 接口`、`跑一下 /test` 这类写法都会误判。任何靠前后字符判断边界的规则都只能减少、不能消除这种情况，因为 `/deploy` 本身就是一个合法的路径。所以 2d 不再从普通的词里猜，而是让"提及"有一个不会和普通文字撞上的写法。

**原则**：
1. **提及有专门的写法**：`/skill:名字`。`skill:` 是命名空间，路径、网址、日期都不会以 `/skill:` 开头。内核只认这个写法，不从普通的词里猜。
2. **用户的话原样记录**。桌面端的标签在文字里就是 `/skill:名字` 这个占位文字，模型读到的是用户写的完整句子。内核不再改写用户的文字。
3. **文字本身就能说明意图**。占位文字是这个提及唯一的、完整的写法：复制、粘贴、中断后退回、在命令行重发，意思都不变，不需要另外的标记。
4. **Skill 的正文是另外的内容**，放在用户的话前面，不和用户的话混在一起。
5. **规则只有一套**：内核按它认定和加载；桌面端按它把文字画成标签。两边用同一份测试用例对齐。

#### 6.3.1 写法

| 写法 | 位置 | 含义 |
|---|---|---|
| `/compact` | 只在第一项文字的开头（前面的空白不算） | 内置命令，同二期 |
| `/skill:名字` | 用户文字的任意位置，可以有多个 | 提及这个 Skill，加载它的正文 |

- 二期的 `/名字` 不再表示 Skill，只有内置命令用不带命名空间的写法。好处：Skill 与内置命令、以后加的内置命令、MCP 的 prompts（MCP 方案 Q-105，可以用 `/mcp:…`）都不会重名，二期"内置命令优先"的规则和 `finx skills` 里的相应提示也随之去掉。
- 有菜单的入口（桌面端、Zed）里，输入 `/gen` 就能按名字找到 `skill:gen-report`，选中后插入完整的写法，不需要手打命名空间。命令行里手写 `/skill:gen-report`。
- `disable-model-invocation: true` 的 Skill 照样可以这样提及；被停用、被遮蔽的不行。

#### 6.3.2 识别规则

内核和桌面端共用这条规则：
- **范围**：只看用户输入的文字项。ACP 内嵌资源转成的文字项（以 `<resource uri=` 开头）不看：附件里的内容不是用户的话。
- **转义**：行内代码（一对反引号之间）和代码块（``` 围起来的行）里的不算。想写字面的 `/skill:x`，写在反引号里；各入口都一样。
- **前面**：`/` 前面是文字开头、空白，或者不是"路径字符"的字符。路径字符是 ASCII 字母和数字，以及 `/ \ . : ~ _ - @ # % & = ? + $ *`。所以 `http://h/skill:x`、`a/skill:x` 不算；`用/skill:gen-report整理`、`（/skill:gen-report）` 算。
- **名字**：`skill:` 后面最长的一段 ASCII 字母、数字、`_` 和 `-`。名字里有其他字符（不符合命名规则）的 Skill 不能这样提及，也不进菜单，只能由模型按清单使用。
- **后面**：名字后面是文字结尾、空白、非 ASCII 字符（中文、全角标点），或者不是路径字符的 ASCII 字符；`.`、`:`、`?` 后面紧接结尾、空白或非 ASCII 字符时也算，这是句末的标点。所以 `/skill:gen-report。`、`/skill:gen-report.` 算，`/skill:gen-report.md`、`/skill:gen-report/x` 不算。
- **匹配**：名字必须与本会话某个 Skill 的名字完全相同，区分大小写。写法正确、但没有这个名字的（多半是打错了），发 warning：`no skill named 'gen-reprot'; "/skill:gen-reprot" was sent as text`，这段文字照原样发出。
- 同一个 Skill 提到多次，只加载一次。

#### 6.3.3 内核的处理

收到 `commands` 为 true 的 `Op::Prompt` 时，命令表（`commands::resolve`）依次处理：
1. 内置命令：第一项文字以 `/compact` 开头，就是压缩命令，后面的内容不用。
2. 按 §6.3.2 找出提及，按第一次出现的位置排列，去掉重复。
3. 依次读取各自的 SKILL.md，生成附录 A.2 的块，按工具输出的上限裁切。读取失败的发 warning，那段文字照原样留在消息里。
4. 得到要记录的内容：用户的原话，以及加载的 Skill（名字、路径、块）。

智能体之间的消息（`commands: false`）以上都不做，同二期（D-73）。排队的消息在入队前处理一次，之后不再读文件，同二期。

#### 6.3.4 记录与给模型的内容

- **message 条目**：`message` 是用户的原话（文字、图片、附件原样）；新增 `skills`：加载的 Skill，`{name, path, content}`，`content` 是附录 A.2 的块。
- **给模型的消息**：在构建上下文时组成，只在 `context::entry_message` 这一处（组成上下文和估算用量都经过它）：先是各个 Skill 的块，每个一项文字，再接用户的原话。内容全部来自日志，恢复会话后逐字节相同。
- **事件与历史**：`message_completed` 和历史条目（TranscriptItem）带用户的原话和 `skills: [{name, path}]`，不带正文。前端直接显示原话；按 §6.3.2 把 `skills` 里有的 `/skill:名字` 画成标签，没加载的照普通文字显示。
- **压缩**：保留的用户消息就是原话；在用的 Skill 来自 message 条目的 `skills`（§7.2）。二期"保留的候选只取 `input`"的特殊处理随之去掉。
- **中断退回**：退回给前端的排队消息就是原话，`/skill:名字` 原样在里面，前端按规则重新画出标签。
- **二期的日志**：message 条目带 `skill`、正文已经展开在消息里的，照常能读：给模型的内容按原样用；显示和保留时取 `skill.input`。

#### 6.3.5 协议

都在协议版本 2 之内：
- `Op::Prompt` 不变。意图全在文字里，不需要另外的标记字段。
- `message_completed`、`TranscriptItem::Message`：`skill` 换成 `skills: [SkillUse]`，SkillUse 是 `{name, path}`。二期的 `skill` 字段和 SkillInvocation 类型还没有客户端用过，直接替换；schema 和 TypeScript 类型重新生成。
- `skills/list` 的 `commands` 里，Skill 的 `name` 写成 `skill:名字`，就是 `/` 后面要输入的内容；带 `cwd` 时也返回 `commands`，新会话页的菜单用它。
- ACP 的 `available_commands_update` 同样列出 `compact` 和 `skill:名字`。

#### 6.3.6 各入口

| | 桌面端 | ACP（Zed 等） | 命令行 |
|---|---|---|---|
| 菜单 | 任意位置输入 `/` 弹出；开头还列出 `/compact`；按名字和描述模糊匹配 | 客户端按 `available_commands_update` 显示 | 无 |
| 写法 | 选中得到标签，文字是 `/skill:名字`；手打或粘贴的 `/skill:名字` 也变成标签 | `/skill:名字`，任意位置 | 同左 |
| 认定 | 内核，同一套规则 | 同左 | 同左 |
| 历史 | 原话，加载了的提及画成标签 | 回放原话 | 原话；提示行列出加载的 Skill |
| 字面的写法 | 写在反引号里 | 同左 | 同左 |

三个入口发出的是同一种文字，内核按同一套规则处理；桌面端只是把这种文字画得好看一些。

#### 6.3.7 桌面端输入框（D-88）

用 Lexical 的纯文本模式替换现在的 textarea，输入框以外的组件不变。版本固定为 0.52.0（发布一个月）；0.53.0 刚发布一天，先不用。

- **标签节点**：SkillNode，行内的 DecoratorNode，文字内容是 `/skill:名字`（导出、复制都得到它），显示成带图标、只写名字的圆角标签。光标左右移动时整个跳过，退格整个删除，撤销能恢复。历史里的标签另带一段字号为 0 的 `/skill:名字`，选中复制得到的是原话。
- **插入**：用 Lexical 的 typeahead 插件。触发条件就是 §6.3.2 对 `/` 前一个字符的要求，所以 `a/b`、`10/29`、网址不会弹出菜单。`/` 后面到光标处是查询词，去掉开头的 `skill:` 后按名字和描述模糊匹配。开头输入时，内置命令排在前面。选中后把 `/查询词` 换成 SkillNode，后面补一个空格；选中 `/compact` 时插入文字 `/compact `。菜单只在有匹配的项时打开：没有匹配时不占用 ↑↓、Esc，用户写的路径照常是文字。开头指前面只有空白，与内核认 `/compact` 的位置相同。
- **自动识别**：手打或粘贴的、完整的 `/skill:名字`（按 §6.3.2，名字是本会话的 Skill）换成 SkillNode。写法里带着命名空间，不会误把路径变成标签。结尾就在光标处的那个还在输入，先保持文字，光标离开或输入框失去焦点时再换；标签后面紧接着打了字母，它就不再是一个提及，退回文字，删掉字母后又会变回标签。标签始终与内核的认定一致：文字里能认出的提及才是标签。
- **导出**（发送、存草稿）：遍历节点，文字原样，换行是 `\n`，SkillNode 写成 `/skill:名字`。得到的就是要发送的文字，作为 input 的第一项。
- **导入**（恢复草稿、中断退回，以及以后的编辑重发）：按 §6.3.2 找出本会话 Skill 的提及，换成 SkillNode。
- **按键**：↩ 发送，菜单打开时 ↩、Tab、↑↓、Esc 交给菜单（菜单的按键优先级高于发送）；⇧↩ 换行；⌥↩ 追加发送；输入法组字时按键不发送。与现在相同。撤销用 HistoryPlugin，插入一个标签算一步。
- **粘贴**：按纯文本粘贴，其中完整的 `/skill:名字` 由自动识别变成标签。
- **菜单的数据**：会话页用 `skills/list {session_id}` 的 `commands`，会话内不变，打开会话时取一次；新会话页用 `skills/list {cwd}`，换项目时重新取。
- **历史**：用户消息按 §6.3.2 切段，`skills` 里有的画成与输入框相同的标签。
- **共用测试用例**：`crates/finx-core/testdata/mentions.json` 列出文字和按写法应当认出的提及（36 条），是不是本会话的 Skill 由使用的一方另外判断；内核的单元测试和 `packages/client` 的测试都读它。
- **代码**：`apps/desktop/src/renderer/src/composer/` 下的 `PromptEditor.tsx`（编辑器、标签的识别、菜单、按键）、`SkillNode.tsx`（标签）、`skills.ts`（菜单的数据）；识别规则的 TypeScript 版在 `packages/client/src/mentions.ts`。用到的 Lexical 接口：PlainTextPlugin、HistoryPlugin、LexicalTypeaheadMenuPlugin、DecoratorNode、节点变换。

#### 6.3.8 与二期相比

| 方面 | 二期 | 2d |
|---|---|---|
| Skill 的写法 | `/名字`，只在开头，一条消息一个 | `/skill:名字`，任意位置，可以有多个 |
| 与内置命令重名 | 内置命令优先，Skill 不能这样调用 | 不会重名 |
| 用户的话 | 第一项文字被换成 Skill 的块加参数 | 原样保留 |
| Skill 的正文 | 在用户的文字里 | 用户的话之前的单独文字项，记在 message 条目的 `skills` |
| 记录与事件 | `skill: {name, path, input}` | `skills: [{name, path}]`，正文只在日志里 |
| 菜单的命令名 | `名字` | `skill:名字` |

D-70（用户可以显式调用 Skill）、D-73（只解析用户的输入）、D-74（命令表）、D-79（块里不写 SKILL.md 的路径）继续有效；D-70 的写法和"把正文展开进这条消息"改为本节的做法。实现后的验收见 §13.3。

## 7. 与上下文管理的关系

### 7.1 缓存

- 清单在冻结的系统提示词里，会话内不变，不影响历史只追加（总方案 §7.7）。
- 显式调用展开成一条普通的用户消息，同样只追加。
- 以后支持会话中途更新清单时，也用"在任务边界追加一条消息"的方式，不改写前缀（Q-60）。

### 7.2 压缩时保留在用的 Skill（二期，D-71）

**问题**：压缩后，新上下文只有保留的用户原话和摘要（总方案 §7.6.4）。模型用 read 读过的 SKILL.md 是工具结果，会被摘要代替。摘要通常只记得"在用某个 Skill"，记不住它的具体要求，之后的工作就会偏离这个 Skill。

**哪些算在用的 Skill**，都从历史中推导，不额外记录状态：
- 被压缩的这段历史（上一个检查点之后）里，用户显式调用过的；
- 模型用 read 成功读过的：read 解析后的路径与本会话某个 SKILL.md 的真实路径相同；
- 模型用 bash 读过的（D-75）：成功的 bash 命令里有读文件的命令（`cat`、`head`、`tail`、`sed`、`less`、`more`、`bat`、`awk`），参数按当时的工作目录解析后，是本会话的某个 SKILL.md。一期的真实验收里，模型读 SKILL.md 用的是 read，读说明文档时用过 `cat`；为了稳妥，两种都算；
- 上一个检查点保留的。
- 失败的工具调用不算；只提到路径（例如 `ls`）也不算。
- 实现上分两步：持有会话锁时只从历史里取出候选路径，不访问文件系统；解锁后再比对真实路径（`skills/kept.rs`）。

**怎么保留**：
- 按最近一次使用的时间从新到旧，重新读取各自的 SKILL.md（读当前的文件，去掉头部），格式同 §6.2 的展开块。
- 每个最多 5,000 token，超出部分从尾部截掉，注明全文的路径。
- 合计不超过 `min(keep_skill_tokens, 10% × 硬上限)`，`keep_skill_tokens` 默认 20,000。按上面的顺序放入，放不下的跳过，后面较小的仍可放入。
- 文件已经不存在的，沿用上次压缩保留的副本；从未保留过的，跳过。

**新上下文的组成**：

```
system（不变）+ 工具定义（不变）
+ 保留的用户消息（按时间顺序，每条一个 user 消息）
+ 在用的 Skill（一个 user 消息）
+ 摘要（一个 user 消息，放在最后）
+ 之后新增的消息
```

- 在用的 Skill 这条消息：一句固定的说明，加上各个 `<skill>` 块，格式同 §6.2（附录 A.3）。
- 显式调用的消息作为"保留的用户消息"的候选时，只取 `input`（用户的原话）。正文不占用户原话的预算，改由上面的方式保留。
- 选中的正文作为副本写进 compaction 条目（新增的可选字段 `skills`）。恢复会话时不用再读文件，结果与压缩时一致。
- `compaction_completed` 事件新增可选字段 `kept_skills`：保留下来的 Skill 的名字，最近用过的在前；命令行的提示行里也列出它们。
- 压缩后的检查（总方案 §7.6.4）：仍然达到软阈值时，Skill 的预算与用户原话的预算一起减半，直到两者都为 0。

**二期之前**：没有这一步，压缩后模型只能凭摘要里记下的 SKILL.md 路径重新读取。交接请求已经要求逐字保留"工作依赖的文件路径"（总方案附录 E），所以不改交接提示词。

### 7.3 恢复与分支

- 恢复会话沿用日志里的系统提示词，清单也就不变，不重新扫描。
- 显式调用的名字按最近一条带 `skills` 的 system_prompt 条目解析（§6.2）。
- 回退和派生（总方案 §9.5）只改变历史分支，系统提示词与清单不变。

## 8. 权限与安全

### 8.1 读取

- read 是只读工具，任何权限模式下都直接执行；bash 里的 `cat`、`head` 等只读命令在 manual 下也直接执行。
- 读取 Skill 目录里的文件不需要任何特殊放行。开放规范建议"把 Skill 目录加入读取白名单"，finx 的读取本来就不受限制。

### 8.2 执行

- Skill 里的脚本由 bash 运行，照常按权限模式审批。审批时显示的是完整命令，例如 `python3 /work/repo/.agents/skills/pdf-tools/scripts/extract.py report.pdf`。
- Skill 不能改变任何权限判定：没有预先放行，没有专门的规则。

### 8.3 写入：受保护路径（D-69）

- **已经受保护**：`.finx`、`.agents`（路径中任何一级），以及数据目录 `FINX_HOME`。
- **新增 `.claude` 目录**：finx 从 `.claude/skills` 加载 Skill（2e 起默认不启用，用户可以打开）；这个目录里还有其他编码智能体的设置和钩子，同样会被自动执行。
- **新增额外路径**：`skills.paths` 中的目录作为受保护路径传入，与数据目录用同一机制。
- **2e 起没有自定义目录名**：`skills.dirs` 删除之后（D-176），受保护的目录名固定为 `.finx`、`.agents`、`.claude`。`.finx` 在项目里不再放 Skill，但仍有项目配置，照旧受保护。
- **理由**：写进 Skill 目录的内容会成为以后每个会话的指令，和 git hooks、shell 配置一样，需要先问。
- manual 和 accept-edits 下写入这些位置都要询问；bypass-permissions 下不拦截（D-31）。

### 8.4 项目信任（D-68）

- **始终加载**：项目层 Skill 与 AGENTS.md 一样，不受项目信任状态影响（总方案 §11.7）。
  - 它们只是清单里的几行文本，加上模型能读到的文件；仓库里任何文件模型本来都能读。
  - 从网上克隆的仓库里附带的 Skill，往往正是用户想用的。
- **不能放宽安全设置**：`allowed-tools` 不生效。以后支持时，只对用户层和受信任的项目生效（Q-62）。
- **遮蔽用户的同名 Skill**：仓库得到的只是一段不同的指令，没有额外的权限，所有操作仍然要审批。用户更看重这一点时，可选做法见 Q-64。
- **提示词注入**：清单里的描述可能含有诱导性的文字，风险与 AGENTS.md 相同。描述截到 1,024 个字符，标签字符全部转义。

## 9. 持久化

| 条目 | 新增的可选字段 | 期数 | 用途 |
|---|---|---|---|
| system_prompt | `skills`：每个可用 Skill 的 `{name, path, scope, model_invocable, argument_hint?}`，包括不在清单里、只能显式调用的；`argument_hint` 在二期加 | 一期 | 显式调用解析名字；压缩时判断哪些 read 是在读 Skill；`skills/list` 和 ACP 的命令 |
| message | `skill`：`{name, path, input}` | 二期 | 显式调用的显示与压缩（§6.2、§7.2） |
| compaction | `skills`：保留的 Skill 正文副本，`{name, path, content}` | 二期 | 压缩后的上下文可以从日志完整重建（§7.2） |

- `scope` 取 `project`、`user`、`extra`。
- 都是可选字段，日志版本不变（2）。旧日志没有这些字段时按空处理；旧版本的 finx 读新日志，只是用不上这些信息。
- 其他功能重写 system_prompt 条目时（例如 MCP 的工具集合变化），照抄原来的 `skills`；读的一方取最近一条带 `skills` 的条目（D-76）。

## 10. 配置

```toml
[skills]
enabled = true                          # false：不扫描，系统提示词里没有清单
other_apps = false                      # true：用户层再读 ~/.agents/skills、~/.claude/skills（2e）
paths = []                              # 额外的 Skill 根或 Skill 目录，默认启用
opt_in = []                             # 打开的默认不启用的 Skill：Skill 目录或 SKILL.md 的路径（2e，§4.4）
disabled = []                           # 停用：Skill 的名字，或 Skill 目录、SKILL.md 的路径（§4.4）
max_catalog_tokens = 0                  # 清单的预算，0 为自动：min(2% × 上下文窗口, 10,000)

[compaction]
keep_skill_tokens = 20000               # 压缩后重新附上的 Skill 正文的预算，另受 10% × 硬上限限制（§7.2）
```

- **`other_apps`**（D-171）：先只在配置里，以后加到设置页（Q-69）。
- **路径的写法**：`paths`、`opt_in` 和 `disabled` 里的路径是绝对路径，或以 `~/` 开头。相对路径在项目配置里相对项目根（加载配置时就换成绝对路径），在其他来源里相对 cwd。`disabled` 中含 `/` 或以 `~` 开头的项是路径，其余是名字；`opt_in` 里出现名字是配置错误。
- **团队想让仓库里 `.claude/skills` 的某个 Skill 对所有人默认启用**：把它放进 `.agents/skills`；或者在仓库的 `.finx/config.toml` 里写 `skills.opt_in = [".claude/skills/xxx"]`。
- **`skills.dirs` 已删除**（D-176）：配置里还写着它时，加载配置报错：`skills.dirs was removed: project skills live in .agents/skills, and .claude/skills is listed off by default; set skills.other_apps for ~/.agents and ~/.claude`。与其他未知的键一样严格。
- **项目配置**可以设置以上各项，不受信任状态影响，因为它们都不放宽安全设置（总方案 §11.7）。
- **合并**按总方案 §10.1：表按键合并，数组整体替换；`opt_in` 与 `disabled` 例外，跨层拼接、去重（自定义页方案 DD-34），否则项目配置里一写，个人的选择就全被覆盖。
- 不新增环境变量。临时关闭可以用 `-c skills.enabled=false`。

## 11. 命令行、协议与前端

### 11.1 `finx skills`（一期）

```
finx skills [DIR] [--all] [--json]
```

列出 DIR（默认为 cwd）下新开会话时会用到的 Skill，与其他命令行输出一样用英文：

```
project  lint       .agents/skills/lint/SKILL.md
user     pdf-tools  ~/.finx/skills/pdf-tools/SKILL.md
user     deploy     ~/.finx/skills/deploy/SKILL.md  only when the user invokes it
2 more shadowed, disabled or broken; `finx skills --all` lists them
catalog: 2 skills, about 1240 tokens (budget 10000)
not read: ~/.agents/skills, ~/.claude/skills (skills.other_apps is off)
```

- 路径在 cwd 之下时显示相对路径，在主目录之下时以 `~` 开头。
- `--all`：同时列出被遮蔽、被停用、加载失败的 Skill 和原因，例如 `shadowed by ~/.finx/skills/deploy/SKILL.md`、`off by default; finx skills enable .claude/skills/deploy turns it on`、`not loaded: the header has no description`，以及每个 Skill 的提示（§3.4）。
- **末尾的 `not read` 行**（D-177）：`other_apps` 关着、而 `~/.agents/skills` 或 `~/.claude/skills` 存在且里面有不以 `.` 开头的子目录时才输出，只列这样的目录。用过别的工具的人一眼能知道"我的 Skill 为什么不在"。只读一次目录，不扫描；SkillsListResult 新增可选字段 `not_read: [路径]`，`--json` 和 `skills/list {cwd}` 都带。桌面端不显示，保持页面干净。
- `--json`：`{skills, commands, catalog: {listed, tokens, budget, shortened_to?, left_out?}, enabled, warnings}`，`commands` 是在这里新开的会话里 `/` 能用的命令（2d），`skills` 的每项是 SkillEntry（name、description、path、scope、model_invocable、argument_hint?、state、detail?、notes?），带 `?` 的字段为空时省略。这就是原生协议 `skills/list` 带 `cwd` 时的结果（SkillsListResult，§11.4），两边用同一个类型输出。
- 与其他查看类命令一样，不启动异步运行时，不写日志文件（总方案 §12）。

### 11.2 其他命令（一期）

- `finx status`：显示当前目录可用的 Skill 数、进清单的数目和清单的 token 数；`--json` 里是 `skills: {enabled, active, listed, catalog_tokens, catalog_budget}`。
- `finx doctor`：增加 skills 一项，显示加载了几个、几个加载失败；加载失败的原因列在 warning 里。失败的 Skill 不让这项检查失败，也不影响退出码。
- `finx exec`、`finx resume`：会话 warning 照常输出到 stderr。`finx chat` 只用模型层、不经过内核，不加载 Skill。

### 11.3 子智能体

- 子会话的系统提示词与父相同（子智能体方案 D-42），所以清单相同，用法也相同（D-72）。
- 显式调用只处理用户的输入。父写给子的任务说明不是用户输入，其中的 `/名字` 不展开；父需要子使用某个 Skill 时，在任务说明里写明即可。
- 实现上，智能体之间的消息都以 `commands: false` 提交 `Op::Prompt`（§6.2、D-73）。

### 11.4 原生协议与桌面端（二期）

- **协议版本不变**（D-78）：二期只新增可选字段和方法，协议版本仍为 2；`finx protocol schema` 重新生成，`crates/finx-protocol/schema.json` 随之更新。
- 新增 `skills/list`（SkillsListParams → SkillsListResult），参数二选一，都给或都不给是 `invalid_params`：
  - `session_id`：已加载的会话。`skills` 是会话启动时的 Skill（最近一条带 `skills` 的 system_prompt 条目），`commands` 是输入 `/` 时能用的命令，桌面端的 `/` 菜单用它。没有加载的会话返回 `session_not_loaded`，不存在的返回 `session_not_found`。
  - `cwd`：绝对路径。按当前文件重新扫描，被遮蔽、停用、加载失败的也列出，带 `catalog`；2d 起也带 `commands`，新会话页的 `/` 菜单用它；结果与 `finx skills --all --json` 逐字节相同，供设置页面查看。
- **会话形式怎么描述 Skill**（D-80）：名字、路径、层、能否由模型调用，按会话启动时的记录；描述、`argument-hint` 和提示，按文件现在的内容读取，与 `/名字` 展开时读取当前文件一致。文件已经读不出头部的，`state` 为 `invalid`，`detail` 说明原因，不进 `commands`。描述不存进会话状态和日志，每次查询时读文件的头部，在阻塞线程上进行。
- **CommandInfo**：`{name, description, hint?, skill?}`。`hint` 来自 `argument-hint`；`skill` 是它调用的 SKILL.md，内置命令没有这个字段。2d 起 Skill 的 `name` 是 `skill:名字`。
- **共用一份类型**：SkillEntry、SkillScope、SkillState 从 finx-core 移到 finx-protocol 的 `api.rs`，内核、命令行、原生协议直接用同一个类型，不做转换；finx-core 的 `skills` 模块重新导出它们。
- `Op::Prompt` 新增可选字段 `commands`（§6.2）。
- 显式调用的用户消息在 `message_completed` 事件和 `session/history` 里带 `skill` 字段（§6.2），桌面端显示用户输入的原文，正文折叠。2d 起换成 `skills: [{name, path}]`，消息本身就是原话（§6.3.5）。
- TypeScript 类型（`packages/protocol/src/generated.ts`）随 schema 重新生成。
- **2e**（D-177）：SkillEntry 新增 `default_enabled: bool`，SkillsListResult 新增可选的 `not_read`；协议版本不变。`skills/set_enabled` 的参数和结果不变，内核按默认状态决定写哪个列表（§4.4），结果的 `file` 照旧是改了的用户配置。
- 桌面端方案 §7 的 P 列表补一项 P13（原为 P12，与子智能体那一项重号后改）：`/` 菜单（`skills/list` 的 `commands`）和用户消息上的 `skills` 字段。二期不做桌面端的界面，2d 做了（§6.3.7）。

### 11.5 ACP（二期）

- `session/new`、`session/load`、`session/resume` 之后发 `available_commands_update`，内容来自命令表（§6.2），与 `skills/list` 的 `commands` 相同。内置命令总会列出，所以每次打开会话都会发。
- **顺序**（D-81）：这条通知排在打开会话的应答之后，客户端收到时已经知道这个会话。ACP 层在打开成功后通过会话的 hub 取 Skill 列表；hub 按顺序处理命令，答复时打开的应答（包括 `session/load` 的回放）已经排进连接的发送队列。之后的实时通知（例如 bypass-permissions 的 notice）可能在它之前或之后。
- prompt 的文本由内核的命令表处理，ACP 层不做特殊处理：二期是开头的 `/compact` 和 `/名字`，2d 起是开头的 `/compact` 和任意位置的 `/skill:名字`；内嵌资源转成的文字不参与识别。
- `session/load` 回放历史时，用户消息回放为原话（二期的日志取 `skill.input`）。
- 端到端测试用官方的 schema 类型检查这条通知的格式。

## 12. 代码落点

### 12.1 新增

| 文件 | 内容 |
|---|---|
| `crates/finx-core/src/skills/mod.rs` | 类型（SkillRef、SkillSet，重新导出协议里的 SkillEntry、SkillScope、SkillState）；三层位置；逐层遍历与并行读取；优先级与去重；停用；字段检查；`Scan`（发现加清单预算，内核、命令行、服务共用）；`describe` 与 `session_report`（`skills/list` 的会话形式） |
| `crates/finx-core/src/skills/frontmatter.rs` | 头部的提取、YAML 解析与冒号修复；正文 |
| `crates/finx-core/src/skills/catalog.rs` | 清单的渲染、转义与预算 |
| `crates/finx-core/src/skills/kept.rs` | 二期：压缩时在用的 Skill：候选路径、比对、重新读取与截断、按预算选取 |
| `crates/finx-core/src/commands.rs` | 二期：命令表：内置命令 `/compact`、Skill 的展开与读取失败、展开块、`available`。2d：提及的识别（`mentions`）、按提及加载、`skill:名字` 的命令名 |
| `crates/finx-core/testdata/mentions.json` | 2d：识别规则的共用测试用例 |
| `packages/client/src/mentions.ts` | 2d：识别规则的 TypeScript 版，桌面端画标签、模拟服务认定提及都用它 |
| `apps/desktop/src/renderer/src/composer/PromptEditor.tsx`、`SkillNode.tsx`、`skills.ts` | 2d：桌面端的 Lexical 输入框、标签节点、菜单的数据（§6.3.7） |
| `crates/finx-cli/src/cmd_info.rs` 中的 `skills` | `finx skills` |
| `crates/finx-core/tests/skills.rs`、`crates/finx-cli/tests/e2e_skills.rs` | 内核测试与端到端测试（§14） |
| `crates/finx-mock` 的 `skill:NAME`、`invoked`、`context` 场景 | 扮演按清单使用 Skill 的模型；按消息里第一个 Skill 的块行事；报告上下文里有哪些 Skill 的正文（§13.1、§13.2） |
| `tools/acceptance/accept_skills.py`、`tools/acceptance/accept_skills_phase2.py` | 一期、二期与 2d 的真实模型验收（§13） |

### 12.2 改动

| 位置 | 改动 | 期数 |
|---|---|---|
| `prompt.rs` | `PromptInputs` 增加清单；在 environment 之前插入 | 一期 |
| `kernel.rs` 的 `build_prompt` | 调用发现；传入模型的上下文窗口（`Kernel::start` 在此之前已经解析了模型） | 一期 |
| `config.rs` | `[skills]`；`[compaction].keep_skill_tokens` 在二期加 | 一期 |
| `protected.rs` | `PROTECTED_DIRS` 增加 `.claude`；`SessionView` 增加额外的受保护根 | 一期 |
| `store/entry.rs` | system_prompt 的 `skills`；message 的 `skill`、compaction 的 `skills` 在二期加 | 一期 |
| `finx-cli` | `finx skills`；`status`、`doctor` 增加 Skill 的信息 | 一期 |
| `finx-protocol` 的 `op.rs` | `Op::Prompt` 的 `commands` 字段 | 二期 |
| `finx-protocol` 的 `api.rs` | `skills/list`；SkillEntry、SkillScope、SkillState 从 finx-core 移来；CommandInfo、CatalogInfo、SkillsListParams、SkillsListResult | 二期 |
| `finx-protocol` 的 `event.rs` | SkillInvocation；`message_completed` 的 `skill`；`compaction_completed` 的 `kept_skills` | 二期 |
| `task.rs` 的 `on_prompt` | 进队列之前解析命令；队列里的消息带上 `skill`；`/compact` 作为任务运行；中断时退回原文 | 二期 |
| `session.rs` 的 `record_user`、`store/entry.rs`、`kernel.rs` 的 `transcript` | message 条目、`message_completed` 和 `TranscriptItem` 的 `skill` | 二期 |
| `kernel.rs` | `Kernel::skills`；子会话继承父的 Skill 列表；恢复时取最近一条带 `skills` 的 system_prompt 条目 | 二期 |
| `skills/frontmatter.rs` | 读取 `argument-hint` | 二期 |
| `compaction.rs`、`context.rs`、`budget.rs` | 在用的判定、预算与减半、compaction 条目的 `skills`、新上下文的组成；保留的用户消息只取 `input` | 二期 |
| `config.rs` | `[compaction].keep_skill_tokens` | 二期 |
| `store/jsonl.rs` | 会话列表的首条消息预览用 `input` | 二期 |
| `finx-acp` | 打开会话后发 `available_commands_update`；回放与实时的用户消息显示 `input` | 二期 |
| `finx-server` | `skills/list`；hub 的 `Skills` 命令 | 二期 |
| `finx-cli` | `finx skills --json` 输出 SkillsListResult；压缩提示行列出保留的 Skill | 二期 |
| `finx-mock` | `invoked`、`context` 场景 | 二期 |
| `crates/finx-protocol/schema.json`、`packages/protocol/src/generated.ts` | 重新生成 | 二期 |
| `commands.rs`、`task.rs` 的 `on_prompt` | 任意位置的提及、按提及加载、写错名字的 warning；`/compact` 只认开头 | 2d |
| `store/entry.rs`、`session.rs`、`context.rs` | message 条目的 `skills`（SkillText）；用户的原话原样记录；`context::entry_message` 把 Skill 的块放在原话之前；二期日志照常读取 | 2d |
| `compaction.rs`、`skills/kept.rs`、`budget.rs`、`store/jsonl.rs` | 保留与预览用原话；在用的判定读 `skills` | 2d |
| `finx-protocol` 的 `event.rs`、`api.rs` | SkillUse 替换 SkillInvocation，`message_completed` 与 TranscriptItem 带 `skills`；`skills/list {cwd}` 带 `commands` | 2d |
| `skills/catalog.rs` | 说明句加上已有 `<skill>` 块时不必再读的条件（D-89） | 2d |
| `finx-acp`、`finx-server`、`finx-cli` | ACP 去掉原文替换；镜像带 `skills`；命令行的提示行列出加载的 Skill | 2d |
| `packages/client`、`apps/desktop` | 步骤与会话状态带 `skills`；模拟服务支持 `skills/list` 与 `skills`；Lexical 输入框；历史里画标签 | 2d |
| `skills/mod.rs` 的 `roots`、`project_dirs`、`discover` | 项目层只看 `.agents`、`.claude`，跳过主目录；用户层只有 `FINX_HOME/skills`，`other_apps` 时再加两个目录；每个根带默认启用；`opt_in`；不可用的不参与同名；`not_read` 的检查 | 2e |
| `config.rs` | 删除 `skills.dirs`（写了就报错并说明）；新增 `other_apps`、`opt_in`；`opt_in` 跨层拼接 | 2e |
| `skills/install.rs` | `set_enabled` 按默认状态写 `opt_in` 或 `disabled`，并清掉另一个列表；`--project` 的目标改为 `.agents/skills` | 2e |
| `skills/system/skill-creator/SKILL.md` | 给一个仓库用的位置改为 `<project>/.agents/skills/<name>` | 2e |
| `protected.rs` | 去掉 `skills.dirs` 带来的自定义目录名 | 2e |
| `finx-protocol` 的 `api.rs` | SkillEntry 的 `default_enabled`；SkillsListResult 的 `not_read` | 2e |
| `finx-cli` | `finx skills` 末尾的 `not read` 行和 `--all` 的说明；`skills add --project` 的帮助文字 | 2e |
| `apps/desktop`、`packages/client` 的模拟服务 | 默认不启用的技能行的说明；仓库分组的提示文字；不再显示 `.claude`、`.agents` 的来源标记（自定义页方案 §10.4） | 2e |
| 依赖 | 一个 YAML 解析库（§3.3） | 一期 |
| 文档 | 总方案 §1.4、§7.2、§10.2、§11.5、§12、§17、§18、§19 指向本文 | 随各期 |

### 12.3 与并行分支的关系

- **子智能体（feat/agents）**：一期已合入 main（dee7070），本分支在二期开工前合并了 main。
  - 一期只依赖"子会话的系统提示词与父相同"，代码上没有交集。
  - 二期改的 `task.rs`（入队）、`session.rs`（`record_user`）、`compaction.rs` 和 `context.rs`，子智能体都改过：信件、插话，以及压缩时对信件的处理。合并后两边的改动都保留：信件的 `mail` 与用户消息的 `skill` 并列。
  - 给子发任务说明和消息的 `Op::Prompt` 带上 `commands: false`（D-73）；子会话启动时继承父的 Skill 列表。
- **MCP（feat/mcp，方案已定稿，未实现）**：MCP 重写 system_prompt 条目时照抄 `skills`（D-76）；命令表为 MCP 的 prompts 留出位置（MCP 方案 Q-105）。`EntryKind::SystemPrompt` 有了 `skills` 字段，MCP 写新条目时编译器会要求填上它。
- **桌面端（feat/desktop）**：桌面端方案的 P 列表补 P13（§11.4）。
- **其他分支**：一期的改动集中在 `prompt.rs`、`kernel.rs` 的 `build_prompt`、`config.rs` 和 `protected.rs`，合并时可能在 `config.rs` 和总方案上有文本冲突，届时处理。

## 13. 分期实施与验收

### 一期：发现与清单（预估 2–3 天）

**范围**：§3、§4、§5、§6.1、§8、§9 的 system_prompt 字段、§10 的 `[skills]`、§11.1–§11.3。

**验收**：
1. `cargo test --workspace` 全部通过，`cargo clippy --workspace --all-targets` 没有警告。
2. 启动耗时：没有 Skill 时与现在没有可测的差异；25 个 Skill 时增加不超过 1 ms。
3. 真实模型：用 DeepSeek 的 `deepseek-flash`。
   - 在一个临时项目的 `.agents/skills/` 里放一个带脚本和说明文档的 Skill：描述与任务匹配，正文要求先读 `references/rules.md`，再运行 `scripts/gen.sh` 生成文件。
   - `finx exec` 只给任务，不提 Skill。
   - 会话日志显示：模型用 read 读了 SKILL.md，读了说明文档（read 或 bash 的 `cat` 都算，Skill 只说了要读），通过 bash 运行了脚本，产物符合 Skill 的要求。
4. 缓存：同一项目连续开两个会话，第二个会话的第一个请求，缓存命中覆盖到 environment 之前（看 DeepSeek 报告的 cache_read）。

第 3、4 项由 `tools/acceptance/accept_skills.py` 一次完成：它建一个临时项目，Skill 的脚本写出一行只有脚本知道的标记，然后检查会话事件和产物，逐项输出 PASS 或 FAIL。`--layer user` 把 Skill 装到用户目录，在工作区之外；`--keep` 保留项目和会话日志，供事后查看。

### 13.1 一期的实现状态（2026-10-29）

**已完成**：范围内的全部内容，代码落点与 §12 一致。

| 验收项 | 结果 |
|---|---|
| 1. 测试与 clippy | `cargo test --workspace` 共 234 个测试全部通过，其中 Skill 新增 29 个；clippy 没有警告 |
| 2. 启动耗时 | 没有 Skill 时无可测差异；25 个增加 1.0 ms，达到目标（§4.5） |
| 3. 真实模型 | 通过，见下文 |
| 4. 缓存 | 通过：第二个会话的第一个请求，1,600 个输入 token 中 1,408 个命中缓存（88%），整个系统提示词和工具定义都在其中 |

**真实模型验收**（DeepSeek `deepseek-flash`，2026-10-29，bypass-permissions，任务是 "Please prepare this week's status report for the team."，不提 Skill）：
- **项目层 Skill**，跑了两次：
  - 模型都先用 read 读了 SKILL.md（一次用相对路径，一次用绝对路径）。
  - 然后用 bash 一次列出 Skill 目录，并 `cat` 了 `references/format.md` 和 `scripts/gen.sh`。
  - 接着在项目目录下运行 `sh .agents/skills/weekly-report/scripts/gen.sh`，再按 Skill 第 3 步往 report.md 追加了一行摘要。
  - report.md 的第一行是只有脚本知道的标记，表头没有手写。
  - 第一次只过了 4 项：脚本当时只认 read 工具读说明文档。改成 bash 的 `cat` 也算之后，第二次 5 项全过。
- **用户层 Skill**（`--layer user`，在工作区之外），5 项全过：
  - 模型用 read 读了 SKILL.md，再用 read 读了 `references/format.md`，路径是 Skill 目录下的绝对路径。
  - 在项目目录下按绝对路径运行了 Skill 里的脚本。
  - 这说明清单里那句"相对路径相对 SKILL.md 所在的目录"足以让模型找对位置。
  - 第二个会话 1,608 个输入 token 中 1,408 个命中缓存。
- **第二个会话**：问它能用哪些 Skill，它答出了 weekly-report 和用途。

**端到端验证**（模拟模型服务，真实的 `finx` 可执行文件）：
- finx-mock 新增 `skill:NAME` 场景，扮演按清单行事的模型：从系统提示词的清单里找到 NAME 的路径，read SKILL.md，再按正文里反引号中的 `references/…` 和 `scripts/…`，把相对路径拼到 Skill 目录上，依次 read 和用 `sh` 运行。
- `exec_follows_a_skill_from_the_catalog`：manual 模式，Skill 在用户的 `~/.agents/skills`（工作区之外），另有一份内容不同的同名副本在 `~/.claude/skills`。
  - 两次 read 都没有询问，只有运行脚本询问了一次。
  - 脚本写出的 report.md 来自 `~/.agents` 的那份，被遮蔽的副本没有运行。
  - 会话开始时为加载失败的 Skill 发了一次 warning。
  - 日志的 system_prompt 条目里有清单和 `skills`，项目层的 Skill 排在前面。
- `skills_can_be_turned_off_or_disabled`：`-c skills.enabled=false` 时清单消失，也不扫描；`skills.disabled` 停用后，模型找不到这个 Skill。
- `the_skills_command_lists_layers_shadows_and_problems`：`finx skills` 的文本和 JSON、`--all`，以及 `status`、`doctor` 里的 Skill 信息。

**开发机上的实际情况**：`finx skills` 找到 76 个 SKILL.md。生效 39 个，清单约 8,300 token，在 1M 窗口的预算 10,000 之内；被遮蔽 37 个，是 `~/.claude/skills` 里与 `~/.agents/skills` 相同的 24 份副本，加上两个同步账号之间重复的 13 份。

### 二期：显式调用与压缩保留（预估 4 天）

**开工条件**：子智能体（feat/agents）合入 main 之后，从新的 main 开始（§12.3）。已满足。

**范围**：§6.2、§7.2、§9 的其余字段、§11.3–§11.5，决策 D-70、D-71、D-73–D-78。

**步骤**，每步落地并通过测试后再做下一步：
1. **2a 命令表与显式调用**（约 1.5 天）：`Op::Prompt` 的 `commands` 字段；命令表（`/compact`、Skill）；展开与读取失败；message 条目、事件和历史条目的 `skill`；`argument-hint`。
2. **2b 压缩保留**（约 1.5 天）：在用的判定（含 bash）；预算与减半；compaction 条目的 `skills`；新上下文的组成；显式调用的消息只保留 `input`。改的是总方案 §7.6.4 新上下文的组成，摘要仍在最后。
3. **2c 协议与前端**（约 1 天）：`skills/list`；ACP 的 `available_commands_update` 与回放；schema；桌面端 P12。

**验收**：
1. `cargo test --workspace` 全部通过，clippy 没有警告。
2. `/名字 参数` 在 `finx exec`、原生协议、ACP 下结果相同；未知的名字原样发送；`/compact` 在三种入口下都触发压缩；`commands: false` 的消息不展开。
3. 在 Zed 的命令菜单里能看到 Skill 和 `/compact`，选中后正常运行；带 `argument-hint` 的 Skill 显示参数提示。
4. 用模拟模型服务跑一个压缩之后仍要遵守 Skill 的长任务：压缩后的第一个请求里有 Skill 的正文；`finx exec --resume` 之后的上下文与压缩时逐字节相同。
5. 真实模型（DeepSeek）：强制压缩，压缩之后模型仍按 Skill 的要求完成剩下的步骤。由 `tools/acceptance/accept_skills_phase2.py` 完成，它也检查 `/名字`。

### 13.2 二期的实现状态（2026-10-29）

**已完成**：范围内的全部内容，代码落点与 §12 一致。分步提交：2a 命令表与显式调用（989ea72）、2b 压缩保留（8249c9a）、2c `skills/list` 与 ACP 的命令（0cd7c47），按真实验收修正展开块（114bf58），原生协议的端到端测试（d2b9441）。

| 验收项 | 结果 |
|---|---|
| 1. 测试与 clippy | `cargo test --workspace` 共 272 个测试全部通过，二期新增 18 个；再合并 main（e64f113，服务压测与优化）之后共 284 个，全部通过；clippy 没有警告 |
| 2. 各入口一致 | `/名字 参数` 在 `finx exec`、原生协议、ACP 下结果相同：发给模型的是展开后的正文，`skill.input` 是输入的原文；未知的名字原样发送，读取失败发 warning，`commands: false` 不展开；`/compact` 在三种入口下都触发压缩，没有可压缩的内容时也正常结束 |
| 3. Zed 的命令菜单 | 未实测：本机没有安装 Zed。`available_commands_update` 的格式在端到端测试里用官方 schema 类型检查，内容有 `/compact` 和带 `input.hint` 的 Skill |
| 4. 压缩后仍有 Skill 正文 | 通过：模拟模型下，`finx exec --resume` 之后模型看到的上下文里恰好有一份 Skill 正文；内核测试里，恢复后的请求以压缩后的请求为前缀，逐字节相同 |
| 5. 真实模型 | 通过，见下文 |

**真实模型验收**（DeepSeek `deepseek-flash`，2026-10-29，bypass-permissions，`tools/acceptance/accept_skills_phase2.py`，9 项）：
- **`/release-notes 2.4.1`**：这个 Skill 只能由用户调用，不在清单里。RELEASE.md 的第一行是只有 Skill 知道的标记行，日志保留了输入的原文。
  - 第一次运行 8 项通过：模型拿到展开的正文后，仍用 read 读了一遍 SKILL.md。原因是展开块用了清单条目的标记 `<skill name path>`，而清单的说明句要求先 read 这个路径。
  - 展开块去掉 `path`（D-79）后连续运行三次，9 项全过，模型都没有再读 SKILL.md。没有为此增加任何给模型的文字。
- **压缩之后**：模型按清单读了 commit-style，写出的提交信息以 `[ZX9-LOG]` 开头；`/compact` 的 `kept_skills` 是 `["commit-style"]`，compaction 条目里有它的正文；压缩之后再写一条，仍以 `[ZX9-LOG]` 开头。三次运行中，两次压缩后没有再读 SKILL.md，一次照清单的说明又读了一遍，结果都正确。
- 这里用 `/compact` 强制压缩，没有调小窗口：保留 Skill 的逻辑与自动压缩是同一段代码（`compaction::run`）。
- **一期的验收在二期代码上重跑**：项目层、用户层各 5 项全过；第二个会话的第一个请求分别有 94%、88% 的输入 token 命中缓存。
- **合并 main（e64f113）之后**又各跑一次：二期 9 项、一期项目层 5 项全过，缓存命中 89%。

**端到端验证**（模拟模型服务，真实的 `finx` 可执行文件）：
- `exec_runs_a_skill_the_user_invokes`：`/gen-report …` 的正文随消息到达，模型不读 SKILL.md，直接读说明文档、运行脚本；`message_completed` 的 `skill` 记下原文；`finx sessions` 显示的是原文。
- `a_skill_in_use_survives_compaction`：模型用 read 读过的 Skill，`/compact` 保留了它，日志里有正文；之后 `--resume` 的请求里恰好有一份（finx-mock 的 `context` 场景报告上下文里的 `<skill>` 块）。
- `slash_compact_ends_even_with_nothing_to_compact`：新会话里输入 `/compact`，发 warning，不请求模型，`finx exec` 正常退出。
- `acp_announces_commands_and_runs_skills`：`session/new` 和 `session/load` 之后收到命令列表（`/compact`，以及带 `input.hint` 的 Skill）；`/名字` 运行 Skill；`/compact` 正常结束；回放显示输入的原文。
- `skills_list_reports_a_session_and_a_directory`：`cwd` 形式与 `finx skills --all --json` 逐字节相同；会话形式的命令先内置后 Skill，之后新增的 Skill 不出现，改过的描述重新读取；原生协议下 `/名字` 和 `/compact` 的结果与其他入口相同；参数错误和会话不存在的错误码。
- 已有的 ACP 测试改为等待打开会话之后的命令通知再继续，连续运行 8 次结果一致。

### 2d：任意位置提及与桌面端输入框（预估 3.5 天）

**范围**：§6.3，决策 D-82–D-88。

**步骤**，每步落地并通过测试后再做下一步：
1. **内核与协议**（约 1.5 天）：识别规则与共用测试用例；命令表的认定与加载，写法错误名字的 warning；message 条目的 `skills`、上下文的组成、二期日志的读取；事件和历史条目的 `skills`；压缩与在用的判定；`skills/list` 与 ACP 命令里的 `skill:名字`，`skills/list {cwd}` 的 `commands`；ACP 去掉原文替换；命令行提示行列出加载的 Skill；去掉二期内置命令优先的提示；schema 与 TypeScript 类型。
2. **桌面端**（约 2 天）：Lexical 编辑器、SkillNode、菜单、自动识别、导出与导入、按键；历史里画标签；网页调试模式的模拟服务支持 `skills/list` 和 `skills`。

**验收**：
1. `cargo test --workspace` 与桌面端的测试全部通过，clippy 没有警告；共用测试用例在 Rust 和 TypeScript 两边都通过。
2. 同一句"请用 /skill:gen-report 整理本周进展，再按 /skill:commit-style 写提交信息"，在命令行、原生协议、ACP 下加载同样的两个 Skill，历史里画出的标签相同。
3. 不误判：`/gen-report 本周`、`看看 /deploy 接口`、`` `/skill:gen-report` ``、`http://h/skill:gen-report`、`/skill:gen-report.md` 都不加载 Skill；`/skill:gen-reprot` 发 warning。
4. 桌面端（网页调试模式，模拟服务）：开头和句中都能唤起菜单，`a/b`、`10/29` 不唤起；选中得到标签；退格整个删除，撤销能恢复；⇧↩ 换行、⌥↩ 追加发送；粘贴的 `/skill:名字` 变成标签；历史里画出标签。截图记录。中文输入法的组字由用户实际试用确认。
5. 真实模型（DeepSeek）：句中提及一个和两个 Skill，模型都按各自的要求完成，不再去读 SKILL.md。

### 13.3 2d 的实现状态（2026-10-29）

**已完成**：范围内的全部内容，代码落点与 §12 一致。内核与协议先提交（d909256），桌面端、客户端、验收脚本与文档随后提交。

| 验收项 | 结果 |
|---|---|
| 1. 测试 | `cargo test --workspace` 共 455 个测试全部通过；`packages/client` 31 个、桌面端 10 个测试通过，三个包的类型检查通过；共用测试用例（36 条）在 Rust 和 TypeScript 两边都通过。clippy 只剩合并 main 带来的本地模型连接的 5 条提示（finx-connections 4 条、cmd_info.rs 1 条），不在本期改动的代码里 |
| 2. 各入口一致 | 端到端测试里，命令行、原生协议、ACP 各发一条句中提及两个 Skill 的消息：命令行和原生协议的 `message_completed`、历史条目带原话和两个 `skills`，原生协议下 `/compact` 保留了两个；ACP 下模型的上下文里依次有两个 Skill 的块，回放的是原话 |
| 3. 不误判 | `/gen-report 本周`、`看看 /deploy 接口`、`` `/skill:gen-report` ``、`http://h/skill:gen-report`、`/skill:gen-report.md`、`src/skill:lint` 都不加载；`/skill:gen-reprot` 发 warning。共用测试用例还覆盖日期、代码块、全角标点、CRLF |
| 4. 桌面端 | 通过（网页调试模式，模拟服务），见下文。中文输入法的组字由用户实际试用确认 |
| 5. 真实模型 | 通过，见下文 |

**桌面端的验证**（`pnpm --dir apps/desktop web`，模拟服务）：
- 开头输入 `/`：菜单列出 `/compact` 和四个 Skill，带描述和参数提示；输入 `gen` 只剩 gen-report，↩ 插入标签并补一个空格，光标在空格之后；↓ 移动高亮。
- 句中输入 `，再按 /com`：只列 commit-style，没有 `/compact`；点击选中同样插入标签。
- `a/b`、`10/29` 不弹出菜单；`/zzz` 没有匹配，不弹出，↑ 照常把光标移到上一行。
- 标签后退格整个删除，⌘Z 恢复；在标签后紧接着打 `x`，标签退回文字 `/skill:pdf-toolsx`，删掉 `x`、光标离开后又变回标签。
- 手打的 `/skill:pdf-tools ` 变成标签；粘贴 ``请用 /skill:release-notes 2.4.1 写说明，参考 `/skill:gen-report` 和 /skill:nope``，只有 release-notes 变成标签。
- ↩ 发送后输入框清空，对话里的用户消息画出同样的标签，选中复制得到原话。新会话页（`skills/list {cwd}`）同样能唤起菜单。
- 验证中发现并修正：菜单在没有匹配的项时仍处于打开状态（只是不显示），会吞掉 ↑↓ 和 Esc。改为没有匹配时不打开，菜单的按键优先级高于发送。

**真实模型验收**（DeepSeek `deepseek-flash`，2026-10-29，bypass-permissions，`tools/acceptance/accept_skills_phase2.py`，15 项全过）：
- **`/skill:release-notes 2.4.1`**：RELEASE.md 的第一行是只有 Skill 知道的标记行；日志里是原话，`skills` 是 release-notes；模型没有读 SKILL.md。
- **句中提及两个**（`Prepare version 3.0.0: write the notes as /skill:release-notes says, then write a commit message for them to COMMIT_MSG0.txt following /skill:commit-style. Thanks!`）：两个 Skill 按提及的顺序加载，两份产物都符合各自的要求。
  - 第一次运行时模型又用 bash `cat` 了两个 SKILL.md；单独重复 4 次，又有 2 次读了，合计 5 次中 3 次，产物都正确。连不在清单里的 release-notes 也被读了。
  - 原因：清单的说明句无条件要求"任务匹配就先读 SKILL.md"，没有说对话里的 `<skill>` 块就是已经加载的正文。说明句加上这个条件（D-89）后重复 6 次，没有一次再读；整个脚本再跑一次，15 项全过。
- **不是提及的写法**（`/release-notes`、反引号里的 `/skill:release-notes`、`/skill:nope`）：没有加载任何 Skill，`/skill:nope` 发了 warning。
- **压缩**：同二期，模型按清单读 commit-style，`/compact` 保留了它，压缩之后写的提交信息仍按它的格式，没有再读 SKILL.md。
- **一期的验收在 2d 代码上重跑**（说明句改过之后）：项目层、用户层各 5 项全过，模型照常按清单读 SKILL.md；第二个会话的第一个请求分别有 2,176/2,324、2,176/2,320 个输入 token 命中缓存（约 94%）。

### 13.4 2e：技能来源收敛（预估 1 天）

**范围**：§4.1、§4.2、§4.4、§8.3、§10、§11.1、§11.4 的 2e 部分，以及自定义页方案里对应的界面（自定义页方案 §9.3、§10.4）。

**一次改完**：内核是唯一的真相，命令行、原生协议、ACP 和桌面端都从内核拿结果，所以一起改、一起合入：
- 内核改了而桌面端没改：页面仍能用，只是默认不启用的技能显示成"你停用的"，开关也照样有效（`skills/set_enabled` 的接口不变）。
- 桌面端先改而内核没改：拿不到 `default_enabled`，按"默认启用"处理，与现在相同。
- 所以两边各自先合入都不会坏，但只有一起改，界面上的说法才对。

**验收**：
1. `cargo test --workspace` 全部通过，`cargo clippy --workspace --all-targets` 没有警告；桌面端 `typecheck`、单元测试和 `e2e/customize.mjs` 通过。
2. 开发机上 `finx skills`（cwd 为 finxwork）：清单里没有来自 `~/.agents`、`~/.claude` 的 Skill，末尾有 `not read` 行；`skills.other_apps = true` 时恢复成改之前的 39 个。
3. 临时项目里放 `.agents/skills/a`、`.claude/skills/b`、`.finx/skills/c`：清单里只有 a；`--all` 里 b 是默认不启用，c 不出现；`finx skills enable .claude/skills/b` 之后 b 进清单，`~/.finx/config.toml` 的 `opt_in` 里是 b 的绝对路径；再 `disable` 就删掉这一条。
4. 把主目录当 cwd：`~/.agents/skills` 里的 Skill 不进清单。
5. 配置里写了 `skills.dirs`：报错，说明改用什么。
6. 桌面端：仓库分组里 `.claude` 的技能显示"默认不启用"，打开、关掉都在 2 秒内反映到列表；个人分组没有其他应用的技能。

**实现状态（2026-10-31）**：已实现，未提交。
- **内核**：
  - `skills/mod.rs` 的每个根带默认是否启用；项目层只看 `.agents`、`.claude`，并跳过主目录；`other_apps` 打开时用户层多两个根；默认不启用的不参与同名；`not_read` 只读一次目录。
  - 判断默认状态的 `on_by_default` 供开关使用，与发现的规则一致。
  - `config.rs` 写了 `skills.dirs` 就报错并说明改用什么；`opt_in` 里出现名字是配置错误；`opt_in` 与 `disabled` 都跨层拼接，项目配置里的相对路径按项目根解析。
  - 受保护路径不再带自定义目录名（`SessionView::skill_dirs` 删除）。
  - `finx skills add --project`、`skills/install {scope: "project"}`、skill-creator 都改为 `.agents/skills`。
- **协议**：`default_enabled` 总是输出；`not_read` 为空时省略。schema 与 TypeScript 类型已重新生成。
- **验收**：
  - Rust 全部测试通过（547 个）；clippy 只剩 main 原有的 finx-connections 和 `cmd_info.rs:279`。
  - client 36 个、desktop 25 个测试通过，typecheck 通过。
  - 第 2 项：开发机上 `finx skills` 只剩内置的 skill-creator，末尾是 `not read: ~/.agents/skills, ~/.claude/skills (skills.other_apps is off)`。
  - 第 3–5 项写进了 `e2e_skills` 与 `finx-core/src/skills` 的单元测试；`e2e_customize` 增加 `.claude` 技能经 `skills/set_enabled` 打开、写进 `opt_in`、进入清单。
  - 第 6 项在网页调试模式下用模拟数据验证：行内"来自 .claude""默认不启用"、分组提示、打开后的提示、详情页的说明。`e2e/customize.mjs` 是无项目的页面，看不到项目层，没有为此扩展。

### 三期：扩展（暂不预估）

会话中途更新清单（Q-60）、内置 Skill（Q-61）、`allowed-tools`（Q-62）、占位符（Q-63）、按路径激活（Q-66）、Skill 的安装与更新命令。

## 14. 测试

一期的测试在 `finx-core/src/skills/` 的单元测试（遍历、优先级、解析、清单）、`config.rs` 与 `protected.rs` 的单元测试、`finx-core/tests/skills.rs`（内核与权限）、`finx-cli/tests/e2e_skills.rs`（端到端）和 finx-mock 的单元测试里。

| 范围 | 内容 |
|---|---|
| 遍历 | 嵌套的 Skill；找到就停（Skill 的 assets 里的 SKILL.md 不算）；根本身是 Skill；跳过点目录和 node_modules；深度和目录数的上限；符号链接与环；按真实路径去重；根不存在、没有权限 |
| 优先级 | 项目层由近到远、用户层、额外路径；同一级 `.agents` 先于 `.claude`（2e 之前是 `dirs` 的顺序）；同一个根里的同名；按名字停用（包括被遮蔽的）；按路径停用后由下一个候选补上 |
| 解析 | 折叠块和字面块；引号；冒号修复；BOM 和 CRLF；没有头部、头部没有结束行；description 缺失或不是字符串；name 缺省取目录名；超长截断 |
| 清单 | 转义；顺序稳定（打乱目录读取顺序，结果不变）；没有 Skill 时整段省略；read、bash 的两种说明；预算的统一截短和整条去掉；warning |
| 内核 | 系统提示词的段落顺序；冻结（resume 不重新扫描）；没有 read 和 bash 时不出清单。子会话的清单与父相同，等子智能体合入后补测 |
| 权限 | manual 下 read SKILL.md 不询问；运行 Skill 里的脚本询问；写 `.claude/skills` 和 `skills.paths` 下的文件询问 |
| 端到端 | finx-mock 扮演模型：按系统提示词里的路径 read SKILL.md，read 说明文档，用 bash 运行脚本 |
| 隔离 | 测试辅助代码把 `HOME` 指向临时目录，启动 `finx` 进程的端到端测试也一样，避免读到开发机上的 `~/.agents/skills` 等目录；已有的请求体快照、缓存测试和压测不受影响 |
| 基准 | `tools/bench/bench_startup.py --skills 0 25 80 200`，可与旧版本的可执行文件交替比较 |
| 真实模型 | `tools/acceptance/accept_skills.py`（§13） |
| 命令表（二期） | `commands.rs` 的单元测试：展开与参数、其他内容保留、内置命令优先、不是命令的文字、读取失败、截断；菜单的顺序与按文件现在的内容描述 |
| 压缩保留（二期） | `skills/kept.rs` 的单元测试：显式调用、read、bash 的 `cat` 都算，失败和只提到路径的不算，从新到旧，上次保留的排最后；重新读取、文件删除后沿用副本、超过 5,000 token 截断；按预算选取。`context.rs`：新上下文里 Skill 在保留的消息和摘要之间 |
| 内核（二期） | `finx-core/tests/skills.rs`：`/名字` 展开并记下原文；只解析用户的输入；`/compact` 作为任务运行；中断时排队的消息按原文退回；压缩保留在用的 Skill、恢复后上下文不变、再次压缩时读新版本或沿用副本 |
| 端到端（二期） | `e2e_skills`（exec）、`e2e_native`（`skills/list` 与 `/名字`）、`e2e_acp`（命令通知、`/名字`、`/compact`、回放），见 §13.2 |
| 真实模型（二期） | `tools/acceptance/accept_skills_phase2.py`（§13.2） |
| 识别规则（2d） | `crates/finx-core/testdata/mentions.json` 的 36 条用例；`commands.rs` 的单元测试和 `packages/client/src/mentions.test.ts` 都读它 |
| 命令表（2d） | `commands.rs`：按出现的顺序各加载一次、原话不变、内嵌资源不看；`/compact` 只认开头；写错名字和读取失败的 warning；菜单只列可以提及的 Skill；超长正文裁切 |
| 内核（2d） | `finx-core/tests/skills.rs`：任意位置的提及各加载一次并保留原话；只认用户自己输入里明确的提及；压缩保留、排队退回都用 `/skill:名字`。`context.rs`：Skill 的块在原话之前，二期日志照常读取 |
| 端到端（2d） | `e2e_skills`（句中两个提及与不算的写法、写错名字）、`e2e_native`（一条消息两个提及、历史条目的 `skills`、压缩保留两个）、`e2e_acp`（命令名 `skill:名字`、句中两个提及、回放原话） |
| 桌面端（2d） | 共用测试用例；网页调试模式下逐项验证（§13.3） |
| 真实模型（2d） | `tools/acceptance/accept_skills_phase2.py` 增加句中两个提及、不是提及的写法两组（§13.3） |
| 发现（2e） | `skills/mod.rs`：项目层只看 `.agents`、`.claude`，不看 `.finx`；`.claude` 默认不启用；跳过主目录（cwd 为主目录、主目录是 git 仓库两种）；用户层默认只有 `FINX_HOME/skills`，`other_apps` 时三个；`opt_in` 按路径打开、写名字报错；`opt_in` 与 `disabled` 同时命中按停用；不可用的不遮蔽同名；`not_read` 只在目录有子目录时出现。改写原来默认读 `~/.agents`、项目 `.finx` 的用例 |
| 配置（2e） | `config.rs`：`skills.dirs` 报错的文字；`other_apps`、`opt_in` 的默认值；`opt_in` 跨层拼接 |
| 开关（2e） | `install.rs`：两种默认状态各自打开、关掉，配置的写入与清理；按名字停用照旧 |
| 端到端（2e） | `e2e_skills`：§13.4 的第 3–5 项；`e2e_native`：`skills/list` 的 `default_enabled`、`not_read` 和 `skills/set_enabled` 写 `opt_in`；桌面端 `e2e/customize.mjs` 增加 `.claude` 技能的打开与关掉 |

## 15. 备选方案与取舍

| 方案 | 为什么不选 |
|---|---|
| 专门的激活工具，例如 `activate_skill(name)` | 需求明确不加工具；read 已经够用；把清单放进工具描述，工具定义就会随 Skill 变化 |
| 用户层优先于项目层：仓库不能替换用户自己的 Skill | 与配置分层相反，团队约定在仓库里反而不生效；finx 的 Skill 不能放宽权限，遮蔽的风险有限。保留为 Q-64 的可选项 |
| 同名的都保留、都列出 | 模型要在两个同名的 Skill 之间猜；显式调用的名字有歧义 |
| 嵌套目录里的同名 Skill 加上路径前缀，全部加载 | 规则复杂，眼下没有需要（Q-66） |
| 每个字段一个子元素的 XML 写法 | 信息相同，每条多约 15 个 token |
| 用别名缩短清单里的路径 | 模型要先把别名展开，容易出错；绝对路径可以直接交给 read |
| 清单放在第一条用户消息里 | 效果与冻结的系统提示词相同，但能力说明被拆散了，压缩后还要重新放一遍 |
| 由内核根据用户消息的关键词挑选 Skill | 不如模型判断准确，还增加内核逻辑 |
| 未受信任的项目不加载项目层 Skill | 与 AGENTS.md 的处理不一致；克隆下来的仓库附带的 Skill 往往正是用户想用的。保留为 Q-64 的可选项 |
| 每次请求前重新扫描，清单一变就改系统提示词 | 改写前缀，缓存失效（G4） |
| 压缩时不保留 Skill，只靠摘要 | 长任务压缩后会偏离 Skill；一期暂时如此，二期补上（§7.2） |
| 项目里继续读 `.finx/skills`（2e） | 等于另立一个目录标准；仓库里本来就有 `.agents/skills`，团队不必为 finx 再放一份 |
| 用户层默认读 `~/.agents/skills`，因为它是规范的共享位置（2e） | 任何工具都可能往里装，没有人替 finx 挑选；开发机上那里的 Skill 与 finx 无关，却占了清单的大半 |
| 其他应用的 Skill 在"发现"里逐个添加，启用后原地引用（2e） | 多一个来源的概念和一组界面，用户要的只是"默认不读、需要时打开"；以后真有需要，再由设置页的开关扩展（Q-69） |
| `.claude` 的 Skill 也默认启用（2e） | 是另一个应用的目录，里面的 Skill 常依赖那个应用自己的工具；默认不启用，列出来让用户自己打开，成本只有一次点击 |
| `opt_in` 也收名字（2e） | 写一个名字就会打开所有仓库里同名的 Skill，范围太大 |
| 保留 `skills.dirs`（2e） | 读哪几个目录已经固定，多一个配置就多一组要测的组合；要读别的目录可以写进 `skills.paths` |

## 16. 决策与待定问题

### 16.1 决策

| 编号 | 决策 | 理由 | 章节 |
|---|---|---|---|
| D-60 | Skill 遵循 Agent Skills 开放规范；不增加工具，系统提示词里列出清单，模型用 read 读取 SKILL.md，再按需读同目录的文件、用 bash 运行脚本 | 兼容现有的 Skill；不增加工具；只有用到时才占上下文 | §3 §6.1 |
| D-61 | 三层位置：项目层（cwd 到项目根的每一级）、用户层、额外路径；每层依次查找 `skills.dirs` 列出的目录，默认 `.finx`、`.agents`、`.claude`。**2e 由 D-170–D-173 取代** | finx 自己的位置、跨客户端的共享位置、现有 Skill 最多的位置都能用；与 AGENTS.md 的目录链一致 | §4.1 |
| D-62 | 同名时先找到的生效：项目层由近到远，然后用户层，最后额外路径；同一位置 `.agents` 先于 `.claude`（2e 之前按 `dirs` 的顺序）。被遮蔽的不进清单，不发 warning；同一个文件只算一次 | 越具体越优先，与配置分层一致，也是各实现通行的约定；结果确定，可以查询 | §4.2 |
| D-63 | 有 SKILL.md 的目录就是一个 Skill，找到就不再往下；跳过点目录和 node_modules；跟随目录链接并防环；每个根最多 6 层、2,000 个目录 | 不把 Skill 自带的模板当成 Skill；扫描量有上限 | §4.3 |
| D-64 | 宽松解析：用真正的 YAML 解析，失败时修复冒号再试；description 必填，name 缺省取目录名；不符合规范只记诊断；只使用 name、description、disable-model-invocation，其他字段忽略 | 现成的 Skill 写法不一，只要能用就加载；字段越少，行为越可预测 | §3 |
| D-65 | 清单放在系统提示词里，指令段之后、environment 之前，随系统提示词冻结 | 会话内前缀不变；environment 变化最频繁，留在最后，跨会话的前缀缓存能命中更长 | §5.1 |
| D-66 | 清单格式：`<available_skills>` 里一句固定说明，每个 Skill 一行 `<skill name path>描述</skill>`；路径为 SKILL.md 的绝对路径；没有可用的 Skill 时整段省略 | 结构清楚又省 token；路径可以直接交给 read，也说明了 Skill 所在的目录；固定文本对缓存友好 | §5.2 §5.3 |
| D-67 | 清单的预算为 `min(2% × 上下文窗口, 10,000)` token，单条描述不超过 1,024 个字符；超出时统一截短描述，再从优先级最低的开始整条去掉，并发 warning | 装了很多 Skill 也不会挤占上下文；统一截短，保证每个 Skill 都留有关键词 | §5.4 |
| D-68 | 项目层 Skill 与 AGENTS.md 一样，不受项目信任状态影响；Skill 不能放宽任何权限判定，`allowed-tools` 不生效 | Skill 只是文本和文件，执行仍要审批；安全边界不变 | §8.4 |
| D-69 | `.claude` 目录和 `skills.paths` 中的目录列入受保护路径 | 写进 Skill 目录的内容会成为以后每个会话的指令 | §8.3 |
| D-70 | 用户消息以 `/名字` 开头时，内核把 SKILL.md 的正文展开进这条消息，记下用户输入的原文；ACP 用 `available_commands_update` 公布；内置命令优先（二期） | 用户可以不等模型判断，直接使用 Skill；各前端共用一套实现 | §6.2 |
| D-71 | 压缩时重新附上在用的 Skill：从历史中找出用户调用过或模型读过的 SKILL.md，按最近使用的顺序附上当前的正文，每个不超过 5,000 token，合计不超过 `min(20,000, 10% × 硬上限)`；副本写进 compaction 条目（二期） | 长任务压缩后仍然遵守 Skill；可以从日志完整重建 | §7.2 |
| D-72 | 子智能体使用与父相同的系统提示词，因此拥有同一份清单；父写给子的任务说明不展开 `/名字` | 不需要额外的机制；显式调用只属于用户 | §11.3 |
| D-73 | `Op::Prompt` 新增可选字段 `commands`（默认 true）：前端的用户输入解析命令，智能体之间的消息设为 false，不解析（二期） | 子智能体的任务说明和消息也走 `Op::Prompt`，只有用户的话才是命令；字段可选，旧客户端不受影响 | §6.2 §11.3 |
| D-74 | 以 `/` 开头的用户输入由内核统一解析：先查内置命令（`/compact`），再查 Skill，以后加 MCP 的 prompts；找不到就原样发送；`available_commands_update` 和 `/` 菜单都从这张表生成（二期） | 所有前端行为一致，不在 ACP 层另写一套；内置命令只有几个，冲突时内置优先 | §6.2 §11.5 |
| D-75 | 压缩时判断"在用"，除了 read，bash 里读 SKILL.md 的命令也算（二期） | 真实模型读 Skill 里的文件时用过 `cat`；漏判的代价是压缩后偏离 Skill，多判一个只多占几千 token | §7.2 |
| D-76 | Skill 列表取最近一条带 `skills` 的 system_prompt 条目；其他功能重写这个条目时照抄 `skills` | MCP 会在工具集合变化时重写 system_prompt 条目；约定好之后，名字解析与模型看到的清单始终一致 | §6.2 §9 |
| D-77 | 读取头部的 `argument-hint`，作为 ACP 命令的 `input.hint` 和 `/` 菜单里的参数提示；其他扩展字段仍然忽略（二期） | 现成的 Skill 里有人写；编辑器的命令定义里正好有这一项；成本很低 | §3.2 §6.2 |
| D-78 | 二期不升协议版本：只新增可选字段（`Op::Prompt` 的 `commands`、用户消息的 `skill`）和方法（`skills/list`），重新生成 schema | 与协议方案的做法一致：增量修改，旧客户端忽略新字段即可 | §11.4 |
| D-79 | 显式调用的展开块（以及压缩后保留的块）只写 Skill 的名字和相对路径的起点，不写 SKILL.md 的路径；正文被截断时，省略说明里给出路径 | 真实验收里，带 `path` 的块被模型当成清单条目又读了一遍，正文重复、多一次往返；改正标记即可，不需要加一句"不要再读"之类的提示 | §6.2 附录 A.2 |
| D-80 | `skills/list` 的会话形式：名字、路径、层和能否由模型调用按会话启动时的记录，描述、`argument-hint` 按文件现在的内容读取；描述不存进会话状态和日志 | 菜单显示的就是 `/名字` 会展开的内容；每个会话不多占内存，日志也不变大 | §11.4 |
| D-81 | ACP 的 `available_commands_update` 在打开会话的应答之后发送，借会话 hub 的命令顺序保证；每次打开都发，至少有内置命令 | 客户端在知道会话之前收到的通知可能被丢掉；顺序由现有的 hub 保证，不加新的同步机制 | §11.5 |
| D-82 | Skill 的提及写成 `/skill:名字`，可以出现在用户文字的任意位置，一条消息可以有多个；二期的 `/名字` 不再表示 Skill；内置命令仍是不带命名空间、只在开头的 `/compact`（2d） | 普通的 `/名字` 本身就是合法的路径，任何边界规则都只能减少、不能消除误判；有了命名空间，内核不必从普通的词里猜，Skill 也不会与内置命令、MCP 的 prompts 重名；菜单按名字模糊匹配，不增加输入的负担 | §6.3.1 |
| D-83 | 用户的话原样记录；Skill 的正文作为单独的文字项放在前面，记在 message 条目的 `skills`；事件和历史带原话与 `skills: [{name, path}]`，替换二期的 `skill`（2d） | 所有前端直接显示原话，压缩时保留原话，不再有"展开后的文字"这一层；二期的字段还没有客户端用过 | §6.3.4 |
| D-84 | 意图只由文字表达：`Op::Prompt` 不增加标记字段，桌面端的标签在文字里就是 `/skill:名字`（2d） | 复制、粘贴、中断退回、换一个入口重发，意思都不变；协议更小，内核不需要校验客户端给的标记 | §6.3.5 |
| D-85 | 识别规则只有一套：内核按它认定和加载，桌面端按它画标签；两边共用一份测试用例（2d） | 各入口行为一致；维护的只有一套规则 | §6.3.2 |
| D-86 | 反引号里的不算提及，这是所有入口通用的转义；写法正确但名字不存在时发 warning（2d） | 写技术内容时字面的写法本来就放在反引号里；带命名空间的写法写错了名字，多半是笔误，应当告诉用户 | §6.3.2 |
| D-87 | ACP 内嵌资源的文字不参与识别（2d） | 附件里的内容不是用户的话 | §6.3.2 |
| D-88 | 桌面端输入框用 Lexical：纯文本模式、typeahead、整体选中和删除的标签节点，固定版本（2d） | 任意位置的原子标签、输入法、撤销、粘贴都有成熟实现；以后的 `@文件`、长段粘贴折叠用同一套机制；自己写 contenteditable 的维护成本高 | §6.3.7 |
| D-89 | 清单的说明句加上条件：对话里已经有某个 Skill 的 `<skill>` 块时，不必再读它的 SKILL.md（2d） | 真实验收里，句中提及两个 Skill 时 5 次有 3 次又读了 SKILL.md：说明句无条件要求先读，却没有说 `<skill>` 块就是已经加载的正文。补上条件后 6 次都没有再读；压缩后保留的块同样适用。这是给原有的要求补上适用范围，不是禁止 | §5.2 附录 A.1 |
| D-170 | 项目层用共享标准：各级的 `.agents/skills` 默认启用，`.claude/skills` 列出但默认不启用；不读项目里的 `.finx/skills`，不做兼容读取。`.finx` 只放 finx 独有、没有共享标准的东西（2e） | 与规则用 `AGENTS.md`、MCP 读 `.mcp.json` 一致；仓库不必为 finx 另放一份；finx 未发布，没有要迁移的用户 | §1.2 §4.1 |
| D-171 | 用户层只读 `FINX_HOME/skills`；`~/.agents/skills`、`~/.claude/skills` 由 `skills.other_apps`（默认 false）打开，读进来的默认启用（2e） | 用户级的共享目录谁都能写，没有人替 finx 挑选；开发机上 39 个生效的 Skill 全部来自其他应用，清单约 8,300 token。打开开关表示用户信任这两个目录，所以照旧启用。解决 Q-68 | §4.1 §10 |
| D-172 | 项目层从 cwd 往上找时跳过主目录本身（2e） | 否则主目录作为工作目录、或者主目录本身是 git 仓库时，`~/.agents/skills` 会作为项目层读进来，绕过 D-171 | §4.1 |
| D-173 | 默认是否启用只由位置决定：`FINX_HOME/skills`、内置、`skills.paths`、项目层的 `.agents/skills` 启用，项目层的 `.claude/skills` 不启用；用户打开的记在 `skills.opt_in`，只收路径；与 `disabled` 都跨层拼接，同时命中按停用（2e） | 一条规则就能说清；放进 finx 自己的目录、仓库的共享目录、配置里的路径就算用户同意了；`disabled` 表达不了"打开一个默认关着的"，所以另设列表；只收路径，免得一个名字打开所有仓库里的同名 Skill | §4.1 §4.4 §10 |
| D-174 | 不可用的 Skill（默认不启用而没有打开的、按路径停用的）不参与同名先到先得（2e） | 关着的 Skill 不应该挡住别的；与按路径停用的现有行为一致 | §4.2 |
| D-175 | `skills/set_enabled` 和 `finx skills enable/disable <路径>` 的接口不变，按 Skill 的默认状态写 `opt_in` 或 `disabled`，都写用户配置，并清掉另一个列表里指向它的路径（2e） | 页面和命令行只有一个开关，不必知道背后是哪个列表；个人的选择不改仓库；配置里不留矛盾的记录 | §4.4 |
| D-176 | 删除 `skills.dirs`；配置里写了就报错并说明改用什么；受保护的目录名固定为 `.finx`、`.agents`、`.claude`（2e） | 读哪几个目录已经固定，少一个配置就少一组要测的组合；要读别的目录可以用 `skills.paths`；严格校验与其他未知的键一致 | §8.3 §10 |
| D-177 | SkillEntry 新增 `default_enabled`，SkillsListResult 新增可选的 `not_read`；协议版本不变。`finx skills` 在其他应用的目录里确实有东西却没有读时，末尾多一行说明；桌面端不显示这一行（2e） | 页面要区分"默认不启用"和"你停用的"；用过别的工具的人要知道 Skill 为什么不在，又不让页面变乱 | §11.1 §11.4 |

### 16.2 待定问题

| 编号 | 问题 | 当前假设 | 章节 |
|---|---|---|---|
| Q-60 | 会话进行中新增、修改的 Skill 如何生效 | 下一个会话生效。以后可以在任务开始前重新扫描，有变化时追加一条说明新增和删除了哪些 Skill 的消息，只追加，不改写前缀；或者随 `--refresh-instructions` 一起重新生成系统提示词 | §5.1 §7.1 |
| Q-61 | 是否内置 Skill，例如教模型编写 Skill 的那一类 | 暂不。需要时编译进可执行文件，首次运行时写到 `FINX_HOME/skills/.builtin`，按内容的指纹判断是否更新 | §1.3 |
| Q-62 | 是否支持 `allowed-tools` | 暂不。以后支持时，只对用户层和受信任的项目生效；只在调用它的那个任务里有效；只能放行命令规则能表达的前缀 | §3.2 §8.4 |
| Q-63 | 显式调用是否替换 `$ARGUMENTS` 一类的占位符 | 暂不，参数附在 `<skill>` 块后面。模型看到正文里的占位符和后面的参数，能自己对应。开发机上的 76 个 SKILL.md 没有一个用占位符（2026-10-29） | §6.2 |
| Q-64 | 用户更看重"仓库不能替换自己的 Skill"时怎么办 | 维持 D-62，项目层优先。可选做法：项目未受信任时，项目层的 Skill 不能遮蔽用户层的同名 Skill（改为不加载并提示）；或者未受信任时完全不加载项目层 Skill | §4.2 §8.4 |
| Q-65 | 扫描时是否遵守 `.gitignore` | 暂不，靠深度和目录数的上限 | §4.3 |
| Q-66 | 是否支持按文件路径激活、嵌套目录里同名 Skill 的命名空间、cwd 以下子目录里的 Skill | 暂不，等 monorepo 的实际需求 | §4.1 §15 |
| Q-67 | 清单超出预算时，是否按使用频率决定保留谁的描述 | 暂不。需要跨会话统计使用次数，清单就不再只取决于文件，同一组 Skill 生成的文本会变 | §5.4 |
| Q-68 | 是否默认跳过其他客户端按账号同步下来的目录，例如 `~/.claude/skills/synced` | 已定（D-171）：用户层的 `~/.claude/skills` 整个默认不读，同步目录随之不读；`other_apps` 打开时照常读 | §4.1 |
| Q-69 | `other_apps` 以后怎样放进界面：一个总开关，还是按目录分开；打开后读进来的是默认启用还是默认不启用 | 做设置页时再定。眼下只在配置里，打开时默认启用（D-171） | §4.1 §10 |

## 附录 A：给模型的文本

发给模型的文本使用英文（总方案 D-16），全部是固定文本。

### A.1 清单的说明句

read 启用时：

```
The following skills provide specialized instructions for specific tasks. When a task matches a skill's description, read its SKILL.md with the read tool before acting, unless the conversation already has its instructions in a <skill> block. Resolve relative paths in a skill against the directory that contains its SKILL.md.
```

read 没有启用、bash 启用时，把 `with the read tool` 换成 `with bash`。

### A.2 提及的 Skill 的块（2d）

```
<skill name="{name}">
Relative paths in this skill are relative to {Skill 目录的绝对路径}.

{去掉头部的正文}
</skill>
```

每个提及的 Skill 一个块，各是一项文字，按提及的顺序放在用户的原话之前（§6.3.4）。块里没有 SKILL.md 的路径（D-79）。二期的块后面接着参数，现在参数就在原话里。

### A.3 压缩后的在用 Skill（二期）

```
These skills were in use before the conversation was compacted.

<skill name="{name}">
Relative paths in this skill are relative to {dir}.

{正文，可能在尾部截断}
</skill>
```

多个 Skill 时，各个块之间空一行，最近用过的在前。正文被截断时（A.2 与 A.3 相同），正文末尾加一行：

```
[Truncated. Read {SKILL.md 的绝对路径} for the rest.]
```

### A.4 warning

warning 发给用户，与现有的 warning 一样用英文：

| 情况 | 文本 |
|---|---|
| 加载失败 | `skill at {path} was not loaded: {reason}` |
| 扫描达到上限 | `stopped scanning {root} after {n} directories; some skills may be missing` |
| 根目录无法读取 | `cannot read skills directory {root}: {error}` |
| 超出预算，截短描述 | `skill descriptions were shortened to {n} characters to fit the {budget}-token catalog budget; raise skills.max_catalog_tokens or disable unused skills` |
| 超出预算，去掉条目 | `{n} skills were left out of the catalog to fit the {budget}-token budget: {names}` |
| 提及的 Skill 读取失败（2d） | `cannot read skill '{name}' at {path}: {error}; "/skill:{name}" was sent as text` |
| 写法正确，但没有这个名字（2d） | `no skill named '{name}'; "/skill:{name}" was sent as text` |
| `/compact` 时没有可压缩的内容（二期） | `nothing to compact` |
| 有任务在运行时输入 `/compact`（二期） | `a task is running; compact after it ends` |

## 附录 B：示例

### B.1 目录与清单

```
/work/repo                          （项目根，有 .git）
├── .agents/skills/
│   ├── release/SKILL.md            description: Cut a release ...
│   └── commit/SKILL.md             description: Commit using the repo convention ...
├── .claude/skills/
│   └── deploy/SKILL.md             description: Deploy to staging ...
└── packages/web                    （cwd）
    └── .agents/skills/
        └── release/SKILL.md        description: Release the web package ...

~/.finx/skills/
├── commit/SKILL.md                 description: Write commit messages ...
└── deploy/SKILL.md                 description: My own deploy ...
~/.agents/skills/
└── pdf-tools/SKILL.md              description: Extract text and tables ...
```

结果（`other_apps` 关着，`opt_in` 为空）：

| Skill | 生效的位置 | 没有生效的 |
|---|---|---|
| release | `packages/web/.agents/skills/release` | `/work/repo/.agents/skills/release`（被遮蔽） |
| commit | `/work/repo/.agents/skills/commit` | `~/.finx/skills/commit`（被遮蔽） |
| deploy | `~/.finx/skills/deploy` | `/work/repo/.claude/skills/deploy`（默认不启用，不遮蔽别的） |
| pdf-tools | — | `~/.agents/skills` 没有读；`finx skills` 末尾的 `not read` 行列出它 |

用户执行 `finx skills enable /work/repo/.claude/skills/deploy` 之后，`opt_in` 里多一条，deploy 改由仓库那份生效，`~/.finx/skills/deploy` 被遮蔽。

清单（描述从略）：

```
<available_skills>
The following skills provide specialized instructions for specific tasks. When a task matches a skill's description, read its SKILL.md with the read tool before acting, unless the conversation already has its instructions in a <skill> block. Resolve relative paths in a skill against the directory that contains its SKILL.md.
<skill name="release" path="/work/repo/packages/web/.agents/skills/release/SKILL.md">Release the web package ...</skill>
<skill name="commit" path="/work/repo/.agents/skills/commit/SKILL.md">Commit using the repo convention ...</skill>
<skill name="deploy" path="/Users/me/.finx/skills/deploy/SKILL.md">My own deploy ...</skill>
</available_skills>
```

### B.2 显式调用（二期）

用户输入：

```
/pdf-tools extract report.pdf
```

写进历史的用户消息：

```
<skill name="pdf-tools">
Relative paths in this skill are relative to /Users/me/.finx/skills/pdf-tools.

# PDF tools

Read `references/formats.md` before converting a document. Run `scripts/extract.py <file>`
to get the text.
</skill>

extract report.pdf
```

日志条目附带 `"skill": {"name": "pdf-tools", "path": "/Users/me/.finx/skills/pdf-tools/SKILL.md", "input": "/pdf-tools extract report.pdf"}`，界面显示用户输入的原文。
