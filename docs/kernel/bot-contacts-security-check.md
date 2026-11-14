# finx 外部 Bot 安全自查（对照 bot-contacts-design §8 风险表）

日期：2026-11-14　范围：一期（外部 Bot 直接聊，内核 + 传输 + 服务层 + 桌面端）
代码基线：commit `4284c679`（及之前的 `23b6d2d6`、`704d1057`、`5c7510ad`、`6c39fb8f`）

| §8 的风险 | 现在的防护 | 证据 | 结论 |
|---|---|---|---|
| 主人不知道话发给了谁 | 确认页写明域名与“话会离开这台 Mac”（回环地址写“这台 Mac 上的另一个服务”）；列表头像右下角链接标记；顶栏名字下显示域名；第一次发消息前的提示，每个外部 Bot 一次（`bots/update noticed`） | `BotSheet.tsx` 确认页、`BotList.tsx` `.bext`、`BotPage.tsx` 顶栏 `.bhead-h` 与 `ExternalNotice`；e2e `e2e_bot_external.rs` 断言 `source.host` 与 `provider` | 通过 |
| 发出去的比主人以为的多 | 桌面端对外部 Bot 换一种拼法，只拼字、图和 Markdown 引用（`externalInput`）；文件、文件夹、正在看的文档、网页批注、标签页一律不拼；输入框不出现“+”菜单和 `/` 命令；服务层再拦以 `Attached files` 开头的块（内核 `Op::Prompt` 对 commands 按假） | `composer/attachments.ts` `externalInput`/`unsendable`；`BotPage.tsx` `files={!external}`、`commands={[]}`、不调 `viewingBlock`；运输 e2e 抓到的 `parts` 只有字和图 | 通过 |
| 对方的话操纵本机的模型 | 一期对端回复不进任何本地模型上下文：没有工具、没有提示词、不请求模型（`start_peer` 不解析模型，`run_peer_task` 只记录） | `kernel.rs` `start_peer`/`resume_peer`；`task.rs` `run_peer_task`；`tests/peer.rs` `the_other_side_answers_without_any_model` | 通过 |
| 对方的话操纵主人 | 防不住内容本身；气泡来源标为 `provider=a2a`、`model=对方域名`，与本地模型区分；界面不显示“已验证” | `task.rs` `deliver_call`；`BotPage` 外部标记与域名 | 通过（内容本身无法防） |
| 对方的文字让应用去联网 | 应用 CSP `img-src 'self' data: blob:`，回复图片只显示替代文字；外部 Bot 关闭 `LocalImages` | `main/index.ts`；`BotPage.tsx` `LocalImages value={!bot.source}` | 通过 |
| 对方的文字指向主人本机的文件 | 外部 Bot 的文字里，本机图片不显示（`LocalImages` false）；文件标签只认 Bot 自己文件夹里的路径（`OwnFilesOnly` 与 `inSession(cwd, path)` 判断） | `session/scope.ts` `OwnFilesOnly`；`session/content.tsx` FileTag 检查；e2e `a_file_from_the_other_side_lands_in_the_bots_folder_with_a_clean_name` | 通过 |
| 对方给的文件 | 文件名清洗（末段、去控制字符、前导点换下划线、120 字符、重名加序号）；写进 `bots/<id>/files/`；单个 50 MB、一轮 200 MB 在传输层边读边计数，超了断流并让任务失败；`url` 不下载；可执行文件按下载处理由桌面端既有策略负责 | `task.rs` `safe_name`/`write_incoming`；`finx-a2a` `net::body`、`events` `Budget`；`tests/peer.rs`、`finx-a2a` 单元测试 | 通过 |
| 冒充 | 确认页完整显示域名；接口必须和名片同源；名字不自动改（`offered_name` 由主人采用）；不显示“已验证”；名片变化只在规则内自动更新 | `finx-a2a` `card::read`（同源、哈希）；`bots.rs` `refresh_card`；`BotPanel` 的 `offered_name`/`needs_review` | 通过 |
| 借服务层探内网 | 名片、图标、接口请求都过 `net::check_url` 与钉住地址的自定义 resolver；拒 127/8、10/8、172.16/12、192.168/16、169.254/16、100.64/10、0/8、组播、广播、240/4、IPv6 私有/组播、NAT64、6to4；不跟跨主机跳转；回环只在 `bots.allow_local` 时放行且不走系统代理 | `finx-a2a/src/net.rs`（`is_private_v4`、`is_private_v6`、`GuardedResolver`、`redirect_policy`）；`net.rs` 单元测试 | 通过 |
| 凭证泄露 | 只进钥匙串，名字 `bot.<id>`；`bot.json`、`BotSummary`、错误信息里都没有；只为登记的那个接口地址发送（客户端固定 URL，跳转不出同源）；删除 Bot 时删凭证 | `bots.rs` `bots_add`/`peer_connection`；`finx-a2a` `Auth` 手写 `Debug` 打码；e2e `a_credential_stays_out_of_the_bot_file_and_its_answers` | 通过 |
| 对方要更多权限 | 对端会话没有工具，不会出现授权窗口；`AUTH_REQUIRED` 只当“凭证不行了” | `task.rs` `run_peer_task`；`finx-a2a` `events.rs` AUTH_REQUIRED → `bot_auth_required` | 通过 |
| 对方拖着不回 | 流上 60 秒无事件走 `resume`（先 `GetTask` 再 `Subscribe`，三次不成即失败）；2 分钟后桌面出现“不等了”，走现有的中断，向对方发 `CancelTask` | `task.rs` `PEER_IDLE`/`PEER_RECONNECTS`；`BotPage.tsx` `WaitingNote`；`finx-a2a` `client.rs` resume | 通过 |
| 传输层内存 | SSE 每轮最多 320 MB、非流式 80 MB、错误体 64 KB；单个文件 50 MB、一轮 200 MB、单条文本 1 MB；超限后流立即结束（body 状态置空），错误归为不可重试的 `bot_peer_too_large`，不会 resume 重读 | `finx-a2a` `net::body`、`client::stream_failure`、`events::Budget`；单元测试与 `a2a-fake` 端到端 | 通过 |

## 与方案的差距（一期交付时明确）

1. **名片图标不做服务端 256×256 重编码**：仓库没有图像解码依赖，上传头像本来也由桌面端缩放。现在只收 PNG（签名校验）并限制 1 MB，原样作为 `data:image/png` 给客户端；服务端不渲染它。若以后需要统一尺寸，再加图像库。
2. **凭证方案变了只提示、不硬拦**：`needs_review` 会在设置里显示并要求确认，但在确认前没有在内核发送路径上阻断。硬拦需要一个会话级“暂停发送”的协议，留给二期或后续补丁。
3. **名片刷新不改头像**：主人换过的头像自然不动；没换过的也不跟着图标变，避免误伤。方案里的“没换过就跟着换”没有实现。
4. **配置在服务启动时读取**：`[bots] external/allow_local` 启动后不热更新，需要重启 finx 生效（与现有部分配置一致）。
5. **启动补查**只对“日志里有未结束任务”的外部 Bot 重新加载会话（会触发对方任务续查并算未读）；没有未结束任务的 Bot 保持不常驻（D-707）。