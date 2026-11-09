# Token Plan 接入

Token Plan 与账户订阅、API 服务是不同的集成方式，设置与首次启动页给它一个独立分组，放在「使用订阅」之后。已配置的产品是和 API 服务一样的行（管理模型、移除），下面是「接入 Token Plan」入口，左侧显示还可接入的服务商标识。还有未接入的产品时才显示入口。已配置的行带「已接入」标签；选择器里已配置的产品留在原位，同样带标签且不可选，所以不会重复添加。

流程与「添加 API 服务」相同：选择产品 → 输入该产品的 API Key → 保存 → 回到列表，已配置的行出现。未能验证时用提示告知。返回与关闭会清空未保存的密钥。保存期间不能返回或重复提交。连接详情和更换密钥在「管理模型」弹窗底部。模型管理复用 `models/show`；更换与移除复用 `auth/set`、`auth/delete`。这些操作不改会话或默认模型，也不取消服务商订阅。

## 产品与认证

`ProviderConfig.plan` 是可选产品元数据，与 `AuthConfig` 分开。API Key 不代表按量付费或订阅，UI 通过元数据分组。内核通过 `ProviderSummary.plan` 发布入口链接、实际配置的地址、协议与是否有动态目录；不传密钥或未经验证的权益状态。

六个内置产品均复用 `openai-chat`，无需本地应用连接适配器，也无需每家新增内核协议。产品以独立 provider ID 保存凭据、模型选择和目录缓存。环境变量只绑定当前产品，不继承普通 API Key。模型调用失败后不会切换到普通 API 的 endpoint。Z.ai 和智谱是不同账户体系；火山 Agent Plan 和 Coding Plan 的地址与凭据也分开。

| 产品 ID | Base URL | 独立环境变量 | 公共目录的行 | `thinking_format` |
|---|---|---|---|---|
| bailian-token-plan | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | `BAILIAN_TOKEN_PLAN_API_KEY` | `alibaba-token-plan-cn` | `qwen` |
| tencent-token-plan | `https://tokenhub.tencentmaas.com/v1` | `TENCENT_TOKEN_PLAN_API_KEY` | `tencent-token-plan`，其余查厂商 | 不写，官方文档没写开关 |
| volcengine-agent-plan | `https://ark.cn-beijing.volces.com/api/plan/v3` | `VOLCENGINE_AGENT_PLAN_API_KEY` | 只查厂商 | `deepseek` |
| volcengine-coding-plan | `https://ark.cn-beijing.volces.com/api/coding/v3` | `VOLCENGINE_CODING_PLAN_API_KEY` | `volcengine-coding-plan` | `deepseek` |
| zai-coding-plan | `https://api.z.ai/api/coding/paas/v4` | `ZAI_CODING_PLAN_API_KEY` | `zai-coding-plan` | `zai` |
| zhipu-coding-plan | `https://open.bigmodel.cn/api/coding/paas/v4` | `ZHIPU_CODING_PLAN_API_KEY` | `zhipuai-coding-plan` | `zai` |

腾讯通用和 Hy 套餐共用一个密钥和地址，使用同一个产品入口。模型预置包含 Auto 与 Hy 模型，是否有权使用由用户订阅和服务端决定。静态目录不会声称已发现账户权益。可通过原有 `models.toml` 扩展条目。

## 目录和验证

- 百炼通过套餐地址的 `/models` 获取模型 ID；成功响应是权威列表，包括空列表，不重新加入被移除的种子模型。
- 其他产品尚未确认可用的标准动态列表接口，设置 `list_models = false`，使用官方文档确认的部分模型预置；不伪装成账户实时模型目录。静态目录不显示刷新按钮，新增模型随应用更新或用户配置加入。
- 公共目录只回答模型能做什么，不扩充套餐成员：有哪些模型由列表或预置决定，每个模型先查套餐自己的行，没有就查模型厂商的行（model-catalog-design §4.5）。公共 API 单价和长上下文价阶不进入套餐模型。无单价不表示订阅免费，也不是额度或 Credits 的实时统计。
- 思考强度按模型的控制方式发送，不是一个产品一种参数（model-catalog-design §18.3）。一个网关上不同厂商的模型可以各走各的：百炼上 `qwen3.8-max`、DeepSeek 发 `reasoning_effort`，`qwen3.7` 系列发 `thinking_budget`，GLM-5.3 没有开关就不发开关。`thinking_format` 只说这个产品的开关和预算参数叫什么。
- 模型的 ID 是套餐自己的叫法，例如腾讯的 `deepseek/deepseek-flash`；目录的叫法不会发出去。查不到参数的路由名（例如 `tc-code-latest`）留在菜单里，标"参数未知"，不带输出上限。
- `auth/set` 只对有动态目录的产品尝试非计费列表验证，明确拒绝的密钥不保存。无接口或临时网络错误时只报告 `verified: false`。界面显示「密钥已保存，尚未验证连接」，首次真实模型请求会进一步验证；不偷偷发起计费探测请求。
- `models/list` 的 `credential` 表示凭据来源，已接入行只表示已配置，不能证明订阅未过期或额度充足。

## 维护来源

配置核对日期：2026-11-04。服务商模型目录会变化，内置清单不是完整、永久的权益承诺。

- [百炼 Token Plan 快速开始](https://docs.agent.bailian.aliyun.com/zh/token-plan/token-plan-personal-quick-start)、[常见问题](https://docs.agent.bailian.aliyun.com/zh/token-plan/token-plan-personal-faq)；动态目录实现参考 [Model Studio CLI](https://github.com/modelstudioai/cli)。
- [腾讯 Token Plan 套餐概览与模型 ID](https://cloud.tencent.com/document/product/1823/130060)。
- [火山方舟接入](https://docs.volcengine.com/docs/ark/quick-start?lang=zh)、[Agent Plan OpenAI 兼容配置](https://docs.volcengine.com/docs/ark/agent-plan-personal-zcode?lang=en)。
- [Z.ai Coding Plan 接入](https://docs.z.ai/devpack/tool/others)。
- [智谱 Coding Plan 模型与接入地址](https://docs.bigmodel.cn/cn/coding-plan/latest-model)。

测试覆盖产品路由与凭据隔离、静态目录边界、动态替换/空列表、价格剔除，以及真实 `finx serve` 的保存/替换/移除、模型调用与默认设置保持。守卫测试遍历每个产品的每个模型，断言每个档位都改变请求（`crates/finx-llm/tests/channels.rs`）；端到端测试断言发给服务商的请求内容（`e2e_models.rs`）。

外部服务需要用户自己的套餐密钥进行真实账户验证，本地测试使用隔离目录和模拟服务。2026-11-04 百炼 Token Plan 已用真实密钥验收：12 个对话模型的 57 个档位全部成功（model-catalog-design §13.3）。其他产品拿到密钥后用 `cargo run -p finx-llm --example probe_channel -- <产品 ID>` 验收。

官方文档依据（2026-11-04 核对）：[百炼深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)、[百炼请求参数](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)、[火山方舟深度思考](https://docs.volcengine.com/docs/82379/1449737)、[智谱 Coding Plan](https://docs.bigmodel.cn/cn/coding-plan/latest-model)。
