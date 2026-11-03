# Qoder 逐模型能力验证（2026-11-03）

来源：本机 Qoder App 0.4.11 全球版的 worker 请求实现、当前账户 app 目录和真实模型请求。使用现有 Finx 独立 JobToken；测试目录放在临时目录，不改主连接配置、不改 Qoder 文件、不执行模型工具。没有替换已安装的 FinxWork.app。

[机器可读证据](qoder-capabilities-2026-11-03.json) 分开保存 `declared`、`effective`、`verification` 与每次请求观察；保留修复前的失败，不用重试成功覆盖历史。此报告是开发验收证据，详细三态尚未加入设置 UI，原“待验证”仍代表模型是否已通过路由适配。

## 状态含义

- **目录声明**：账户目录返回的能力与档位，不等于该能力实测成功。
- **实测通过**：指定输入和断言通过。图片必须正确读出两张图的八个色块；思考档位请求必须完成并返回正确计算结果。
- **未知**：未测试、无声明、失败原因不确定，或请求通过但无法证明控制语义。未知不等于不支持。
- **声明与实测矛盾**：DeepSeek 的 Off 仍产生思考内容；记录矛盾并移除有效 Off 选项，绝不将它标成“关闭成功”。

## 逐模型结果

“档位请求”只计显式控制（包括可用的 Off），不计默认档；请求通过不能证明高档一定比低档思考更多。所有模型的输出预算和温度参数组合另行测试。

| 模型 | 双 PNG 图片 | 目录思考强度 | 档位请求通过 | 关闭思考 |
|---|---|---|---|---|
| Auto | 通过 | 未声明档位 | 0/0 | 未声明 |
| Ultimate | 通过 | low/medium/high/xhigh/max | 5/5 | 未声明 |
| Fast | 通过 | 未声明档位 | 0/0 | 未声明 |
| Efficient | 通过 | 未声明档位 | 0/0 | 未声明 |
| Sonus | 通过 | low/medium/high/xhigh/max | 5/5 | 未声明 |
| Cantus | 通过 | low/medium/high/xhigh/max | 5/5 | 未声明 |
| Qwen3.8-Max | 通过 | low/medium/xhigh | 4/4 | 可见思考关闭对照通过 |
| Qwen3.8-Flash | 通过 | low/medium/xhigh | 4/4 | 可见思考关闭对照通过 |
| GLM-5.3 | 通过 | low/high/max | 3/3 | 未声明 |
| GLM-5.3-Flash | 通过 | high/max | 2/2 | 未声明 |
| Kimi-K3.1-Pro | 通过 | low/high/max | 3/3 | 未声明 |
| Kimi-K2.8-Preview | 通过 | low/high/max | 3/3 | 未声明 |
| DeepSeek-V4-Pro | 通过 | high/max | 2/2 | 声明支持，实测未关闭；不开放 |
| DeepSeek-Flash | 通过 | low/high/max | 3/3 | 声明支持，实测未关闭；不开放 |
| MiniMax-M3.1-Flash | 通过 | 未声明档位 | 0/0 | 未声明 |

最终一轮共 84 次请求：82 次断言通过，2 次参数请求失败（当时记为未知，后续已定位）。包含 15 个模型的图片、默认思考、默认参数请求，以及所有当前有效档位。另保留首轮 71 次、Kimi 复现 5 次与 DeepSeek 关闭控制的 8 次原始路由对照。这两个失败请求均为 Kimi 的温度 0.25；随后 10 次单变量对照定位了温度限制：默认或 1.0 配合 32,000 均成功，0.25 和 0.5 均失败。代码新增温度门槛后，连接层 38 项离线测试通过（包含默认/1.0 透传及非法温度不发网络请求的验证）。

## 配置与控制边界

- **上下文**：15 个模型 `context_config` 默认档均为 200,000，发送对应 `context_length`。多数另声明 400K/1M，Efficient 仅声明 200K。保留原声明，不自动选择更大档，也未进行长上下文容量边界测试。Kimi K2.8 缺失的 legacy 上限由明确的默认档补齐。
- **输出预算**：全部目录缺失 `max_output_tokens`。32,000 来自本机 worker `KT` 的兜底值；最终参数探针发送该预算并设置 `temperature=0.25`，13 个模型接受该组合并完成短答案；两个 Kimi 的温度限制由单变量对照另行确认。未证明最大输出可达 32,000 或温度采样效果。
- **Kimi 温度**：两个入口均只放行当前已实测的默认值或 1.0。0.25/0.5 的失败与输出预算无关；其余值仍未知。传入未验证值返回 `qoder_temperature_unverified`，不静默改写温度，也不让调用方只看到笼统的上游失败。默认预算 32,000 已在两个模型上成功请求。
- **思考**：解析 `thinking_config.enabled.efforts`、档位默认值和 disabled 声明。Kimi 虽然 `is_reasoning=false`，明确声明的档位仍应提供。默认请求不注入思考参数；显式档位发送 `reasoning_effort` 与 `enable_thinking`。
- **可见思考**：Qwen Max/Flash 的开启与关闭对照，只有在关闭返回零可见思考且开启有思考时才记通过；这不证明模型内部没有计算。Cantus 接受各档位但未观察到可见思考，强度语义仍未知。其余档位也未做统计性的强度效果评价。
- **DeepSeek Off**：SDK 参数、原生 disabled 参数、两者组合、零预算四种对照，在两个模型上均返回思考。有效选项移除 Off；旧目录或显式 Off 请求在本地报 `qoder_thinking_off_unverified`，不静默执行默认思考。
- **多模态**：图片探针走 Manager → ModelRegistry → Qoder transport，证明图片未被核心预处理替换成省略文本。仅测试双 PNG；音频、视频、OCR、文件理解及其他图片格式仍未知。现有 UserContent 仅有文本和图片，不为此改核心类型。
- **裸模型边界**：线上的 system/messages/tools 仅来自调用方；离线测试断言没有加入 Qoder 系统提示词或工具定义。连接仍经过 Qoder 网关，无法证明服务端没有路由、提示词改写或安全处理。

## 流适配与隔离

首轮 Efficient 和两个 Kimi 出现 `unexpected_sse_line`。复现捕获到 `data:` 被拆成 `d`/`ata:`、`da`/`ta:`、`dat`/`a:` 或 `data`/`:`。适配层只在一个 SSE 事件内恢复已知字段，不跨空行、不过滤错误终止、不接受截断 EOF，仍受 1 MiB 上限约束。

目录解析、控制映射、DeepSeek 门槛、异常流恢复、实测探针都在 `finx-connections/src/qoder/`。通用连接分派只声明格式和调用 Qoder 的模型准入函数；未改 finx-llm、finx-core 或其他供应商协议实现。

## 重跑

先运行 ignored `live_qoder_catalog_capabilities`，显式设置 `FINX_QODER_TEST_HOME` 与 `FINX_QODER_CAPABILITIES_OUT`，导出经过字段白名单过滤的最新目录。再运行 ignored `live_qoder_capability_matrix`，设置 `FINX_QODER_CATALOG_IN` 为该目录，`FINX_QODER_CAPABILITIES_OUT` 为本次结果文件。两步使用 `cargo test -p finx-connections <测试名> -- --ignored --nocapture`。

可选 `FINX_QODER_TEST_MODEL=<upstream key>` 限定一个模型；`FINX_QODER_TEST_MODE=image|thinking|parameters` 限定探针种类。空模式测试全部；参数探针对 Kimi 使用已验证的 1.0，其余模型用 0.25，并记录实际请求值。报告保留的是加入 Kimi 温度门槛之前的 0.25 对照及后续原始路由探针，不把这两次失败改成成功。真实请求计入账户用量；macOS 可能要求授权新编译的测试程序读取来源钥匙串。测试程序完成不表示每个请求通过，应检查报告中每个观察的状态。

新代码需要在新构建的内核中刷新 Qoder 模型目录，才会更新已有缓存的图片和思考选项。此次没有更新已安装的桌面应用。
