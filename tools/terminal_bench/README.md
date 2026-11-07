# Finx × Terminal-Bench

用真实 `finx exec` 内核在 Harbor 任务容器中执行，默认 **ChatGPT 订阅 + GPT-6 Luna / low**。
Harbor 固定为 0.25.0（`uv.lock`），正式数据集固定 `terminal-bench/terminal-bench@4.0.0`。

## 准备

在仓库根目录编译本机登录 CLI：

```bash
cargo build -p finx-cli --bin finx
cd tools/terminal_bench
uv sync --locked
# macOS/Linux 交叉编译静态 Linux amd64 二进制（需 Rust/rustup）。
uv run --group build python build.py
# 或 Docker 编译：bash build.sh
uv run python run.py login
uv run python run.py models
```

`login` 使用 finx 已有的 ChatGPT OAuth，需要浏览器授权使用订阅额度。
默认选择连接实际返回的 `gpt-6-luna`；不存在时失败并列出可用模型，不会静默换模型或改用 API Key。
模型的订阅额度可用性以该账号实际响应为准。
`--force-build` 只强制重建 Agent 环境；Harbor 0.25.0 的独立 verifier 仍会拉取官方预构建镜像。

评测凭据放在忽略提交的 `.state/auth`，使用独立文件存储，不复制日常 macOS 钥匙串。
这个目录的绝对路径用于 finx 的凭据索引；移动工作区后应重新登录。
适配器只传递 ChatGPT 的 profile/tokens，每题的会话、个人配置和记忆从空环境开始。
令牌刷新后回存，**必须单并发**；适配器有跨进程互斥检查。
不要同时使用此目录启动另一个 finx 客户端。不要上传 `.state` 或将凭据打入镜像。
订阅调用仍会消耗额度；GPU/云沙箱资源另计，不属于 ChatGPT 订阅。

## 从验证到正式评测

```bash
# 只打印命令，不启动评测
uv run python run.py smoke --dry-run
# 自建的最小任务：模型调用工具创建文件，verifier 验证精确内容
uv run python run.py smoke
# 选一题先用参考解检验环境（正式任务可能需要下载较大镜像）
uv run python run.py oracle --task session-window-debug --force-build
# 同一题用 finx + GPT-6 Luna 试跑
uv run python run.py pilot --task session-window-debug --force-build
uv run python run.py view
```

`smoke_task` 是接入检查，**不属于 Terminal-Bench，不计入正式得分**。
`pilot` 和 `full` 默认无回合上限（`--max-turns 0`），每题时间/资源保持数据集配置。
仅检查集成时可显式使用 `--max-turns 12`；受限结果不应与公开榜单比较。
2026-11-04 完成的 5 题 × 3 次固定基线见 [基线报告](BASELINE-2026-11-04.md) 和 [运行清单](baseline-2026-11-04.json)。
只有选定的一题可以在 Mac Docker 上试跑；全量 4.0 包含 GPU、多容器任务，需相应算力。

```bash
# 为云环境安装同一版本 Harbor 的额外依赖，并先配置服务商认证
uv pip install 'harbor[modal]==0.25.0'
uv run python run.py oracle --sandbox modal --task '*' --attempts 5
uv run python run.py full --sandbox modal --attempts 5
```

所有运行默认 `-n 1 -r 0`，避免订阅并发和隐藏重试放大消耗。全量开始前应对完整任务集跑参考解；
上面的 `oracle` 默认只取一题，可用 `--task '*'` 选择全部。云服务可用性和任务兼容性仍须实测。

## 接入方式与结果

核心命令：

```bash
finx exec - --model '<subscription-provider>/gpt-6-luna' \
  --thinking low --permission-mode bypass-permissions --output json
```

仅在隔离任务容器内绕过交互确认。任务文本通过 stdin 文件输入，避免 shell 插值；不覆盖任务默认工作目录。为 finx 进程提供 Mozilla CA 证书包，支持没有系统证书的精简镜像。
不把源码仓库、参考解或测试答案放进 Agent 环境；验证由 Harbor 执行。

- `finx_agent.py`：安装 CLI、执行任务、保存刷新令牌、汇总 tokens。
- `jobs/<时间>/result.json`：Harbor 汇总结果，异常与 reward 分开记录。
- 每个 trial 的 `agent/finx-result.json`、`finx-stderr.log`、`sessions/`：内核结果及完整会话。
- `.state/bin/revision.txt`、`source.patch`：构建时的提交和源代码改动；适配器还记录二进制 SHA-256。
- `cost_usd` 对订阅保持未知，不伪造为零美元 API 调用。

默认没有 ATIF 转换，也不自动上传或提交榜单。保留原始 finx 会话供排障。
原工作区的未提交内核改动不会自动进入这个独立 worktree。

## 验证

```bash
uv run python -m unittest -v test_adapter.py
# 不调用模型的容器/验证器检查
uv run harbor run -p smoke_task -a oracle -n 1 -k 1 -r 0 -o jobs
```

参考：[运行指南](https://www.tbench.ai/run)、[自定义 Agent](https://docs.harborframework.com/agents/custom-agents)。
