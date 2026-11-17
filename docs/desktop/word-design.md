# Word 文档：查看、编辑与文档内 AI

状态：实施中 · 2026-11-07 · 分支 `feat/word`（从 `feat/document-editor` 切出，见 §11-1）
关系：沿用 [document-editor-design.md](document-editor-design.md) 的外壳、"状态跟着文件"，以及其 §10 对 Word 的约束；
内核持有与副本同步照 [presentation-kernel-authority.md](presentation-kernel-authority.md)；智能体编辑、撤销、审批照
[presentation-deck-edit.md](presentation-deck-edit.md)。PPT 那份文档说"以后要建议模式，按 Google Docs 的方式做进文档本身"，
Word 就是这样做的（§5）。

## 0. 结论先行

- **引擎**：NimbleOffice 的 DOCX 部分。界面用 npm 上的 `@nimbleoffice/docx`、`@nimbleoffice/docx-react`、`@nimbleoffice/docx-i18n`
  0.5.1（fork 自 0.5.1 以来没有动 docx，不用发 fork release）。内核用同一 fork 的 Rust crate（`docx-edit` 的
  `EditSessionCore`、`nimbleoffice-docx` 的渲染），git rev 与 PPT 统一到 `330266fb`。
- **谁持有**：和 PPT 一样，内核持有权威的文档会话（Yrs），编辑器是副本（`collaboration.initialUpdate` + 同步）。
  面板开不开，智能体都读写同一份最新状态；只有内核写盘。
- **文档内 AI 是主角**：选中文字就能让 AI 润色、改写、续写、翻译；在批注里 @AI 提问；AI 的修改以 **Word 修订**
  （`w:ins`/`w:del`，作者"FinxWork AI"）出现在正文里，用户在原位接受或拒绝。保存后在 Microsoft Word 里也看得到这些修订。
- **对话里的智能体**也能读、改、批注、处理修订、看页面、保存（`docx_*` 工具），默认以修订方式改。
- **要么不做，要么做透**：一期只收 `.docx`。`.doc`（二进制）不做，打开时说清楚并给"用 Word 打开"。

## 1. 范围

| 做 | 不做（一期） |
|---|---|
| `.docx` 查看：分页排版、缩放、大纲、查找 | `.doc`、`.rtf`、`.odt`；`.dotx`/`.docm` 当普通文件显示"用默认应用打开" |
| 编辑：引擎自带的完整编辑能力（文字、样式、列表、表格、图片、页眉页脚、批注、修订模式） | 多人实时协作（零件有，不开放） |
| 保存（⌘S）、未保存标记、外部修改冲突、只读文件只能另存 | 宏、嵌入对象编辑 |
| 文档内 AI：选区 AI、⌘J 指令框、批注 @AI、修订原位审阅 | |
| 对话里的 `docx_*` 工具、步骤行的"查看/撤销" | |
| 引用到对话：选区作为引用带进输入框 | |

## 2. 架构

```
渲染进程  WordView ── <DocxEditor collaboration={initialUpdate, clientId}> （@nimbleoffice/docx-react，WASM 在 Worker）
             │  本地编辑 → update → docx/sync（逐个、有序）        ◀── docx/sync 通知（智能体/撤销产生的增量）
             │  ⌘S → docx/save；选区 AI → 发一轮对话（§5.2）
finx serve  finx-server docs 方法 docx/*  ──▶ finx-docs WordStore（条目/日志/保存/冲突，同 DeckStore）
            finx-core  docx_* 工具 + 审批（approval.rs）
                 │ 行 JSON + 二进制帧
deck-worker 进程（同一个进程，新增 docx 条目类型）每份文件一个线程，持有 finx_word::Word
```

- **不新开进程**：deck-worker 已经是"每份文件一个线程的 actor + 日志 + 崩溃重放"，Word 条目是同一种东西，换个引擎而已。
  若实施时发现耦合不合适，可以拆成 `word-worker` 子命令，wire 不变。
- **新 crate `finx-word`**（与 finx-slide 并列）：包装引擎，对外只暴露 `Word` 和本文的操作类型，不暴露引擎 JSON。
- **写回 .docx 在内核里完成**（2026-11-07，见 [word-native-save.md](word-native-save.md)）：fork 新增
  `docx-native-save`，是引擎 TS 写回（`saveYrsDocx` + `yrsToDocument`）的逐模块 Rust 移植，与 TS 逐字节一致。
  deck-worker 用 `Word::save()` 直接写出；桌面端的 **docx 序列化进程**（`utilityProcess`，以 `docx/host` 登记，
  内核发 `docx/serialize`）保留为退路与对照（`FINX_WORD_SAVE=desktop|compare`）。内核仍是唯一写盘者（I1），
  写出后校验再原子替换原文件。纯 CLI 下 `docx_save`/`docx_view` 也可用。

## 3. finx-word：`Word`

| 能力 | 接口（示意） | 说明 |
|---|---|---|
| 打开 | `Word::open(bytes, client_id=1) -> Word` | 原生 `EditSessionCore`；记下源字节哈希 |
| 副本 | `encode_state()`、`state_vector()`、`encode_diff(sv)`、`apply_update(bytes)` | 坏 update 整个拒掉，状态不变 |
| 读 | `outline()`、`read(range)`、`find(query)`、`comments()`、`revisions()` | 段落以**稳定短 ID**寻址（引擎 paraId），带文字、样式、所在标题 |
| 改 | `apply(EditBatch{mode, author, note, edits}) -> Applied` | 整批原子：失败指出第几步、为什么，不落半批 |
| 修订 | `mode = Suggest` 时一切文字改动成为修订；`review(accept/reject, ids|all)` | 作者名、日期写入修订 |
| 撤销 | `undo(edit)` | 只撤智能体的那一步（origin 隔离），人的改动不受影响；只能撤最近一次 |
| 保存 | `Word::save()`（原生，§2），失败时由宿主序列化；`Word::check_saved(bytes)` 校验结果 | 未改动的部件逐字节等于源文件由 `saveYrsDocx` 的基线保存保证，e2e 覆盖 |
| 看页 | `render_page(docx_bytes, n, scale) -> png` | `nimbleoffice-docx` 光栅化序列化后的字节；中文用系统字体（同 finx-slide fonts） |

操作（snake_case，一一映射到引擎；寻址用段落 ID，文字用 `find`：在该段里恰好出现一次）：

```
replace_text { paragraph, find, replace }          insert_text { paragraph, text, after?: find | at?: "start"|"end" }
delete_text { paragraph, find }                    format_text { paragraph, find?, bold?, italic?, underline?, strike?, color?, highlight? }
insert_paragraphs { after|before, paragraphs: [{ text, style? }] }   delete_paragraph { paragraph }
set_paragraph_style { paragraph, style }           set_alignment { paragraph, align }
add_comment { paragraph, find?, text }             reply_comment { comment, text }        resolve_comment { comment }
insert_table_row { row_of: paragraph, position, cells }   delete_table_row { row_of }   set_cell_text { cell_of, text }
```

## 4. 内核

- **WordStore**（finx-docs）：条目、工作目录、日志、保存守卫、基准哈希冲突，全部复用 DeckStore 的做法与代码；
  条目类型按扩展名分流。worker 重启回放日志，未保存的编辑不丢。
- **协议**（finx-protocol `api.rs`，照 deck/*）：

| 方法 | 参数 | 结果 |
|---|---|---|
| `docx/open` | `{ session_id, path, replica, discard? }` | `{ docx_id, source(base64 原文件), state(base64), hash, writable, dirty, revision, font_families }`（编辑器的 worker 引擎必须有源字节，`state` 叠在上面） |
| `docx/sync` | `{ session_id, docx_id, update?(base64), state_vector?(base64) }` | `{ revision, update? }`：带 state_vector 时回内核比副本多的部分；其他副本收到 `docx/sync` 通知 |
| `docx/save` | `{ session_id, docx_id, path?, force? }` | `{ status: saved\|conflict\|refused, hash, message }` |
| `docx/close` | `{ session_id, docx_id }` | `{}` |
| `docx/undo` | `{ session_id, docx_id, edit }` | `{ revision }`，撤不了报 `doc_refused` 附原因 |
| 通知 `docx/changed` | `{ docx_id, revision, dirty, author }` | 标签"未保存"、步骤行刷新 |

- **工具**（延迟加载组 `word`，GUIDELINES 写进工具说明）：

| 工具 | 作用 | 审批 |
|---|---|---|
| `docx_read(path\|docx, range?)` | 无 range 给大纲与段落 ID；有 range 给逐段文字、样式、批注、修订 | 不问 |
| `docx_find(docx, query)` | 文字搜索，返回段落 ID 与上下文 | 不问 |
| `docx_view(docx, page)` | 页面图片 | 不问 |
| `docx_edit(docx, edits, note, mode="suggest")` | `suggest`：修订，用户在文档里审；`direct`：直接改 | suggest 不弹卡（修订本身就是审批，且可在文档里拒绝）；direct 同 deck_edit |
| `docx_review(docx, action, ids\|"all")` | 接受/拒绝修订（用户要求时才用） | 同 direct |
| `docx_save(docx, path?)` | 写回文件 | 同 deck_save |

  返回值的 details：`{ docx_id, path, edit, revision, mode, paragraphs:[…], revisions:[…] }`，`edit` 给"撤销"用。
  GUIDELINES：默认 suggest；只有用户明确说"直接改"或在处理自己刚写的内容时才 direct；改前先 read/find；
  一组相关修改放一次调用写清 note；不要接受自己的修订，除非用户要求；对用户只说"第几段/哪个标题下"，不说段落 ID。

## 5. 文档内 AI

### 5.1 交互

1. **选区 AI 条**：选中文字后，选区旁出现小按钮 ✦；点开是菜单：润色、更简洁、更正式、扩写、续写、翻译为中文/英文、
   纠正错别字与语法、总结到批注、自定义（输入框）。**⌘J** 在光标或选区处直接打开指令框（"让 AI 改写或写点什么…"）。
2. **执行中**：选区盖一层流光并显示"AI 正在处理…（停止）"；可以继续编辑文档其他地方。
3. **结果**：AI 的修改以修订出现在原位（作者 FinxWork AI，有自己的颜色和图标），侧栏是引擎自带的修订卡片
   （接受/拒绝/上一处/下一处）；选区旁给一条"接受全部 · 拒绝全部"，只作用于这一次请求产生的修订。
4. **批注 @AI**：在批注里写 `@AI …`，或在批注卡上点"问 AI"，AI 在同一线程里回复；需要改文字时同时给修订。
5. **对话联动**：每次文档内请求在对话里显示为一条紧凑的用户消息（"在《合同.docx》第 3 段：润色"＋引用块），
   智能体的步骤行有"查看修改"和"撤销"。选区也能"引用到对话"，走现有引用方块。

### 5.2 实现

- 文档内请求 = 往当前会话发一轮对话，复用模型、权限、历史、停止，不另起一套 LLM 调用。消息带结构化上下文：
  `docx_id`、路径、选中段落 ID 与原文、动作、用户输入。系统侧给出固定提示：用 `docx_edit` 的 suggest 模式只改这些段落。
- 一次请求的修订归属：`docx_edit` 的 details 带回修订 ID，前端据此做"接受全部/拒绝全部"（调 `docx_review` 对应的
  内核方法 `docx/review`，用户操作不经模型）。
- 修订作者外观：`trackedChanges.getAuthorAppearance` 把 "FinxWork AI" 标成 `agent`、品牌色、✦ 图标。

## 6. 界面

- `docs/docx/WordView.tsx`：`DocxEditor`（内置工具栏、大纲、查找、批注与修订侧栏），中文界面（docx-i18n），
  跟随窗口明暗（`colorMode`），中文字体照 PPT 的 fonts 处理（系统字体优先）。
- 标签与外壳照 PresentationView：加载态、未保存点、⌘S、冲突提示（"文件在外部被修改：覆盖 / 重新载入"）、只读另存。
- 文件分流：`files/kind.ts` 把 `.docx` 指向 WordView；`.doc` 显示说明与"用默认应用打开"。

## 7. 测试

- Rust：`cargo test -p finx-word -p finx-docs -p finx-core -p finx-server -p finx-protocol`。覆盖：打开中文文档、
  各操作、suggest 产生 `w:ins/w:del` 并能接受/拒绝、整批原子、只撤智能体那步、副本同步往返、坏 update 被拒、
  保存后未改部件逐字节不变、worker 崩溃回放、冲突与只读、三种权限模式下的审批。
- 前端：`pnpm --dir apps/desktop test`、`typecheck`：同步链路（乱序/失败重同步）、分流、AI 请求消息的构造、
  一次请求的修订归属与批量接受。
- e2e（真实应用 + finx-mock 模型）：
  - `e2e/word-editor.mjs`：打开 docx → 打字 → ⌘S → 文件里有新文字，其余部件不变；外部修改后保存出冲突提示。
  - `e2e/word-ai.mjs`：选区 → ✦ 润色 → 修订出现在原位 → 接受 → 保存 → 文件含新文字不含修订；
    对话里 `docx_edit` direct → 步骤行"撤销"恢复；批注 @AI 得到回复。
- 打包：`build-app.mjs` 签名后冒烟：内核打开一份 docx、`docx_view` 出图（空 HOME）。

## 8. 分工与顺序

| 波 | 任务 | 模型 |
|---|---|---|
| 1 | A. `finx-word` crate + Cargo rev 统一（§3） | opus |
| 1 | F. docx 序列化宿主：utilityProcess + `docx/host`/`docx/serialize`（两端） | opus |
| 1 | B. WordView 与副本链路、分流、保存/冲突（对着 §4 协议写，内核用替身测） | opus |
| 2 | C. worker 条目、WordStore、`docx/*` 方法、`docx_*` 工具与审批（依赖 A） | opus |
| 3 | D. 文档内 AI 交互（§5，依赖 B、C） | opus |
| 3 | E. e2e、打包冒烟（依赖 B、C） | sonnet |
| — | 每波后合并、全量测试、`pnpm dev` 实测 | 我 |

所有子代理思考强度 low。

## 9. 不变量

I1 只有内核写盘；I2 保存只改动过的部件；I3 基准哈希保护外部修改；I4 显示"已保存"时内核已落盘；
I5 坏输入不污染状态；I6 PPT/表格/PDF 现有能力不回退。

## 11. 决策

1. 分支从 `feat/document-editor` 切出（不是 main）：Word 依赖它上面尚未合入 main 的内核持有链路（deck-worker、
   DeckStore、deck_edit 审批与撤销）。2026-11-07 用户睡前授权直接开工，来不及问；合并顺序：先合 document-editor，再合 word。
2. AI 改 Word 默认用修订（suggest），不弹审批卡：修订就是文档里的审批，比对话里的卡片更直观，且在 Word 里同样可见。
3. 文档内 AI 走对话轮次，不另做单次补全接口：复用模型选择、权限、停止、历史与子智能体。
