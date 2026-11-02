# 内核内模型连接：架构与接口

日期：2026-10-29。状态：已实现，替代早先的独立 Node 网关方案。

后续扩展方案见 [Qoder 模型连接机制设计](qoder-connection-design.md)，Qoder 首版的多适配器与请求级传输已实现，等待事件和 legacy 仍属后续设计。

ChatGPT 订阅直连的实现、测试和真实账户联调见 [ChatGPT API 订阅连接](chatgpt-api-design.md)。

## 决策

模型连接能力运行在已有 `finx` 服务进程中。产品协议以独立 Rust crate 隔离，桌面不运行第二个模型网关，不安装 Node 运行时或 LaunchAgent。推理直接从现有模型调用层请求远端。

```mermaid
flowchart LR
  UI[桌面设置页] -->|现有本地 RPC| SERVER[finx-server]
  SERVER --> CONNECTIONS[finx-connections 连接管理]
  CONNECTIONS --> QWEN[千问适配器]
  CORE[finx-core 任务与工具循环] --> LLM[finx-llm 通用协议]
  LLM -->|请求级授权接口| CONNECTIONS
  LLM -->|直接 HTTPS / SSE| REMOTE[远端模型]
  QWEN -->|登录与模型授权| SOURCE[本机来源应用 / 授权服务]
```

## 模块职责与依赖

| 模块 | 负责 | 不负责 |
|---|---|---|
| 桌面 Renderer | 扫描、连接、重试、断开、删除、状态展示；使用现有 RPC | 读凭据、签发模型 token、转发推理 |
| Electron 主进程 | 原有内核监管、打开来源应用；一次性退役旧网关 | 安装新网关、承载模型授权 |
| finx-server | 公开管理 RPC、模型变更通知、装配连接管理器 | 千问域名、凭据格式、换发策略 |
| finx-connections | 配置与身份绑定、并发租约、连接生命周期、产品适配器、钥匙串读写 | 任务提示词、工具执行、模型流解析 |
| finx-llm | 通用 ConnectionAuthorizer / ConnectionRequest 接口、协议序列化与 SSE 解析、HTTP 客户端、有限重试 | 千问特定字段与本机文件格式 |
| finx-core | 原有任务、上下文、工具与审批 | 产品适配器实现 |

`finx-connections` 依赖 `finx-llm` 的接口与 `finx-protocol` 的公共 DTO；`finx-llm` 不依赖 `finx-connections`。服务器装配二者，避免循环依赖。内核的 HTTP 客户端由模型层惰性创建，并在授权请求与推理之间复用。

同进程不提供进程级故障隔离。供应商适配器变更不修改任务内核代码，但仍需要重新构建和发布内核二进制。

## 生命周期与资源

- 初始化只读取非秘密配置和缓存目录；没有连接时不访问千问、钥匙串或网络，不创建轮询、续期任务、监听端口或辅助进程。
- 只有打开模型设置或手动扫描才执行安装检测；这可能短暂调用系统 `plutil`，不产生常驻网关。
- 连接时读取来源账号，发现目录，准备独立模型 session；私密 session 保存到独立的 Keychain 命名空间。
- provider ID 由来源应用和账号身份摘要生成：`local-<adapter_id>-<摘要前 12 位>`，与随机的 connection_id 无关。同一账号移除后重新连接，发布的 provider/model ID 不变，用过它的会话接着用原模型。此前写入的连接记录没有 provider ID，继续使用 `local-<connection_id>`。快照中的 `ConnectionView.provider_id` 给出它，桌面不自行拼接。
- 断开或移除连接后，用过它的会话仍能打开：恢复会话时找不到上次所用模型的服务商（`UnknownProvider`），就改用配置的默认模型，并发出一条警告说明原模型暂不可用；会话日志不改写，连接恢复后再打开即回到原模型。明确指定了模型的恢复不做替换。
- 已启用连接在内核重启后从缓存恢复稳定 provider/model ID。恢复时的 ready 表示配置可用；授权有效性在实际请求前核实，不通过空闲刷 token 维持状态。
- 每次推理取得一个请求租约，核实来源身份，按需恢复/换发授权；请求结束或取消即释放租约。
- 断开先禁用新请求、持久化状态、从可选模型中移除连接，再等待当前请求结束。删除仅接受已禁用且无活跃请求的连接。
- 桌面退出后，原有 Rust 服务继续处理已提交任务。连接模块不改变内核已有的空闲退出策略。

连接不限制并发：同一连接上的多个请求（主会话与子智能体等）同时进行，和直连的模型服务商一样。租约只用于计数，断开时等全部请求结束。

## 授权边界

`finx-llm::connection` 定义：

- `ConnectionAuthorizer::begin(provider, model, http)`：验证连接与模型，取得请求租约。
- `ConnectionRequest::authorize(rejected)`：返回本次请求的一致 `base_url + Credentials`。
- `ConnectionRequest::cancellation()`：连接级取消信号。
- `ConnectionRequest::failed(error)`：更新连接状态；错误保留网关原话，但去掉可能代表账户的长串（token、session 与请求 ID），截到 500 字，并写入内核日志。千问网关的 429 表示一时的请求或 token 份额用完，用的却是 OpenAI 表示欠费的措辞：原话不提欠费、余额、充值时按限流处理，自动重试（2026-11-02 观察到：同一账户在同一时刻有的请求成功、有的报这个错）。

授权结果不实现 Debug 或 Serialize；动态请求头保存在 Credentials，Debug 不输出其值。账号 token、模型 token、session_id 不进入模型目录、桌面 RPC、历史任务模型元数据或普通日志。

产品适配器独立生成模型 session。来源应用登录文件只读，不刷新来源 refresh_token，不写回其账户与模型凭据文件。账号发生变化时取消当前连接并要求显式断开、移除、重新连接。

会话换发依据实际 TTL，采用请求触发、适配器互斥和失败退避。明确收到 401 且还未输出模型内容时，模型层允许一次重新授权和重发；第二次 401 直接失败。流已经输出内容后不重放请求。

远端地址、路径与客户端版本仍由产品适配器检查。HTTP 禁止自动跟随重定向，避免动态授权被带到未验证的目标。macOS 仍使用系统证书校验；没有关闭 TLS 验证。

## 管理协议

沿用 finx 原生协议版本 2，增加 `model_connections` 能力位。新桌面要求该能力位，旧内核由现有监管器在没有活跃任务时替换。

| RPC | 入参 | 返回 |
|---|---|---|
| connections/discover | 空对象 | `{ discoveries: ConnectionDiscovery[] }` |
| connections/list | 空对象 | `{ revision, connections: ConnectionView[] }` |
| connections/connect | adapter_id、discovery_id、idempotency_key | 完成后的连接快照 |
| connections/retry | connection_id | 重新核实身份、刷新目录与授权后的快照 |
| connections/models | connection_id | 与 retry 同样重新核实并刷新 |
| connections/disconnect | connection_id | 禁用并等待当前请求结束后的快照 |
| connections/remove | connection_id | 删除后的快照 |
| models/changed | 内核通知 | 客户端重新拉取模型与连接状态 |

管理操作异步执行，不阻塞 Rust 事件循环，但 RPC 本身在操作完成后回复；不再保留跨进程 operation_id 轮询。错误使用 JSON-RPC error，data.kind 提供稳定分类。连接配置在远端签发前落盘；idempotency_key 防止重复创建本地连接，不保证远端签发 exactly-once。

状态：connecting、ready、disabled、needs_login、permission_required、unsupported、unavailable。同进程同步目录，不再需要 kernel_sync、源租约、心跳、动态代理端口或本地访问密钥。

源码类型及生成 schema 是接口事实来源：`finx-protocol/src/api.rs`、`schema.json`、`packages/protocol/src/generated.ts`。

## 从旧网关迁移

桌面启动时只对当前 FINX_HOME 的旧 LaunchAgent 执行一次迁移：停止接收新请求、等待在途推理完成、bootout、确认退出，将 plist 移到 `connections/legacy/*.retired`。此后不会重新安装或启动它。

原有 `connections/config.json`、connection_id、账号绑定和本服务 Keychain 命名空间保留，Rust 适配器直接读取。旧运行时目录保留为迁移遗留文件，不再执行。迁移等待失败时不启动新的连接所有者，防止两个实现同时换发同一个 session。

## 验收和边界

当前兼容范围仍为 macOS、QwenWorkCN 1.4.0、标准账户、文字、图片与工具调用。千问办公的目录不标图片能力，其模型一律按可收图处理（flash 已实测）。真实跨 TTL 的长时间连续换发与系统睡眠测试仍独立列为待验证项。

其他供应商新增表单仍是此前 Demo，未在本次重构中扩展为真实 BYOK 配置。原有内核 BYOK 通路继续使用。
