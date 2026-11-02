# ChatGPT API 订阅连接与联调

日期：2026-11-02。实现位于 finxwork，覆盖原生 Rust 内核、CLI、桌面模型设置和首次启动页。自动测试使用隔离的 OAuth / Responses 服务，真实 ChatGPT 账户的授权、可用模型及订阅扣量由最终联调确认。

## 接入方式

“ChatGPT API”使用 Sign in with ChatGPT 的直接订阅授权。用户授权后，finx 从 `https://api.openai.com/v1/models` 获取该账户的模型，直接调用 `/v1/responses`，复用 finx 自己的上下文和工具循环。它不启动 Codex CLI 或额外网关，也不读取 Codex 的登录文件。OpenAI API Key 仍作为独立的模型来源配置。

该公开动态注册流程面向开源及本地托管应用；付费或远程托管分发应走 OpenAI 的接入申请流程，代码接通不代表分发资格已经确认。参见 [官方接入范围](https://developers.openai.com/siwc/token-sharing-open-source)。

当前每个 `FINX_HOME` 保存一个账户注册。断开会撤销可续期会话、清除凭据，保留 host ID 和已验证账户的 client ID；重连复用同一注册。更换账户时先断开，再选择“忘记账户”，然后重新授权。忘记保留 host ID，但清除账户注册信息。不同注册使用不同 provider ID，避免旧任务意外切换账户。

首次注册的 `agent_name_hint` 为 `FinxWork`；重新登录既有注册时不发送该参数，因此升级不会自动改写已经注册的 `Finx` 名称。当前官方动态注册参数未提供自定义 Logo 字段，不能通过授权 URL 配置 OpenAI 托管页面上的应用图标。[官方注册参数](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

## 内核和桌面边界

| 位置 | 职责 |
| --- | --- |
| `finx-connections/src/chatgpt.rs` | OAuth、身份与权限验证、凭据存储、按需刷新、模型目录、退出与移除 |
| `finx-llm/src/api/openai_responses.rs` | Responses 请求、SSE、工具调用、加密推理内容回传、用量与失败分类 |
| `finx-server` / `finx-protocol` | 登录进度 RPC、连接快照和模型变更通知 |
| `finx-cli` | 装配同一连接管理器；chat、exec、serve、ACP 共用订阅模型 |
| 桌面 `ChatGptConnection` | 浏览器登录、取消、账户状态、模型管理、断开、忘记和用量链接 |

新增 RPC 为 `chatgpt/login`、`chatgpt/status`、`chatgpt/cancel`、`chatgpt/logout`。模型刷新复用 `connections/models`，移除复用 `connections/remove`，其 `connection_id` 为 `chatgpt-api`。公共 DTO 不包含访问令牌、刷新令牌或 ID Token。

注册使用一次性 state、nonce 和 S256 PKCE，以及仅绑定 `127.0.0.1` 的临时回调。首次请求使用 `dynamic_agent_client`；回调签发的 client ID 在换码前保存。回调中的不同 client ID 不能覆盖既有注册。ID Token 按 OpenAI discovery / JWKS 校验 RSA 签名、issuer、audience、expiry、nonce 和 subject。只有授予 `chatgpt.tokens.use.direct` 才启用推理；缺少该权限时保留已验证身份，下一次用户主动连接请求重新同意权限。[官方注册协议](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

非秘密配置位于 `$FINX_HOME/connections/chatgpt/profile.json`。macOS 凭据使用现有系统钥匙串实现，按 FINX_HOME 隔离账户键；其他平台使用该目录中的私有凭据文件。`FINX_CREDENTIAL_STORE=file` 可用于隔离测试。目录权限为 0700、文件为 0600。独立文件锁串行化不同进程的 token 刷新，每次刷新都重新读取最新凭据。临时网络失败保留连接；失效或重用的 refresh token 清除并要求重新登录。

退出会尝试远程撤销。若撤销无法确认，仍可在本机断开并删除凭据，同时提示到 [ChatGPT 用量设置](https://chatgpt.com/settings/usage) 移除授权。同一次订阅推理失败不会自动改用 API Key 计费。[官方会话生命周期](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

## 推理行为

每次 HTTP 请求使用 `store:false`、`stream:true` 和完整 input 历史，不使用 `previous_response_id`。系统指令放在 instructions；finx 工具放在命名空间中，由现有内核执行。工具调用与结果、图片输入和加密 reasoning item 能继续多轮对话。采样参数、输出上限和任意 extra_body 不透传到该受限路线。

只有收到 `response.completed` 才成功。额度错误、中途断流、无效工具参数、`response.failed` 和 `response.incomplete` 均不能触发成功收尾。可用模型和思考等级来自账户模型目录，不硬编码型号、不补入 Codex 的缓存目录。[官方推理要求](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## 自动验证

在仓库根目录运行：

```sh
cargo build -p finx-cli
cargo test -p finx-connections -p finx-llm -p finx-protocol -p finx-server -p finx-cli
node crates/finx-connections/tests/chatgpt-e2e.mjs
pnpm --filter @finx/protocol test
pnpm --filter @finx/client test
pnpm --filter @finx/desktop test
pnpm --filter @finx/desktop typecheck
pnpm --filter @finx/desktop build
pnpm --filter @finx/desktop e2e:chatgpt
```

2026-11-02 验证结果：上述 Rust 范围 181 项通过、1 项原有忽略项；桌面单测 61 项、客户端单测 44 项通过；协议生成校验、桌面类型检查与构建、两套端到端流程均通过。Clippy 可运行完成，但严格 `-D warnings` 仍会被仓库原有的 8 项告警阻止，涉及 Qoder、QwenWork、原有连接失败处理及 CLI 的 needless_borrow，本次没有改动这些无关代码。

端到端测试启动真实 finx 进程、Electron 窗口及临时 FINX_HOME，模拟 OAuth 和模型 HTTP 服务，不使用个人账户。覆盖：

- 拒绝授权、签发 client ID 后换码失败、签名/nonce/issuer/audience/过期校验、缺少订阅权限。
- 错误回调 state、并发登录、取消等待及换码中的登录、关闭设置后恢复授权。
- CLI 登录后的服务器模型目录同步、多个进程的刷新竞争、401 后一次刷新。
- 真实 CLI 工具调用和内核 read 工具执行、推理内容和工具结果的后续回传。
- HTTP 与流内的额度错误、断流失败、退出撤销失败提示、账户移除和更换。
- 桌面模型管理、模型选择、发送任务并收到回复、断开与忘记。

仅 debug 构建且 `FINX_CREDENTIAL_STORE=file` 时接受 `FINX_TEST_CHATGPT_BASE`，地址只能是 HTTP `127.0.0.1`。release/dist 构建不接受端点覆盖。真实联调不要设置该测试变量。

## 真实账户联调

1. 构建并重启使用本次二进制的 finx 服务和桌面。桌面开发模式可用 `FINXWORK_FINX` 指向仓库 `target/debug/finx`；CLI 和桌面使用相同 FINX_HOME。
2. 打开“设置 → 模型 → 使用订阅 → ChatGPT API”，点击“使用 ChatGPT 继续”。在系统浏览器选择账户和工作区，并明确授予使用订阅额度的权限。
3. 确认账户名称和模型目录出现；打开“管理模型”，刷新并选择一个实际列出的模型。
4. 在桌面发送普通问题，再执行一次需要读取本地文件的任务。通过“管理用量”核对 ChatGPT 侧的授权和用量。
5. 重启桌面和 CLI，确认无需重新注册即可使用；断开后确认模型移除，再重连检查同一账户注册被复用。

CLI 可独立执行相同流程：

```sh
./target/debug/finx models login chatgpt-api
./target/debug/finx models status chatgpt-api
./target/debug/finx models --all --json
# 将下面的引用替换成上一步列出的真实 provider/model ID
./target/debug/finx chat --model '<provider>/<model>' '只回复 hello'
./target/debug/finx chat --model '<provider>/<model>' --tool-test '请调用 get_time 告诉我现在的时间'
./target/debug/finx models logout chatgpt-api
# 仅在要清除注册、改用另一账户时执行
./target/debug/finx models forget chatgpt-api
```

如果账户或工作区不符合资格，保留该错误用于联调，不自动回退到其他来源。额度限制可能来自应用授权上限，不应直接理解为整个订阅都已耗尽。真实模型可用性、最终扣量与商业分发接入状态不由本地模拟测试证明。
