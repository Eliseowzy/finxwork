# Token Plan 接入

设置与首次启动页的「订阅与套餐」保留账户连接，下面提供一个独立的「接入 Token Plan」分组。入口左侧为五家服务商的圆形堆叠标识，右侧为标题与说明。未接入产品只出现在二级单列选择器中；已配置产品成为可管理的行。选择已配置产品进入管理，不重复添加。

流程：选择产品 → 输入该产品的 API Key → 保存 → 完成或管理模型。返回与关闭会清空未保存的密钥。保存期间不能返回或重复提交。模型管理复用 `models/show`；更换与移除复用 `auth/set`、`auth/delete`。这些操作不改会话或默认模型，也不取消服务商订阅。

## 产品与认证

`ProviderConfig.plan` 是可选产品元数据，与 `AuthConfig` 分开。API Key 不代表按量付费或订阅，UI 通过元数据分组。内核通过 `ProviderSummary.plan` 发布入口链接、实际配置的地址、协议与是否有动态目录；不传密钥或未经验证的权益状态。

六个内置产品均复用 `openai-chat`，无需本地应用连接适配器，也无需每家新增内核协议。产品以独立 provider ID 保存凭据、模型选择和目录缓存。环境变量只绑定当前产品，不继承普通 API Key。模型调用失败后不会切换到普通 API 的 endpoint。Z.ai 和智谱是不同账户体系；火山 Agent Plan 和 Coding Plan 的地址与凭据也分开。

| 产品 ID | Base URL | 独立环境变量 |
|---|---|---|
| bailian-token-plan | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | `BAILIAN_TOKEN_PLAN_API_KEY` |
| tencent-token-plan | `https://tokenhub.tencentmaas.com/plan/v3` | `TENCENT_TOKEN_PLAN_API_KEY` |
| volcengine-agent-plan | `https://ark.cn-beijing.volces.com/api/plan/v3` | `VOLCENGINE_AGENT_PLAN_API_KEY` |
| volcengine-coding-plan | `https://ark.cn-beijing.volces.com/api/coding/v3` | `VOLCENGINE_CODING_PLAN_API_KEY` |
| zai-coding-plan | `https://api.z.ai/api/coding/paas/v4` | `ZAI_CODING_PLAN_API_KEY` |
| zhipu-coding-plan | `https://open.bigmodel.cn/api/coding/paas/v4` | `ZHIPU_CODING_PLAN_API_KEY` |

腾讯通用和 Hy 套餐共用一个密钥和地址，使用同一个产品入口。模型预置包含 Auto 与 Hy 模型，是否有权使用由用户订阅和服务端决定。静态目录不会声称已发现账户权益。可通过原有 `models.toml` 扩展条目。

## 目录和验证

- 百炼通过套餐地址的 `/models` 获取模型 ID；成功响应是权威列表，包括空列表，不重新加入被移除的种子模型。
- 其他产品尚未确认可用的标准动态列表接口，设置 `list_models = false`，使用官方文档确认的部分模型预置；不伪装成账户实时模型目录。静态目录不显示刷新按钮，新增模型随应用更新或用户配置加入。
- 公共目录只补充已在套餐范围内的模型能力，不扩充套餐成员；公共 API 单价和长上下文价阶不进入套餐模型。无单价不表示订阅免费，也不是额度或 Credits 的实时统计。
- 多模型网关不统一强加一家厂商的 thinking 参数。已知模型可单独配置兼容参数；未知模型使用默认值并可在管理界面手动显示。
- `auth/set` 只对有动态目录的产品尝试非计费列表验证，明确拒绝的密钥不保存。无接口或临时网络错误时只报告 `verified: false`。界面显示「密钥已保存，尚未验证连接」，首次真实模型请求会进一步验证；不偷偷发起计费探测请求。
- `models/list` 的 `credential` 表示凭据来源，已接入行只表示已配置，不能证明订阅未过期或额度充足。

## 维护来源

配置核对日期：2026-11-04。服务商模型目录会变化，内置清单不是完整、永久的权益承诺。

- [百炼 Token Plan 快速开始](https://docs.agent.bailian.aliyun.com/zh/token-plan/token-plan-personal-quick-start)、[常见问题](https://docs.agent.bailian.aliyun.com/zh/token-plan/token-plan-personal-faq)；动态目录实现参考 [Model Studio CLI](https://github.com/modelstudioai/cli)。
- [腾讯 Token Plan 套餐概览与模型 ID](https://cloud.tencent.com/document/product/1823/130060)。
- [火山方舟接入](https://docs.volcengine.com/docs/ark/quick-start?lang=zh)、[Agent Plan OpenAI 兼容配置](https://docs.volcengine.com/docs/ark/agent-plan-personal-zcode?lang=en)。
- [Z.ai Coding Plan 接入](https://docs.z.ai/devpack/tool/others)。
- [智谱 Coding Plan 模型与接入地址](https://docs.bigmodel.cn/cn/coding-plan/latest-model)。

测试覆盖产品路由与凭据隔离、静态目录边界、动态替换/空列表、价格剔除、GLM effort 参数，以及真实 `finx serve` 的保存/替换/移除、模型调用与默认设置保持。外部服务需要用户自己的套餐密钥进行真实账户验证，本地测试使用隔离目录和模拟服务。
