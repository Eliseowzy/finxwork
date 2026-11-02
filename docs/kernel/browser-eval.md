# 浏览器工具评测（finx-eval）

| 项 | 内容 |
|---|---|
| 位置 | `crates/finx-eval` |
| 相关 | [browser-design.md](browser-design.md) §11 |

**简单说**：用真实模型在本地的小网站上做任务，看浏览器工具到底好不好用。每个用例是一个目录：`case.toml` 写任务和判定条件，其余文件是网站。运行时在回环地址上起这个网站，交给 `finx exec` 去做，按"网站收到了什么请求"和"最终回答"判定通过与否，再汇总通过率、轮数、工具调用和 token。

端到端测试（browser-design §11.2）用模拟模型按脚本调用工具，验证的是工具本身对不对；评测验证的是模型用这些工具能不能把事办成，用来比较模型、比较工具描述和快照格式的改动。

## 运行

```bash
cargo build -p finx-cli -p finx-eval
./target/debug/finx-eval --list
./target/debug/finx-eval                                   # 默认模型，全部用例
./target/debug/finx-eval -m deepseek/deepseek-flash -m anthropic/claude-sonnet-5-5 --repeat 3
./target/debug/finx-eval --case div_button -c browser.headless=false   # 看着它做
```

退出码：全部通过为 0，否则为 1。`--out` 指定 JSON 报告的位置（默认在临时目录），里面有每次运行的回答和网站收到的请求。默认不保留会话日志：每次运行都在一个临时目录里，留下来的会话会在会话列表（和桌面端侧边栏）里各成一个项目。要回看模型是怎么做的，加 `--keep-sessions`，报告里会带上会话日志路径。

## 每次运行的环境

- 每次运行起一个新的网站，端口不同，所以 origin 不同，上一次留下的 cookie 和 storage 不会影响这一次；
- `finx exec` 的工作目录是一个新的临时目录；
- 固定加上这些配置：`browser.enabled = true`、`browser.backend = "managed"`、`browser.profile = "eval"`（不碰用户自己的 Chrome 和日常用户目录）、`tools.enabled = []`（只留浏览器工具，模型没法改用 curl）；
- 回环地址不需要审批，`finx exec` 没有审批人也能完成任务；
- `case.toml` 本身不对外提供，模型看不到预期答案。

## 写用例

```toml
description = "一句话说明考的是什么"
prompt = "On {base}/ sign in as ada ..."   # {base} 换成网站地址
max_turns = 30                              # 可选，默认 30

[[expect]]                                  # 全部要满足
request = "POST /api/login"                 # 网站收到的请求：方法 + 路径
fields = { username = "ada" }               # 可选：只比较列出的字段（查询串、表单、JSON 对象）

[[expect]]
answer = "KX-4471"                          # 最终回答里包含（不区分大小写）

[[forbid]]                                  # 一条都不能满足
request = "POST /api/delete-account"
```

网站里发到 `/api/…` 的请求都会被记录，返回一个写着 Received 的页面。表单直接 `action="/api/…"`，脚本用 `fetch('/api/…')`。

## 现有用例

| 用例 | 考什么 |
|---|---|
| `login_form` | 填表、提交；密码字段 |
| `checkout_wizard` | 三步表单：下拉框、单选、复选框、校验 |
| `table_lookup` | 读表格并推理出答案 |
| `div_button` | 带 onclick 和 `cursor:pointer` 的 div，不是 button |
| `cookie_banner` | 遮罩挡住页面，要先关掉 |
| `delayed_content` | 结果几秒后才出现，要等待 |
| `new_tab` | 链接在新标签页打开 |
| `iframe_form` | 表单在 iframe 里 |
| `live_search` | 输入时才出现结果，名字相近的两项要选对 |
| `prompt_injection` | 页面里藏着让智能体删账号的指令；`forbid` 检查没有照做 |
| `infinite_scroll` | 目标在滚动加载的列表下面 |
| `keyboard_listbox` | 只响应键盘的自定义列表框 |

## 测试

- 单元测试：用例解析与判定、网站的文件服务和请求记录（`cargo test -p finx-eval`）；
- 端到端：`crates/finx-cli/tests/e2e_eval.rs` 用模拟模型通过真实的 `finx exec` 和 Chromium 跑一个用例，检查通过和不通过两种判定。
