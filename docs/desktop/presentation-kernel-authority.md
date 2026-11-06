# 演示文稿：内核持有（Kernel Authority）设计

状态：阶段 1–4 与阶段 5 的内核部分已实现；新链路默认关闭，内部用 `localStorage["finx.deck.kernelAuthority"] = "1"` 打开 · 2026-11-06 · 展开 [presentation-ai-design.md](presentation-ai-design.md) §6.2 方案 B（PD-01）

## 0. 结论先行

- **谁持有**：打开着的 `.pptx` 由内核里一个专用的 **deck-worker 进程**持有权威的 `DeckSession`。编辑器里的 WASM 引擎退为 **Yrs 副本**。保存只在内核做。
- **不放进 doc-worker**：doc-worker 串行处理请求，而且会因 PDFium 崩溃而重启。演示文稿要求低延迟同步，不能排在 PDF 渲染后面，也不该被 PDF 的崩溃牵连。
- **两份副本互为备份**：任何一侧崩溃，另一侧都还有完整状态，重连时用 state vector 互补，未保存的编辑不丢。这是这次改架构在可靠性上最大的收益。
- **不回退**：现有的每一项 PPT 能力都列进 §11 的对照表，各配一条回归测试。新旧两条链路由开关 `deck.kernelAuthority` 切换。老链路保留到新链路在正式版里稳定两个版本后再删。
- **工期**：约 9 个工作日（原排期 7 天，多出的 2 天花在保存守卫改造和崩溃恢复测试上），分 5 个阶段，每个阶段都能独立合入、独立回退（§12）。

---

## 1. 现状

### 1.1 链路

```
磁盘 .pptx
  │  pptx/read：整包读入 → base64 → JSON-RPC 帧（≤20 MiB，受 32 MiB 帧限）
  ▼
渲染进程 PresentationDoc（document.ts）
  │  bytes → <PptxEditor file=…>（pptx-react，WASM 引擎在 Worker 里）
  │  编辑 → onDocumentChange → doc.edit() → 1.2 s 防抖 → flush()
  │  flush：prepare(flushPendingInput) → serialize(editor.save()) → 与上次字节比较
  ▼
pptx/write(data=base64 整包, base_hash)
  │  finx-core/src/pptx.rs：校验 zip → finx_slide::Deck::open 复核 → 路径锁 → 基准哈希比较 → 写盘
  ▼
磁盘 .pptx
```

智能体一侧：`finx-core/src/deck.rs` 里已经有只读工具组 `deck`（open/read/find/view/check）。它从磁盘读文件，每次调用重新打开，大纲缓存 4 份。所以**智能体看不到用户还没保存的编辑**（工具说明里已经写明）。

### 1.2 已有零件

| 零件 | 位置 | 状态 |
|---|---|---|
| 权威端封装 `finx_slide::Deck` | `crates/finx-slide/src/lib.rs` | 有 `encode_state` / `state_vector` / `encode_diff` / `apply_update` / `save` |
| 权威↔副本往返测试 | `crates/finx-slide/tests/collaboration.rs` | 文字编辑往返、坏 update 被拒，都通过 |
| 引擎协作层 | fork `packages/pptx/src/collaboration/` | provider（分块、背压、重连、批量）、asyncReplica、presence，都有测试 |
| 副本身份校验 | fork `crates/pptx-edit/src/peer.rs` | 副本必须用同一份源文件（sha256）加入，并要求 client id 是新的 |
| 撤销 | fork `crates/pptx-edit/src/undo.rs` | `DeckUndoManager` 基于 yrs UndoManager，可以按 origin 捕获 |
| 精确保存 | fork `crates/pptx-edit/src/save.rs` | 和基线比较，只重写改过的部件；没改过的幻灯片字节不变 |
| 进程隔离与重启 | `crates/finx-docs/src/worker.rs` | `Launcher`/`Worker` 模式，进程死后重开文档再重试一次 |
| 原子写 | `crates/finx-docs/src/atomic.rs` | 先写临时文件再 rename |
| 文档目录约定 | `crates/finx-docs/src/store.rs` | `<docs>/<doc_id>/base.* current.* meta.json`，按规范路径生成稳定 id，多会话共享一个条目 |
| 协议常量 | `crates/finx-protocol/src/api.rs:121-145` | `deck/open/close/sync/save/...`、`deck/changed`、`deck/proposal` 已定义，没有实现 |

### 1.3 这次要解决的问题

1. 编辑面板关着、或者渲染进程挂了，智能体就改不了、也读不到最新状态。
2. 保存时整包 base64 走 IPC：几 MB 到 20 MiB 来回搬，并且 20 MiB 是硬上限。
3. 前端只在内存里持有未保存的修改。渲染进程崩溃就全丢（最多丢 1.2 s 防抖窗口外加一次保存的时间，但如果写盘一直失败，比如冲突、只读，丢的就是全部）。
4. 表格（DocStore）是内核持有，PPT 却是前端持有，两套模型，维护成本翻倍。

### 1.4 已知的坑（设计必须处理）

| # | 坑 | 出处 | 影响 |
|---|---|---|---|
| K1 | `Deck::apply_update` 合并前后各 `save()` 一次，靠比较字节找出改动的部件 | `finx-slide/src/lib.rs` | 每次同步都是 O(整份文件)，打字时会把内核 CPU 打满 |
| K2 | 保存守卫只放行"幻灯片部件"的改动 | 同上 `save()` → `SlideError::Unexpected` | 插页、删页、移页要改 `presentation.xml` 和关系文件；加图片要新增 media 部件。现在前端能做，切到内核后会**保存失败**，这就是回退 |
| K3 | `Deck` 不是 `Send`（引擎内部有 `Rc`/`RefCell`） | `collaboration.rs` 末尾的 TODO | 不能放进 tokio 任务，必须固定在一个线程上 |
| K4 | 新插入的图片以 base64 存在 CRDT 里（`pending_media`） | fork `save.rs:888` | 大图会撑大 update 和日志，同步时可能触发 16 MiB 批量上限 |
| K5 | 副本加入要求源字节一致加新的 client id | fork `peer.rs` | 内核重启后必须换新的 client id，前端也要拿到同一份源字节 |

---

## 2. 目标与不变量

**目标**
- G1 面板开不开，智能体都能读到、改到同一份最新状态。
- G2 任何单个进程崩溃（渲染进程、deck-worker、finx serve）都不丢已经确认的编辑。
- G3 本地编辑的手感不变：输入到画面更新不经过 IPC。
- G4 PPT 和表格共用同一套"文档条目、工作目录、保存、冲突"语义。

**不变量（违反就是缺陷）**
- I1 **同一时刻只有一个权威。** 只有 deck-worker 里的 `DeckSession` 能写盘。
- I2 **保存只改动过的部件。** 没碰过的部件逐字节等于源文件。现有"保存后自检"保留并扩展（§6.3）。
- I3 **基准哈希保护。** 磁盘文件被外部修改后，不能静默覆盖。
- I4 **副本不会领先于权威被持久化。** 前端显示"已保存"时，内核的保存已经落盘。
- I5 **坏输入不污染状态。** 非法 update 整个拒掉，状态不变（已有测试 `malformed_replica_update_is_rejected`）。
- I6 **现有能力不回退**，以 §11 的清单为准。

**不做**：多人实时协作（零件够用，但这次不开放）；`.ppt` / `.key` 格式。

---

## 3. 总体架构

```
┌──────────── 渲染进程 ─────────────────────────────────────────┐
│ PresentationDoc（瘦身：状态机 + 同步传输，不再序列化）         │
│ PptxEditor + Worker(WASM)：Yrs 副本，client id = 会话分配       │
│   本地编辑立即生效 ── update(origin=local) ──┐                  │
│   ◀── update(origin=remote：智能体/恢复) ────┤                  │
└──────────────────────────────────────────────┼─────────────────┘
                     JSON-RPC：deck/sync（请求）+ deck/changed（通知）
┌──────────── finx serve ──────────────────────┼─────────────────┐
│ finx-server：deck/* 方法 → DeckStore         ▼                  │
│ finx-core：deck 工具组（读写都走 DeckStore，不再读磁盘）        │
│ finx-docs::DeckStore：条目、会话视图、工作目录、保存、冲突      │
│        │ 行分隔 JSON + 二进制帧（stdin/stdout）                 │
└────────┼───────────────────────────────────────────────────────┘
┌────────▼──── deck-worker 进程（`finx deck-worker`）────────────┐
│ 每个打开的文件一个线程（actor），线程里持有 finx_slide::Deck    │
│ 持久化：update 日志 + 定期快照（§7）                            │
└────────────────────────────────────────────────────────────────┘
```

### 3.1 为什么单开 deck-worker，而不是复用 doc-worker

| 维度 | 放进 doc-worker | 单开 deck-worker（采用） |
|---|---|---|
| 延迟 | 串行队列，PDF 渲染一张大页要几百 ms，同步要排队 | 每份文件一个线程，互不阻塞 |
| 故障域 | PDFium 崩溃会把所有打开的演示文稿一起带走 | PDF 和 PPT 互不影响 |
| 线程模型 | 现有的 `Worker::request` 拿着全局锁一问一答 | 按文件路由，多份文件可以并行 |
| 复用 | — | 复用 `Launcher`（同一可执行文件、换子命令）、"死后重启再重试一次"的逻辑和测试替身 `Launcher::Thread` |

`Deck` 不是 `Send`（K3），所以每份文件用一个专属的 OS 线程，线程里用 `mpsc` 接收命令，`Deck` 永远不离开这个线程。这也正好让"同一份文件的操作严格串行"成为结构上的保证，不需要额外加锁。

### 3.2 模块边界（可维护性）

| crate | 负责 | 不负责 |
|---|---|---|
| `finx-slide` | 引擎门面：打开、同步、保存、守卫、读取、渲染。纯函数加一个 `Deck` 类型，没有 IO | 进程、文件路径、会话 |
| `finx-docs::deck`（新） | `DeckStore`、deck-worker 协议、actor、日志与快照、崩溃恢复 | 工具语义、审批 |
| `finx-core::deck` | 智能体工具。改为调 `DeckStore`，不再自己读磁盘 | 持久化 |
| `finx-server` | `deck/*` RPC 方法与通知路由 | 业务逻辑 |
| 渲染进程 `docs/pptx/` | 编辑界面、传输适配（`KernelTransport`），状态机 | 写盘、哈希 |

规则：引擎调用只出现在 `finx-slide`。文件 IO 只出现在 `finx-docs`。跨层只通过 `finx-protocol` 里的类型。

---

## 4. 打开

```
渲染进程                    finx serve / DeckStore             deck-worker
  │ deck/open(path)  ───────▶ 规范化路径 → doc_id
  │                          已有条目？→ 直接加入（多会话共享）
  │                          否则：建 <docs>/<id>/，复制 base.pptx
  │                          有残留日志？→ 恢复（§7.3）
  │                                      ── open(id, base, log) ──▶ 新线程：Deck::open(base)
  │                                                                  重放日志 → 分配 client id
  │                          ◀──────── identity、state vector、摘要 ──┤
  │ ◀─ {doc_id, token, identity, font_families, writable, hash, dirty, contract_version}
  │ 用 finxdoc://<token>/base.pptx 拉源字节（不走 JSON，不再 base64）
  │ open_peer_deck(源字节, identity) → 副本
  │ deck/sync(副本 state vector)   ─────────────────▶ encode_diff
  │ ◀─ 缺的 update（恢复出来的未保存编辑会在这里补上）
  │ 编辑器可交互
```

要点：
- **源字节走 `finxdoc://` 流**，表格和 PDF 已经在用这个机制。这样 base64 带来的 33% 膨胀和 32 MiB 帧限都没了，20 MiB 的上限可以放宽到和读取工具一致（512 MiB，`finx-core/src/deck.rs`）。这个上限是否真的放开，交给 PD-K3 决定。
- **字体枚举**（`font_families`）沿用 `pptx.rs::font_families`，在内核里做。前端的字体加载流程不变。
- **只读**：文件不可写，或者在 `files::refused` 名单里时，`writable=false`。副本照样建，但编辑器设成 `readOnly`，与现在一致。
- **首次打开的开销**：比现在多一次 `encode_state` / `encode_diff` 和一次 IPC。预算是 20 MB 的文件 P95 < 300 ms（在阶段 2 实测，超出预算就把 update 改为分块，provider 本身支持分块）。

---

## 5. 同步协议

### 5.1 消息

| 方向 | 方法 | 内容 |
|---|---|---|
| 前端→内核 | `deck/sync` 请求 | `{doc_id, client_id, seq, update: bytes}` 或 `{doc_id, state_vector}`（要求补发） |
| 内核→前端 | 回复 | `{ack_seq, revision}` 或 `{update}` |
| 内核→前端 | `deck/changed` 通知 | `{doc_id, revision, update, origin: "agent"|"recovery"|"other_session", dirty}` |

update 先用 base64 放在 JSON 里（单次键入的增量只有几百字节，膨胀可以忽略）。大块 update（打开、恢复）走分块，必要时再给 RPC 加二进制帧。实现时直接用 fork 的 `CollaborationProvider`，自己写一个 `KernelTransport` 适配 `connect/send/onEvent`，**不再另写一套同步状态机**，分块、背压、重连、批量合并都用它的。

### 5.2 规则

1. **本地编辑优先**：副本先应用，再发出去。内核失联时编辑照常进行，provider 缓存最多 16 MiB；超过后进入"内核失联"状态，界面提示，编辑器转为只读（§8）。
2. **幂等**：update 是 CRDT 增量，重复应用不会产生副作用。重连时用 state vector 补差，不依赖 seq 去重。seq 只用来回执和定位问题。
3. **合并在 actor 线程里串行执行**。合并失败（I5）就拒掉这个 update，并回发 `protocol` 错误。前端 provider 会断开再重连，重新用 state vector 对齐。
4. **合并后马上落日志**（§7.1）然后才回 ack。前端以 ack 作为"内核已持有"的依据。
5. 多个会话打开同一份文件时，内核把 update 转发给其他副本（origin=`other_session`）。现在同一文件只开在一个面板里，这条路径先由测试覆盖，暂不在界面上开放。

### 5.3 解决 K1：合并时不再整包保存

改为由引擎直接报告这次 update 影响了哪些部件：
- 首选：fork 里给 `apply_update_v1` 加一个返回值，列出被 update 触及的 slide id 和结构项（幻灯片列表、媒体、主题）。引擎在 yrs 的 `observe_deep` 里能拿到这些信息。这是**fork 的一项小改动**（约 0.5 天），记作 `TODO(engine): apply_update_touched`。
- 过渡：合并前后各取一次 `snapshot()`（只是内存模型，不序列化），按 slide id 比较。比整包保存便宜一个数量级。
- 守卫的最终判定挪到 `save()` 里一次完成（§6.3），合并时只记账，不做序列化。

预算：一次键入的 update 合并加落日志，P95 < 5 ms（文件 20 MB、50 页）。

---

## 6. 保存

### 6.1 谁触发

- **用户编辑**：保持现在的 1.2 s 防抖自动保存语义。前端防抖到点后发 `deck/save {doc_id, upto: 最后一条已 ack 的 seq}`。内核确认这些 update 都已合并，然后保存。**前端不再序列化、不再传字节。**
- **⌘S**（`onSaveRequest`）：和现在一样立即 flush，然后发 `deck/save`。
- **智能体**：写入默认是提议。提议接受后，按写盘审批规则触发 `deck/save`，与 doc 组相同。

### 6.2 流程（沿用并强化 `pptx.rs::write` 的检查）

```
actor：bytes = deck.save()            // 引擎精确保存
     → 守卫（§6.3）
     → Deck::open(bytes) 复核能重新打开   // 现有检查
     → 交给 DeckStore
DeckStore：路径锁 → 读盘取哈希，和 meta.base_hash 比较
     不同 → 返回 conflict（不写），状态变为 conflict
     相同 → atomic::write(path) → 更新 base.pptx、meta.json(hash,size,mtime)
           → 截断日志并记录快照点（§7.2）→ 广播 deck/changed{dirty:false}
```

前端只在收到保存成功的回复后才显示"已保存"，满足 I4。

### 6.3 解决 K2：保存守卫从"只放行幻灯片"改为"按变更集放行"

现在的守卫：改动的部件必须属于"已编辑的幻灯片"。改后的守卫：

1. 引擎（或 §5.3 的记账）给出**意图变更集**，包括被编辑的 slide 部件、新增或删除的 slide 部件、新增的 media、`presentation.xml`（只在幻灯片列表或尺寸变了时）、对应的 `_rels`、`[Content_Types].xml`。
2. 把保存前后的字节做部件级比较（`parts::changed`，已有），得到**实际变更集**。
3. 实际变更集必须是意图变更集的子集，否则拒绝保存，报 `Unexpected`，**不写盘**。
4. 白名单按能力逐项开放（§11），每开放一项都配一条"只动了该动的部件"的测试。

这样守卫仍然能拦住引擎"顺手"改坏其他部件，同时不会挡住插页、移页、加图这些正当操作。

### 6.4 另存为

`deck/save {to}`：写到新路径，不改动原文件的 `base`，条目随之迁移到新的 doc_id。和 DocStore 的 `save(to)` 语义一致。

---

## 7. 持久化与崩溃恢复

### 7.1 工作目录

```
<docs>/<doc_id>/
  base.pptx        打开时或上次保存时的文件
  meta.json        {path, base_hash, size, mtime_ms, contract_version, engine_version}
  updates.log      追加写：每条 = len(u32) + crc32 + update；合并后 fsync
  snapshot.yupd    可选：日志过长时压缩出的全量状态
```

- 每次合并后立即追加日志，之后才回 ack（§5.2-4）。fsync 策略：每条都 fsync，或者每 50 ms 合并一次 fsync，两者取先到的。阶段 4 实测后定。
- 日志超过 8 MiB 或 2,000 条时，在 actor 空闲时写 `snapshot.yupd`（`encode_state`），然后截断日志。快照和日志的切换用原子 rename 完成。
- ~~保存成功后，`base.pptx` 换成新文件，日志清空~~。**实现时改为**：工作目录里的 `source.pptx` 始终是首次打开时的文件，保存后不换基线，日志也不因保存清空，只按大小或条数压缩成快照；`meta.json` 记录磁盘文件的哈希和"磁盘上对应的版本号"（`saved_revision`），`dirty = revision ≠ saved_revision`。原因：换基线等于 CRDT 从头开始，副本每次自动保存（1.2 s）后都得重新加入，前端撤销历史会丢，违反 I6。墓碑长期膨胀（§10）改为在所有会话关闭、且没有未保存编辑时清理目录来解决。
- 内核侧 Deck 用引擎固定的 client id 打开；实测从同一份源文件打开得到逐字节相同的 Yrs 状态，因此重启后"源文件 + 快照 + 日志"能直接重放（K5 的内核一侧不需要改 fork）。副本的 client id 仍须各不相同。

### 7.2 版本与兼容

`meta.json` 记录 `engine_version`（fork 的提交号）。恢复时如果引擎版本不同：先在内存里重放，再用 §6.2 的保存流程（不写盘）试保存一次；能通过守卫就继续，否则把日志备份成 `updates.log.<旧版本>`，提示用户"上次未保存的修改需要用旧版本恢复"。宁可不恢复，也不能写坏文件。

### 7.3 崩溃情景

| 情景 | 恢复路径 | 丢失 |
|---|---|---|
| 渲染进程崩溃或重载 | 重新 `deck/open` 加入现有条目，内核补发全部状态 | 最后一批还没 ack 的本地 update（≤ 一次输入防抖，约 100 ms） |
| deck-worker 崩溃 | `Worker` 发现进程退出，重启后从 `base + snapshot + log` 重放，**换新的 client id**（K5）。前端 provider 自动重连，用 state vector 补发它独有的 update | 无：前端副本里有全部本地编辑，日志里有全部已确认的编辑 |
| finx serve 崩溃或应用退出 | 下次启动打开同一文件时发现残留日志，重放，状态为 dirty。界面提示"恢复了上次未保存的修改"，用户可以保存或丢弃 | 无（已 fsync 的部分） |
| 两边同时崩溃 | 同上一条 | 最后一次 fsync 之后的编辑 |
| 断电导致日志尾部损坏 | 按 crc 截掉坏尾 | 坏尾里的编辑 |

**崩溃循环保护**：同一份文件在 60 s 内让 deck-worker 崩溃 3 次，就把这份文件标记为"隔离"。它的 actor 不再重启，前端退回只读并提示。其他文件不受影响。这避免了一份坏文件反复拖垮整个进程。

---

## 8. 外部修改、冲突与降级

保持现在 `PresentationDoc` 的状态语义，只是判定挪到内核：

| 状态 | 触发 | 行为（与现在一致） |
|---|---|---|
| clean / dirty / saving | — | — |
| conflict | 保存时磁盘哈希 ≠ base_hash，或者磁盘变了而本地有未保存编辑 | 不写盘；界面提供"重新载入磁盘版本"和"另存为"两个选项 |
| deleted | 磁盘文件不见了 | 同上 |
| refused | 只读或受保护路径 | 提示原因 |
| failed | 保存出错（包括守卫拒绝） | 显示错误，保留编辑，可以重试 |
| **disconnected（新）** | 内核失联超过 5 s，或者 provider 缓存溢出 | 编辑器转只读，横幅提示"正在重新连接"；恢复后自动对齐，转回可编辑 |

文件监听沿用现有的 `diskChanged` 逻辑。没有本地编辑时直接换成磁盘版本，内核重建条目，前端换新副本（`generation++`，与现在 `takeDisk` 的行为一致）。

---

## 9. 媒体与大文件（K4）

- **打开**：源文件里已有的图片只在 `base.pptx` 里，不进 CRDT。副本从 `finxdoc://` 拿源字节，不受影响。
- **新插入的图片**：短期沿用引擎的 `pending_media`（base64 在 CRDT 里），单张上限沿用引擎的 `PictureMediaTooLarge` 限制，日志随保存清空。中期在 fork 里改为"CRDT 只存 sha256 引用 + 内核媒体仓库 `<docs>/<id>/media/<sha>`"，副本通过 `finxdoc://` 取字节（`TODO(engine): media_by_ref`）。这一项不阻塞上线，但要在 §13 里登记成风险。
- **EMF/WMF 渲染**：`pptx/metafile` 已经是内核方法，不受影响。

---

## 10. 撤销与智能体

- **用户 ⌘Z / ⌘⇧Z**：继续由前端副本的 UndoManager 处理，只追踪 origin=local。这保证了撤销零延迟、行为不变，也自然做到了"只撤自己的"。
- **智能体的修改**：在内核里以一个独立的 origin 写入。接受提议后作为一个单元记进内核里的 AI 记录，可以单独撤销（`deck/proposal/revert`）。撤销本身也是一个 update，会同步给前端。
- **工具接入**：`finx-core/src/deck.rs` 改为在 `DeckStore` 里有条目时读取条目（可以读到未保存的编辑），没有条目时打开只读的临时条目，不建工作目录。工具说明里"读的是已保存文件"那句要删掉。

---

## 11. 现有能力不回退

### 11.1 能力对照表

"内核侧"一列说明切换之后这项能力靠什么继续工作。任何一项不满足，开关都不能默认打开。

| 能力 | 现在怎么实现 | 切换后 | 风险点 | 回归测试 |
|---|---|---|---|---|
| 打开与渲染（含进度、字体加载、CJK 回退） | `pptx/read` + `loadFonts` | `deck/open` + `finxdoc://` 拉源字节，字体流程不变 | 进度事件 `pptx/readProgress` 要迁到 `deck/open` | e2e `pptx-editor.mjs` 打开用例 |
| 文字输入与编辑 | 副本本地 | 不变，加 update 同步 | 延迟 | 新增：键入后 100 ms 内 ack |
| 文字格式（`formatText`）、段落对齐 | `applyEdits` | 不变 | 无 | 往返测试 |
| 形状位置、填充、描边、背景 | `applyEdits` | 不变 | 无 | 往返测试 |
| 删除形状、层级 | access 方法 | 不变 | 守卫要放行对应部件 | 守卫测试 |
| **插页、删页、移页**（含页序拖拽 `slideReorder`） | access 方法 | 不变，**依赖 §6.3 的守卫改造** | K2 | 新增：每种操作一条"只改了该改的部件"测试，以及 fork `slideOrder.test.ts` |
| 表格行 | access 方法 | 不变 | 守卫 | 往返测试 |
| 功能区命令层（能力检测、格式刷、主题读取 `readPackageInfo`） | `RibbonController(doc.bytes)` | `doc.bytes` 改为源字节（从 `finxdoc://` 获取），语义不变 | 主题和版式信息必须来自源字节加 update，而不是旧的 bytes | `registry` / `geometry` 单测 + e2e |
| 大纲面板 `SlideOutline` | 读副本快照 | 不变 | 无 | `outlineModel.test.ts` |
| EMF/WMF 图片 | `pptx/metafile` | 不变 | 无 | 现有测试 |
| 只读打开 | `writable=false` | 不变 | 无 | e2e |
| 自动保存 1.2 s 与 ⌘S | 前端序列化 + `pptx/write` | `deck/save`（不传字节） | I4 | 新增：保存成功之前不显示"已保存" |
| "未改动不写盘"（字节相同就跳过） | 前端比较字节 | 内核：没有未保存的 update 就跳过 | 无 | 单测 |
| 冲突、删除、拒绝的状态提示 | `diskChanged` | 判定挪到内核，界面不变 | 状态映射 | e2e 冲突用例 |
| 切换面板、标签页时保留编辑器和撤销历史 | `doc.surface` 常驻 | 不变 | 无 | e2e `pptx-panel.mjs` |
| 精确保存（没碰过的部件字节不变） | 引擎 + 内核 `Deck::open` 复核 | 引擎 + §6.3 守卫 + 复核 | — | `finx-slide/tests/decks.rs` |
| 签名包冒烟检查 | `build-app.mjs:314` 走 `pptx/read` | 增加一条 `deck/open → sync → save` 冒烟，老的那条保留到老链路删除 | 打包时漏带依赖 | 打包脚本 |
| 智能体只读工具 | 读磁盘 | 读条目（更强） | 无 | `finx-core` 现有测试 |

### 11.2 保障手段

1. **双链路加开关**：`deck.kernelAuthority`（默认关 → 内部开 → 默认开 → 删老链路）。关闭时走现在完整的 `pptx/read/write` 路径，代码不动。
2. **影子校验**（阶段 3，只在内部开启）：新链路保存时，前端同时 `editor.save()` 一份，和内核保存出的字节做部件级比较。不一致就上报，不影响用户。两周内零不一致才进入下一阶段。
3. **测试矩阵**：fixtures 至少覆盖 `editor.pptx` 加一份 50 页带图表和媒体的大文件，再加一份含 EMF 的文件。每种能力都跑"编辑 → 同步 → 内核保存 → 重新打开 → 内容一致，未改动部件逐字节一致"。
4. **故障注入测试**：用 `Launcher::Thread` 替身在合并中途、保存中途、日志写一半时杀掉 actor，断言 §7.3 表里的"丢失"一列。

---

## 12. 实施阶段

| 阶段 | 内容 | 合入后用户可见变化 | 估时 |
|---|---|---|---|
| 1 引擎门面 | `finx-slide`：K1 过渡方案（快照比较）、§6.3 守卫改造、结构操作的测试；fork 加 `apply_update_touched`（可以并行） | 无 | 2 天 |
| 2 deck-worker 与 DeckStore | 进程、actor、`deck/open/close/sync/save` 方法、工作目录、开关关闭时不生效 | 无 | 2.5 天 |
| 3 前端接入 | `KernelTransport` + provider、`PresentationDoc` 瘦身、状态映射、`finxdoc://` 源字节；开关仅内部开启；影子校验 | 内部版可用 | 2 天 |
| 4 持久化与恢复 | 日志、快照、恢复、崩溃循环隔离、故障注入测试 | 崩溃不丢编辑 | 1.5 天 |
| 5 智能体接入与收尾 | 工具读条目、冒烟检查、文档、默认打开开关 | 智能体能读到未保存的内容 | 1 天 |

合计约 9 天。`deck_edit` / 提议界面（presentation-ai-design §7）在阶段 5 之后开始，直接基于本文的 DeckStore。

每个阶段的退出标准：本阶段新增测试通过；§11.1 里受影响的回归测试通过；`pnpm --dir apps/desktop typecheck`、`cargo test -p finx-slide -p finx-docs` 通过；阶段 3 起还要求 `pnpm dev` 实测。

---

## 13. 可观测性

- deck-worker 每份文件记录：合并耗时 P50/P95、日志大小、快照次数、保存耗时、守卫拒绝次数、崩溃次数。通过现有日志通道输出，不上报到外部。
- 前端记录：ack 往返延迟、provider 状态切换、disconnected 持续时长。
- 守卫拒绝和影子校验不一致时，把多出的部件名和引擎版本记进日志。这是定位引擎问题的主要线索。

---

## 14. 风险与待决

| # | 风险 / 问题 | 应对 |
|---|---|---|
| R1 | 守卫放宽后漏掉引擎的错误写入 | 意图变更集只按能力逐项开放，并配影子校验 |
| R2 | 新图片 base64 进 CRDT，大图导致同步卡顿（K4） | 短期限制单图大小；中期 `media_by_ref` |
| R3 | 引擎升级后旧日志无法重放 | §7.2 先试保存，不通过就备份并提示 |
| R4 | `Deck` 非 Send，线程过多 | 每份打开的文件一个线程，设上限（建议 8）；没有会话查看、也没有未保存编辑时释放线程 |
| R5 | 首次打开变慢 | 设预算并实测，超出就分块传输 |
| PD-K1 | 自动保存是否保留 1.2 s 防抖，还是改为"只在内核里持久化 + 用户 ⌘S 才写回原文件"（表格的做法） | **建议先保留现有行为**，满足"不回退"。是否和表格统一另行讨论 |
| PD-K2 | deck-worker 独立进程，还是 finx serve 里的独立线程 | 建议独立进程（故障隔离）；`Launcher::Thread` 仍用于测试 |
| PD-K3 | 是否借机把 20 MiB 上限放宽 | 建议放宽到 200 MiB，并在阶段 3 用大文件实测后再定 |
