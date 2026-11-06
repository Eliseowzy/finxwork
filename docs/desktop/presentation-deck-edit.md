# 演示文稿：智能体编辑（deck_edit 与提议）

状态：实施中 · 2026-11-06 · 基于 [presentation-kernel-authority.md](presentation-kernel-authority.md)（DeckStore）与 [presentation-ai-design.md](presentation-ai-design.md) §6.3、§6.4、§7

已定：AI 修改默认"先提议、人确认"（ai-design §11-4）。

## 1. 思路

引擎（BetterOffice fork）已有完整的提议生命周期：`propose / proposals / preview / accept / reject`。
**实测（b73babb）：待处理提议存在引擎会话的内存里（`ProposalStore`），不在 Yrs 文档里**：`propose` 不产生增量、
不会到达任何副本；只有 `accept` 产生增量。引擎测试里的"两副本一致"指的是接受后的改动。
`ProposalEdit` 有 24 种：文字（ReplaceText、FormatText、SetStoryParagraphs、SetParagraphAlignment）、
对象（AddTextBox、AddShape、AddPicture、RemoveShape、ReorderShape、SetShapeRect/Fill/Stroke/Adjust）、
表格行列、页（InsertSlide、DuplicateSlide、DeleteSlide、MoveSlide、SetSlideLayout、SetSlideBackground、SetSlideNotes）。

所以：提议只在 deck-worker 持有的 Deck 上；worker 给它一个自己的 ID 并记进 `proposals.json`（崩溃后重提）。
接受时把增量当作一个修订记日志、广播给所有副本。编辑器的引擎**看不到**内核的提议：要在画布上预览，
副本需用 `deck/proposals` 返回的 `edits`（引擎 `ProposalEdit` JSON）在自己的引擎里 `propose` 一份本地预览；
接受/拒绝一律走 `deck/proposal/accept|reject`（编辑器自己引擎里的接受只会改它的本地预览）。

```
deck_edit ──▶ DeckStore::propose ──▶ worker: Propose ──▶ Deck::propose（无增量，不加修订）
                                         │ ledger 记录 → DeckEvent::Changed（客户端重取 deck/proposals）
对话卡片/编辑器的接受 ──▶ deck/proposal/accept ──▶ worker: Accept ──▶ 捕获增量 → journal.append → revision+1
                                         ▼
                         DeckEvent::Update{session:None} ──▶ 所有副本（deck/sync 通知）+ Changed
拒绝 ──▶ deck/proposal/reject ──▶ worker: Reject（无增量）──▶ Changed
```

## 2. finx-slide `Deck`

- `propose(request_json) -> Result<(Proposal, Vec<u8>)>`：`ProposalRequest { agent_id, note, edits }`，返回提议与本次增量。
- `accept_proposal(id, force) -> Result<(ProposalAcceptance, Vec<u8>)>`、`reject_proposal(id) -> Result<(bool, Vec<u8>)>`、`proposals()`、`proposal_strip(id)`。
- 增量捕获：调用前 `state_vector()`，调用后 `encode_diff(sv)`。
- 接受后的改动必须进入 `edited`（保存守卫），用与 `apply_update` 相同的快照比较；把这段抽成共用函数。
- 内核 Deck 的 Yrs client id：实测 `Presentation::open` 固定用 1（STANDALONE），引擎没有"带字体选项的协作打开"，
  换随机 id 要改 fork。副本 id 是 `replicaClientId()` 的 53 位随机数 +1，与 1 相撞概率 2^-53；worker 每次重启都用 1，
  但先回放整条日志再写，Yrs 会从已有状态续接时钟，不会重号。保留现状，测试断言两者不同。
- 待处理的提议不进保存出的 .pptx（不在文档里，测试已覆盖）。
- 保存守卫补了一项能力：编辑某页的备注会改/新建它的 notesSlide 部件（及其 rels，新建时加 content types）。
- 整批失败时，Deck 用前缀逐个试提（试完即撤）找出第一个单独失败的步骤，报 `edit N`（从 0）。

## 3. deck-worker 与 DeckStore

- wire：`Propose { deck, agent_id, note, edits: Value }`、`Accept { deck, proposal, force }`、`Reject { deck, proposal }`、`Proposals { deck }`、
  `Check { deck, proposal? }`（提议时检查其预览）、`Snapshot { deck }`（工具按现场 id 解析文字位置、deck_read 读现场大纲）。
  改动类请求的回复带 `revision` 和 base64 `update`；空增量不记日志、不加修订（提议、拒绝都是空增量）。
- 日志：接受的增量与副本 update 走同一条 `journal.append`，回放无需新逻辑。提议本身在 `proposals.json`（ledger）：
  worker 重启时回放日志后按原 ID 重提待处理的提议，重提失败的记为 rejected；已处理的保留最近 64 条供列表显示状态。
  条目关闭且无未保存改动时目录被删，待处理提议随之丢弃。
- DeckStore：`propose / accept / reject / proposals / check`，改动后 `emit(Update{session: None, ..})` 与 `Changed`。
- 智能体编辑时文件可能没在面板打开：工具用 `open(path, session, replica=false)` 打开条目，会话结束由 `forget_session` 关闭；未保存的改动照常留在工作目录。

## 4. 服务端方法（finx-server `decks.rs`）

| 方法 | 参数 | 结果 |
|---|---|---|
| `deck/proposals` | `{ session_id, deck_id }` | `{ proposals: DeckProposalEntry[] }` |
| `deck/proposal/accept` | `{ session_id, deck_id, proposal_id, force? }` | `{ revision, acceptance: { proposalId, applied, staleTargets? } }` |
| `deck/proposal/reject` | `{ session_id, deck_id, proposal_id }` | `{ revision, rejected }` |

`DeckProposalEntry` 是引擎提议 JSON（camelCase：`id, agentId, note, edits, changes, staleTargets, refs?`）加 `status`（`pending|accepted|rejected`），
待处理的在前。`id` 是 worker 的 ID（`p-xxxxxxxxxxxx`），跨 worker 重启不变。`applied: false` 带 `staleTargets`：目标已变，仍待处理，
`force: true` 再接受；不带：提议不改任何东西（已关闭）。未知 ID 报 `proposal_not_found`（-32039）；`slide_ids`（逐页）暂不支持。
类型在 finx-protocol（`DeckProposalsParams/Result`、`DeckProposalDecideParams`、`DeckProposalAcceptResult`、`DeckProposalRejectResult`），
`generated.ts` 已同步。增量照常用 `deck/sync` 通知推给副本；提议、接受、拒绝后都发 `deck/changed`。

## 5. 工具（finx-core `deck.rs`）

- `deck_edit(deck, edits, note)`：`deck` 是路径。`edits` 是 `DeckOp[]`（`{"op": "...", ...}`），在 finx 侧定义（带 JsonSchema、snake_case），一一映射到 `ProposalEdit`；
  第一批：`replace_text`、`set_paragraphs`、`format_text`、`set_alignment`、`add_text_box`、`remove_shape`、`set_shape_rect`、
  `insert_slide`、`duplicate_slide`、`delete_slide`、`move_slide`、`set_slide_layout`、`set_notes`。寻址用 deck_read 给出的 slide_id/shape_id；
  文字不用 story_id/偏移，而用 `find`（在该对象文字里恰好出现一次、不跨段），工具按现场快照算出 UTF-16 偏移（段尾算 1）；
  同一批里前面的替换会顺移后面步骤的范围，重叠报 `OverlappingSteps`。位置尺寸用点。版式用别的页在用的版式名。
- 引擎的 slide_id 含页序号（`slide:1:257`），重新解析保存出的文件会变；所以 deck 已在 DeckStore 打开时，只读工具的大纲取自 worker 的现场快照。
  整批是一个提议，任一步失败则整批失败，并指出第几步、原因（`ContentMismatch`、`StaleVersion`、`Unsupported` 原样告诉模型）。
  返回：提议 ID、每页改动摘要（strip）、改动页的体检结果。`ToolKind::Mutating`，`ToolCategory::Edit`，与 `doc_edit` 一致。
  details：`{ deck_id, path, proposal_id, revision, slides: [{index, slide_id, status}] }`，供前端卡片用；`index` 从 0（提议后的位置，删除页为原位置），
  `status` 为 `changed|inserted|deleted|moved`（只列有改动的页）。
- `deck_save(deck, path?, force?)`：同 `doc_save`，走 `DeckStore::save`。
- 只读工具的说明里去掉"没有编辑或保存"；GUIDELINES 加 ai-design §7 的使用规则（改数字先 deck_find；一组相关修改一次 deck_edit、写清 note；版面改动后 deck_view 看一次；被拒就重读再改，不要绕过；对用户只说页、标题、文本框）。
- 模型看到的是提议状态：说明里写明"修改等用户接受后才生效；接受前 deck_read 读到的是原内容"（以引擎实际行为为准，测试确认）。

## 6. 前端

- 内核持有模式下，编辑器打开引擎的提议审阅（`PresentationView` 现为 `proposals={false}`）：画布显示提议、缩略栏标记、接受/拒绝。
- 对话里 `deck_edit` 的结果渲染成提议卡片："修改 方案.pptx？改了 N 页" + 页列表 + 拒绝 / 接受（⌘↩），调用 `deck/proposal/*`；状态随 `deck/changed` 更新（编辑器里已处理则卡片显示已接受/已拒绝）。
- 卡片文案只说"页、文本框、标题"，不出现 slide_id、DeckOp。

## 7. 暂不做（下一轮）

本会话直接应用、按页拆分接受、`deck_layouts`、`deck_generate`、图表/表格单元格编辑、默认打开内核持有开关。

## 8. 验收

- `cargo test -p finx-slide -p finx-docs -p finx-core -p finx-server` 通过；新增：提议增量同步到第二副本、接受后保存守卫放行且未改部件逐字节不变、待处理提议不进 .pptx、worker 崩溃后提议从日志恢复、整批失败不落半批。
- `pnpm --dir apps/desktop typecheck` 通过。
- `pnpm dev` 实测：面板开着时让智能体改一页标题 → 编辑器出现提议 → 对话卡片接受 → 编辑器更新 → 保存后 PowerPoint 能打开。
