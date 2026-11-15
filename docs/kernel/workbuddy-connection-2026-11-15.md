# WorkBuddy 模型连接实现与验证

2026-11-15。已在 macOS 上使用本机 WorkBuddy 5.11.3、内置 CLI 2.176.0 验证并接入。finx 使用来源应用当前个人账户的 access token，直接访问 WorkBuddy 云端模型网关；沿用 `finx-connections` 和现有模型注册器，不依赖 magpie 服务。

## magpie 的两种接入方向

magpie 是统一模型网关和客户端配置管理器。WorkBuddy 在其中有两个不同角色：

- **作为模型客户端**：`internal/agent/workbuddy.go` 修改 `~/.workbuddy/models.json`，使 WorkBuddy 的模型选择器出现 magpie 模型，请求发往 magpie 本地 `/v1/chat/completions`。这条路径不能用于取得 WorkBuddy 账户自己的模型服务。
- **作为模型来源**：当前实现已迁移到 `magpie-community/plugins` 的 `packages/workbuddy/index.mjs`，插件名为 `@magpie-community/opencode-workbuddy-auth`。读取桌面账户或建立独立浏览器登录，取得模型目录并向腾讯网关发送请求；magpie 负责向其他模型客户端提供统一入口。

参考版本：

- [magpie provider 的迁移说明和本机账户结构](https://github.com/yetone/magpie/blob/9bcdcfb7d1c362b4f297a93a4ef6b5444f999da5/internal/provider/workbuddy.go)
- [magpie 的 WorkBuddy 客户端配置](https://github.com/yetone/magpie/blob/9bcdcfb7d1c362b4f297a93a4ef6b5444f999da5/internal/agent/workbuddy.go)
- [当前 WorkBuddy provider 插件](https://github.com/magpie-community/plugins/blob/2f8f061a2c65d42225e6bf3a164924b3a7421be6/packages/workbuddy/index.mjs)

插件的 `readDesktop` 只接受字符串 token；`notDesktop` 明确提示加密登录文件需改走浏览器登录。它的独立登录刷新通过 `/v2/plugin/auth/token/refresh`，桌面借用模式则每次重读原应用登录文件，避免双方竞争旋转 refresh token。

## 网关和请求协议

本机版本的中国版主要入口是 `https://www.workbuddy.cn`，magpie 插件中国版使用 `https://copilot.tencent.com`。安装包 `main/common.js` 同时列出这两个入口及备用域名；finx 本次验证和实现固定使用前者，不根据登录文件任意拼接请求主机。

| 功能 | 本次验证的请求 |
| --- | --- |
| 模型目录 | `GET https://www.workbuddy.cn/v3/config` |
| 流式推理 | `POST https://www.workbuddy.cn/v2/chat/completions` |
| HTTP 认证 | `Authorization: Bearer <accessToken>` |
| 账户上下文 | `X-User-Id`、`X-Domain` |
| 客户端版本 | `User-Agent: WorkBuddy/5.11.3 WorkBuddy/5.11.3 CLI/2.176.0` |
| 客户端标识 | `X-Product: SaaS`、`X-IDE-Type/Name: WorkBuddy`、`X-IDE-Version` |
| 请求类型 | `X-Requested-With: XMLHttpRequest`、`X-Agent-Intent: craft`、`X-Agent-Purpose: conversation`、`X-Agent-Type: main`、`X-Agent-Runtime: local-agent` |

请求主体采用 OpenAI Chat Completions 格式，使用 `max_tokens`、`reasoning_effort` 和 `stream: true`。返回 SSE，包括 `reasoning_content`、工具调用增量、usage、终止原因和 `[DONE]`。版本从本机安装元数据读取，不把上表版本写死到适配器。

目录读取 `data.agents[name=cli].models`，再与 `data.models` 的声明交叉匹配，不能把总表中的补全、图片或视频模型全部发布为聊天模型。本次账户目录为 17 项，包括 Auto、Hy4、Hy3、DeepSeek、GLM、Kimi、MiniMax、Step 和 MiMo。上下文、输出上限、图片声明、思考档位均取实际目录。模型目录可读不等于账户对每个模型均有推理权限。

## 本机加密登录读取

macOS 来源文件为：

```text
~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
```

本机 `auth.accessToken` 是 `{$wbEncrypted: 1, envelope: ...}`，不是 Bearer 字符串。对安装包的只读分析定位到：

- `main/file-authentication-storage.js`：登录文件路径、字段编解码、`.logged-out` 登出标记。
- `main/credential-protection.js`、`main/src.js`：`sym-v1` 字段的 AES-256-GCM、AAD 格式和 key ID 校验。
- `main/index.js`：通过 `electron.workbuddyStorage.loggerGet()` 获取运行时包装材料。
- 原生 binding `electron_browser_workbuddy_storage`：在本机安装版本的 Node 模式下可调用 `loggerGet()`。

`reader.cjs` 通过 WorkBuddy 自带 `Contents/MacOS/Electron` 的 `ELECTRON_RUN_AS_NODE=1` 模式短时执行。Rust 把来源 JSON 送入私有 stdin 管道，辅助进程只返回 uid、解密 access token、到期时间、域名和企业标记。它不启动桌面主流程、不监听端口、不调用网络、不写登录文件，也不返回 refresh token 或包装密钥。finx 没有嵌入厂商密钥。

旧版明文字段可直接读取；未知加密方案、key ID 不匹配、认证标签失败、无法调用 native binding 均明确报错，不关闭来源应用的加密保护。该 binding 是内部接口，后续 WorkBuddy 更新可能改变它；本次支持的是已验证的 `sym-v1`，不是任意未来版本承诺。

## finx 的实现边界

`crates/finx-connections/src/workbuddy/` 包含来源会话校验、目录解析、授权和传输适配；`platform.rs` 负责安装检测、来源文件读取、短时解密进程及版本头。桌面通过现有 `LocalApplicationConnection` 展示 WorkBuddy，并沿用检测、连接、管理模型、打开来源应用和断开操作。

每次授权重读来源登录，身份绑定使用 uid 的摘要；账户切换时要求重新连接，过期时要求在 WorkBuddy 恢复登录。401 后仅按现有框架重新读取一次。finx 不保存 WorkBuddy access/refresh token，不接管原应用续期，因此 WorkBuddy 长期不启动且 token 过期时不能自主恢复。这与千问独立模型会话、Qoder 独立 JobToken 的方式不同。

请求通过现有 `OpenAiChatApi::stream_strict` 转成通用流事件。会话与轮次标识由账户、provider、缓存键和用户消息派生摘要；工具循环内保持稳定，每次请求生成新的消息 ID。响应中断且缺少终止信息时不会当作成功完成。连接仍受 `local-accounts` feature 控制，公开 CLI 的无本机账户构建不会注册它。

当前范围是 macOS 标准安装路径下的 WorkBuddy 中国版个人账户。企业租户、WorkBuddy AI、原生 Anthropic Messages 通道、容量排队接口及网关故障转移尚未接入。图片能力按目录声明展示，尚未逐模型做视觉验收；思考开关也没有逐档实测。

## 验证

- 本机只读解密成功；`/v3/config` 返回 HTTP 200、code 0，得到 17 个 CLI 模型。
- 完整 `Manager → ModelRegistry → WorkBuddy transport` 链路分别验证 Auto 和 `glm-5.3-flash`：system 指令、文本 SSE、函数名称与 ID、中文 JSON 参数、工具结果回传均通过。测试使用合成工具结果，没有执行实际工具。
- WorkBuddy 自动化测试覆盖域名与头部拒绝、过期、账户切换、来源 token 更新、目录白名单、能力声明、错误体不泄露、请求参数、会话标识稳定性及截断流。
- 独立 Node 测试覆盖明文、AES-GCM 解密、篡改、不同密钥和未知方案拒绝。
- 原有连接测试全部通过；桌面 TypeScript 检查和 `--no-default-features` 编译通过。未进行桌面窗口点击验收。

复验命令（live 测试会使用当前账户发送三次小请求）：

```sh
cargo test -p finx-connections
node --test crates/finx-connections/src/workbuddy/reader.test.cjs
pnpm --filter @finx/desktop typecheck
cargo check -p finx-connections --no-default-features
cargo test -p finx-connections live_workbuddy_connection -- --ignored --nocapture
FINX_TEST_WORKBUDDY_MODEL=glm-5.3-flash cargo test -p finx-connections live_workbuddy_connection -- --ignored --nocapture
```
