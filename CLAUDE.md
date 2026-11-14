# 与 DeepSeek Harness 代理协作（DSH Lead）

本工作目录（`/Users/eliseo/FinxWork`）同时被 DeepSeek Harness 中的编码代理（下称「DSH Lead」）访问。你们共享同一个文件系统。**任何需要实际执行（写代码、跑命令、改文件、验证测试）的任务，你都可以通过本任务板委托给 DSH Lead 执行。**

任务板位于 `tasks/`：

```
tasks/
├── open/     # 待执行：你在这里创建任务
└── done/     # 已完成：DSH Lead 执行后把任务移到这里并追加结果
```

## 你（Claude）如何下发任务

1. 在 `tasks/open/` 下创建一个 Markdown 文件，命名 `TASK-<简短 slug>.md`（如 `TASK-fix-login-retry.md`）。
2. 文件必须包含以下结构（Front matter + 正文）：

```markdown
---
id: TASK-<同文件名>
title: 一句话标题
created: 2026-11-13T23:08:00+08:00
write-scope: 建议修改的文件/目录（如 crates/auth/）
priority: high | normal | low
---

## 目标
要达到什么结果，验收标准是什么。

## 背景
必要的上下文：相关文件、已有讨论、已知约束。
（只写给执行者需要知道的信息，DSH Lead 不共享你的会话上下文。）

## 要求
- 具体步骤或期望方案（可选，可留白让执行者自行判断）
- 需要运行的验证命令（如 `pnpm test`、`cargo check`）
```

3. **任务文件必须自包含**：DSH Lead 看不到你的对话历史，所有信息都要写进文件里。
4. 一次可以下发多个任务；如果任务之间有顺序依赖，在文件里注明「先执行 TASK-xxx」。

## 如何查看结果

- DSH Lead 执行完会把文件移动到 `tasks/done/<原文件名>`，并在文件末尾追加：
  - `## 执行结果`：改了什么、验证输出摘要
  - `## 状态`：`completed` / `blocked`（blocked 会附原因和需要的补充信息）
- 若任务信息不足无法执行，文件同样会被移到 `done/` 并标注 `blocked`，补充信息后你可以把文件移回 `open/` 继续推进。
- 不要在 DSH Lead 执行期间编辑 `tasks/open/` 中同一文件；新想法请新建文件。

## 约定

- DSH Lead **只在有人下发任务时执行**；它不会自动扫描你的会话。
- 修改代码请遵循仓库根目录 `AGENT.md` 的编码原则。
- 冲突规避：`write-scope` 写明预期改动范围，便于双方避开同文件并发编辑。
- 本文件（CLAUDE.md）改动需与 DSH Lead 协商一致。
