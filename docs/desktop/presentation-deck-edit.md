# 演示文稿：智能体编辑（deck_edit、审批与撤销）

状态：已实施 · 2026-11-06 · 基于 [presentation-kernel-authority.md](presentation-kernel-authority.md)（DeckStore）与 [presentation-ai-design.md](presentation-ai-design.md) §6.3、§6.4、§7

已定（2026-11-06，取代 ai-design §11-4 的"先提议、人确认"）：PPT 与 Excel 同一套做法：**一份文档，直接改，可撤销，
问不问交给权限模式**。上一版的提议层（提议账本、对话里的接受/拒绝卡、编辑器里的提议预览）已删除；它绕开了权限模式
（完全访问也弹卡），提议只在内核内存里，编辑器得另做预览、拦截按钮，问题都出在这一层。以后要"建议模式"，
按 Google Docs 的方式做进文档本身，不再另起一套审批。

## 1. 思路

```
deck_edit ──▶ 审批（approval.rs，同 doc_edit）──▶ DeckStore::apply ──▶ worker: Apply ──▶ Deck::apply
                                                                    │ 增量 → journal.append → revision+1
                                                                    ▼
                                    DeckEvent::Update{session:None} ──▶ 所有副本（deck/sync）+ Changed
对话里步骤的「撤销」──▶ deck/undo{edit} ──▶ worker: Undo ──▶ Deck::undo ──▶ 同上，作为新修订广播
deck_save / ⌘S ──▶ 写回文件（审批同 doc_save）
```

- 改动落在内核持有的 deck（工作副本），不写文件；标签显示"未保存"，直到 `deck_save` 或 ⌘S。
- 一次 `deck_edit` 是一个修订，也是撤销历史里的一步；它的 `edit` ID 就是它产生的修订号。

## 2. finx-slide `Deck`

- 引擎（NimbleOffice fork，b73babb）只通过提议接口改文档，没有直接应用的入口。`Deck::apply(request)` 在内部
  propose 再立即 accept（force），前后各加 undo barrier，保证每次改动是独立的一步；失败时撤掉临时提议。
  返回 `Applied { applied, strip, update }`。
- 撤销用引擎自带的 Yrs UndoManager：它只记录 origin 为 deck 自己 client id 的事务。worker 的改动只有 `apply`，
  副本的 update 按 remote origin 合并，不进历史。所以 `Deck::undo()` 只撤智能体的改动，人在编辑器里的改动不受影响
  （测试覆盖）。纯删除不会推进 state vector，所以撤销的增量用 `encode_diff`，不用 `changes_since`。
- 改过的页照常进 `edited`（保存守卫）。整批里有一步失败时，用前缀逐个试提找出第一个单独失败的步骤，报 `edit N`（从 0）。
- 内核 Deck 的 Yrs client id 固定为 1，副本用 53 位随机 id；worker 重启先回放日志再写，不会重号。

## 3. deck-worker 与 DeckStore

- wire：`Apply { deck, agent_id, note, edits }` → `Edited { revision, update, applied, strip }`；
  `Undo { deck, edit }` → `Changed { revision, update }`；`Check { deck }`；`Snapshot { deck }`。
- worker 记一个栈 `edits: Vec<u64>`，存本次运行里智能体改动产生的修订号。`Undo` 只接受栈顶：
  更早的一次会报"后面还有一次改动没撤"，不在栈里的会报"已撤销或 deck 已重新打开"（`DeckError::NotUndoable`）。
- **限制**：撤销历史只在 worker 内存里。worker 重启或条目关闭后，改动仍在（日志回放），但不能再撤。
  Excel 的撤销重启后还能用，PPT 暂时做不到：要做到，得让引擎回放时把智能体的记录按本地 origin 应用。
- 增量和副本 update 走同一条 `journal.append`；空增量不记日志、不加修订。
- 智能体编辑时文件可能没在面板打开：工具用 `open(path, session, replica=false)` 加入条目，会话结束时由 `forget_session` 关闭。

## 4. 服务端方法（finx-server `decks.rs`）

| 方法 | 参数 | 结果 |
|---|---|---|
| `deck/undo` | `{ session_id, deck_id, edit }` | `{ revision }` |

撤不了（不是最近一次、历史已没了、deck 已关）时报 `doc_refused`，附原因。撤销产生的增量照常用 `deck/sync` 推给副本，
之后发 `deck/changed`。协议里 `deck/proposal/*` 等提议词汇是 e17c1da 带进来的设计预留，没有实现，服务端不路由。

## 5. 工具与审批（finx-core）

- `deck_edit(deck, edits, note)`：`edits` 是 `DeckOp[]`（snake_case），一一映射到引擎 `ProposalEdit`：
  `replace_text`、`set_paragraphs`、`format_text`、`set_alignment`、`add_text_box`、`remove_shape`、`set_shape_rect`、
  `insert_slide`、`duplicate_slide`、`delete_slide`、`move_slide`、`set_slide_layout`、`set_notes`。
  寻址用 deck_read 给出的 slide_id/shape_id；文字用 `find`（在该对象里恰好出现一次、不跨段），工具按现场快照算出 UTF-16 偏移。
  整批要么全部生效，要么都不生效；失败时指出第几步和原因。
  返回改动页摘要和这些页的体检结果。details：`{ deck_id, path, edit, revision, applied, note, slides: [{index, slide_id, status}] }`，
  其中 `edit` 是 `deck/undo` 用的 ID，没改动时为 null。
- 审批（`approval.rs`），与 `doc_edit` / `doc_save` 一致：

  | 权限模式 | deck_edit | deck_save |
  |---|---|---|
  | 询问权限 | 执行前弹标准审批卡，逐步列出改动（`replace "A" with "B"`、`delete a slide`…，最多 12 行） | 问 |
  | 自动接受编辑 | 直接执行 | 工作区内直接写，工作区外问 |
  | 完全访问 | 直接执行 | 直接写 |

  通过 `call_tool` 延迟调用的 `deck_edit` 按它自己的规则判断。
- `deck_save(deck, path?, force?)`：走 `DeckStore::save`，只重写改过的页。
- GUIDELINES：`deck_edit` 会立即改 deck、用户可以撤销、只有 deck_save 才写文件；改数字先 deck_find；
  一组相关修改放在一次 deck_edit 里并写清 note；被拒绝就重读再改，不要绕过；对用户只说页、标题、文本框。

## 6. 前端

- 对话里 `deck_edit` 的步骤下面有一行操作（`DeckEditActions`）：「查看第 N 页」打开演示文稿并跳到第一个改动页，
  按 `deck_id` 请求，编辑器就绪后再执行；「撤销」调用 `deck/undo`，成功后显示"已撤销"，失败时显示原因。
  Bot 的聊天里也有同样的操作，子智能体做的改动也会显示。
- 审批卡用通用预览，显示内核给的逐步说明。
- 编辑器默认作为内核 deck 的副本，`kernelAuthority` 默认开启；不再显示提议审阅。
- 文案只说页、文本框、标题，不出现 slide_id 和 DeckOp。

## 7. 暂不做

撤销历史跨重启保留、重做（redo）、撤销更早的一次、`deck_layouts`、`deck_generate`、图表/表格单元格编辑、文档内建议模式。

## 8. 验收

- `cargo test -p finx-slide -p finx-docs -p finx-core -p finx-server -p finx-protocol` 通过。覆盖：改动直接到达副本；
  撤销只撤智能体那一步、人的改动保留；只能撤最近一次；worker 崩溃后改动保留但不能撤；整批失败不落半批；
  审批在三种模式下的结果和摘要文字。
- `pnpm --dir apps/desktop test`、`typecheck` 通过。
- `node apps/desktop/e2e/deck-edit.mjs`：询问模式下弹审批卡、允许前不改 → 允许后编辑器更新、文件不变 →
  第二次改动用「撤销」撤回 → 自动接受编辑下不弹卡直接改 → deck_save 后文件里只有第一页的部件变了。
