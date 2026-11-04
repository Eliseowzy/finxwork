# Qoder legacy 通道可行性验证（2026-11-04）

日期：2026-11-04。账户：本机 Qoder 0.4.11 全球版登录的账户。模型：以 Qwen3.8-Flash（`qfmodel`）为主，15 个模型各做了一次准入探测。代码：`crates/finx-connections/src/qoder/`（未提交）。

## 1 结论

legacy 通道在协议层面**可行**，并且解决了新版 HTTP 通道的请求体上限问题：

- 新版 HTTP（`api2-v2.qoder.sh/model/v1`）：请求体超过约 256 KiB 就返回不带说明的 HTTP 500，不论 `context_length` 取 18 万、20 万还是 100 万。按中文估算约 6 万 token，远低于目录声明的 20 万窗口。
- legacy（`api3.qoder.sh` 的 `agent_chat_generation`）：325 KB、74,569 个输入 token 的请求正常返回。它的上限是 50 MiB，超过时返回明确的 413 `request_too_large`。

legacy 的主要代价在于**可用性**：这个账户在 legacy 上属于 p3 低优先级队列，常见回复是 10605 / `RESOURCE_LIMIT`。实测每次模型调用排队 0 秒到约 7 分钟不等，同一任务的后续调用也可能要重新排队。Qoder 自己的客户端在同一账户上同样如此：其日志里 10 月 29 日 10:19 之后的 8 个任务，每次调用都在排队，最后都在没有输出的情况下结束。新版 HTTP 通道从未排队。

选路（2026-11-04 定）：**所有请求都走 legacy，只有 legacy 不可用时才降级到新版 HTTP**。两个通道的提示缓存互不相通（L6 中切换后第一次调用的 59,832 个 token 全部未命中），按大小来回切换会让缓存一再失效，比排队更糟；排队不影响选路，由内核重试等待。不可用的判定和降级规则见设计文档 §7。

## 2 实现位置与边界

全部实现位于 Qoder 适配层，内核（finx-core、finx-llm）没有改动：

| 文件 | 内容 |
|---|---|
| `qoder/route.rs` | 选路：固定走 legacy，不可用时降级到新版 HTTP 并保持，直到目录重新读取；`FINX_QODER_ROUTE=http\|legacy` 用于诊断时强制指定 |
| `qoder/legacy/mod.rs` | legacy 传输（`WireApi`）、目录条目 `Target`、请求发送与返回读取 |
| `qoder/legacy/codec.rs` | `Encode=1` 请求体编码 |
| `qoder/legacy/body.rs` | 请求体：沿用内核的 OpenAI 消息转换，只套 Qoder 外层 |
| `qoder/legacy/reply.rs` | 返回流、文本形式的工具调用、错误分类 |
| `qoder/legacy/queue.rs` | 排队状态查询、名额释放、账户级排队表 |
| `qoder/cosy.rs` | 签名可覆盖请求体；区分普通请求与推理请求的请求头；客户端版本号收敛为常量 `VERSION` |
| `qoder/mod.rs` | 授权时返回 `Route`；共享目录条目缓存与排队表 |

插拔与升级：

- 内核只看到一个普通的 `WireApi` 和标准流事件；legacy 整个目录可以单独替换或删除，停用它只需改 `route.rs`。
- Qoder 桌面应用升级时，签名版本号只改 `cosy::VERSION` 一处；协议细节都集中在 `legacy/` 目录内。
- 会话 id 和任务 id 在适配层内由对话推导（会话键和最后一条用户消息的哈希），不依赖设计中原计划由内核提供的轮次作用域（§4.3）。

## 3 协议要点

| 项 | 内容 |
|---|---|
| 地址 | `POST https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` |
| 签名 | COSY：签名覆盖编码后的请求体和去掉 `/algo` 的路径；推理请求不带 `Cosy-ClientIp`、`Cosy-MachineToken`、`Cosy-MachineType`，另加 `X-Model-Key`、`X-Model-Source`、`X-Request-ID`、`X-Session-ID` |
| 编码 | 换字母表的 base64，以 `$` 补位，再交换首尾两个三分之一；体积变为 4/3 |
| 请求体 | `request_id`、`request_set_id`（任务）、`chat_record_id`、`session_id`、`parameters`（`enable_thinking`、`max_tokens`、`reasoning_effort`、`context_length`）、`business`（`stage` 为 start 或 processing）、`model_config`（目录条目中的 9 个字段，不发送整个条目）、`system`、`messages`、`tools` |
| 消息 | 用户消息的内容块同时放进 `contents`；最后一条是用户消息时，其最后一块标 `cache_control`；思考随之前的助手消息以 `reasoning_content` 回放 |
| 返回 | SSE `data:` 行，每行是 `{statusCodeValue, body}`，`body` 是 OpenAI 流式块或 `[DONE]` |
| 工具调用 | 原生 `tool_calls`；参数先于名称到达时先缓存，等有了名称再发出。另外兼容正文中的 `<tool_call>` 块（JSON 格式，或 `<function=…><parameter=…>` 格式），只认请求中声明过的工具，代码块里的不算 |
| 系统提示 | 直接使用 finx 自己的，不追加 Qoder 的 Agent 提示词；实测不需要 |

错误分类：10605 / `isQueued` → 过载，带等待时间；413 或 `request_too_large` → 上下文超限（内核会压缩后重试）；输入过长 → 上下文超限；额度相关错误码 → 额度用尽；`Session blocked` → 内容拦截；`Error in upstream response` → 服务端错误（可重试）；403 + 错误码 101（签名无效）→ 协议错误，不标记为登录失效；其他 401/403 → 授权失效（内核会重新授权一次）。

## 4 排队

实测行为（本账户，p3）：

- 被拒时返回 HTTP 403，内层是 `{"code":"10605","message":"{\"isQueued\":true,\"queueType\":\"p3\",\"queueCount\":0,\"retryAfterSeconds\":30,\"serviceAvailable\":false,\"subCode\":\"RESOURCE_LIMIT\"}"}`。
- 状态查询 `GET /algo/api/v2/service/ask/queue/status?requestSetId&modelKey&queueType` 通常 30 秒后返回 `isQueued:false, retryAfterSeconds:2`；照此等 2 秒重发，常常又被排队，要重复几轮才能排上。不带 `/algo` 的路径在 finx 这边返回非 2xx。
- 释放：`POST /algo/api/v2/service/ask/finish?Encode=1`，请求体是 `{"payload": "{model_key, request_set_id, user_id, time_consumed}", "encodeVersion": "1"}`（编码后发送），返回 200。

实现：

- 被拒后立即查一次状态；已就绪就等它要求的秒数后，用同一个 `request_set_id` 重发。
- 仍在排队时，本次尝试以"过载"结束并带上等待时间，由内核现有的重试来等待。界面显示"Qoder 正在为该模型排队，稍后自动重试"，等待上限沿用内核的 10 分钟重试窗口。
- 下一次尝试先查状态，再决定是否重发。
- 名额释放的时机：一轮以不含工具调用的回复结束时；同一会话开始新任务时（旧任务必然已结束）；排队中的任务 90 秒无人查询时，视为已放弃（内核等待期间最多 30 秒就会再查一次）。

## 5 验证矩阵

| 编号 | 内容 | 结果 | 排队 |
|---|---|---|---|
| L0 | 小请求（"回复两个字：在线"） | 通过：思考流、正文和用量都正常 | 无 |
| L1 | 325 KB / 74,569 token 的请求（新版 HTTP 上必定 500） | 通过：回复 OK | 约 3 分钟，重试 5 次 |
| L2 | 原生工具调用（`finx chat --tool-test`，`get_time`） | 通过：调用工具并取得结果后给出回答 | 约 5 分钟；工具结果那次调用也重新排队约 65 秒 |
| L3 | 真实内核任务（`finx exec` 读文件并回答其中的数字） | 通过：调用 `read`，答案 4721 正确；第二次调用 3,280/3,312 个输入 token 命中缓存 | 约 2.7 分钟；第二次调用没有排队 |
| L4 | 图片 | 未验证：连接记录中 qfmodel 的 `images` 为 false，内核没有发送图片 | 无 |
| L5 | 思考档位 `high` | 通过：`reasoning_effort` 被接受，答案 271 正确 | 约 4 分钟 |
| L6 | 按大小选路时（之后改为固定 legacy）的真实任务：`finx exec` 依次读取 8 个各约 40 KB 的中文文件 | 选路通过：请求从 12 KB 涨到 226,419 字节都走新版 HTTP，每次 1–5 秒，缓存持续命中；下一次 267,044 字节自动改走 legacy，排上后收到完整上下文（59,832 个输入 token）。这个请求在新版 HTTP 上会失败。任务本身没有完成：模型在读完第 6 个文件后就结束，回答成了第 6 个文件的标记，这是模型的判断，不是通道丢了内容 | legacy 那次约 6.8 分钟，重试 12 次 |
| L7 | 50 MiB 上限 | 通过：41.4 MB 原文（编码后约 55 MB）19 秒后收到 413 `Request body size exceeds maximum allowed 52428800 bytes`，归为上下文超限 | 无 |
| 默认通道 | 改为固定 legacy 后，不设任何环境变量发一个小请求 | 通过：走 legacy，排队约 1 分 47 秒后回答，结束时释放返回 200 | 约 1 分 47 秒 |
| 准入 | 15 个模型各发一次小请求，不重试 | auto 直接通过；其余 14 个都在 p3 队列 | |
| 释放 | `ask/finish` | 每个排过队的任务结束时都返回 200 | |

离线测试：`finx-connections` 共 67 项通过（另有 4 项真实链路测试默认忽略），其中 legacy 与选路新增 15 项，覆盖编码参考向量、请求体结构、返回顺序、文本形式的工具调用、错误分类、排队与释放流程（模拟服务）、目录按需读取，以及选路：始终走 legacy、排队不降级、不可用时本次和之后的请求降级、只降级目录里没有的模型、目录读不到时重试而不降级、降级后超大请求的 500 识别为上下文超限。

## 6 未验证与风险

- **可用性**：p3 队列由账户套餐和全局负载决定，finx 无法改变。排队期间界面只显示重试提示，用户等待时间不可预期；同一任务的多次调用可能分别排队，多个子智能体并行时会互相争用。超过内核 10 分钟重试窗口仍未排上时，任务以"Qoder 正在为该模型排队"结束，而不是以前那个含糊的 500。
- **切换通道会丢一次缓存**：从新版 HTTP 转到 legacy 的第一次调用没有命中缓存（L6：59,832 个 token 全部计为未缓存），之后同一通道内照常命中。这是固定走 legacy 的原因；降级只在 legacy 不可用时发生一次，此后不再切回，直到目录重新读取。
- **图片**：真实链路未验证，需要连接目录把模型声明为支持图片。
- **大于 20 万 token 的档位**：只验证了 `context_length` 的选择逻辑。默认档是 20 万，内核也按 20 万压缩，所以不会用到更大的档位；更大档位"可能改变费率"，默认不开放。
- **其他模型的工具调用形式**：只实测了 qfmodel 的原生工具调用。正文中不带 `<tool_call>` 包裹的 XML 调用（部分模型会这样写）尚未处理，出现时会显示为正文，不会被当成工具调用执行。
- **协议依赖逆向**：客户端代码是混淆过的。签名版本号固定为 1.1.69，需要跟随 Qoder 桌面应用升级；协议一变，legacy 就会失败。它失败时不会被悄悄换到另一条通道。
- **温度**：legacy 请求不发送 `temperature`，客户端这样做的证据不足。
- **设备身份**：不发送设备身份相关的请求头（客户端没有读到设备身份时也不发）。

## 7 复现

- 离线：`cargo test -p finx-connections legacy`、`cargo test -p finx-connections route`。
- 真实（会计费，且可能排队数分钟）：`FINX_QODER_TEST_HOME=~/.finx cargo test -p finx-connections live_qoder_legacy -- --ignored --nocapture`。
- 诊断：`FINX_QODER_ROUTE=legacy finx chat -m <provider>/qfmodel`；`FINX_LOG=finx_connections=debug` 时日志里会记录 `qoder_route`、`qoder_queue_status`、`qoder_queue_finish` 和脱敏后的 `qoder_legacy_failure`。
