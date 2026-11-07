# 通知

| 项 | 内容 |
|---|---|
| 版本 | v0.2 |
| 日期 | 2026-11-04 |
| 状态 | 一期已实现（分支 `feat/notifications`，未合并），已签名的包实测过真实通知（§5.6）；二期只是设计 |
| 关系 | 落实 Bot PRD 的 F20 和 DQ-51（[bot-mode-design.md](bot-mode-design.md) §6.20）、集成方案的 DQ-13（[desktop-kernel-integration.md](desktop-kernel-integration.md)）；iPhone 的连接见 [protocol-design.md](../kernel/protocol-design.md) §8.3 |

## 方案摘要

- **Mac 不用苹果推送，iPhone 必须用。** Mac 上事情就发生在这台机器，直接发本地系统通知。iPhone 的应用在后台不能保持连接，只有 APNs 叫得醒它。
- **现在只做 Mac（一期）。** 判断放到主进程，窗口关了也能通知。内核只加两个字段，不加新协议。
- **iPhone 来的时候（二期）**，由 `finx` 服务经一个小中继发给 APNs，内容端到端加密，中继和苹果都读不到。
- **通知只是提醒，不是数据。** 真相一直是未读数和对话日志。通知丢了、晚了、乱序了，都不会丢任何东西。
- **一期要先定好四件事**，二期才不用返工：免打扰存在服务端、统一的跳转目标、通知跟着摘要撤回、发送方不绑在页面上（§7）。

## 1. 做之前的样子

"还没有通知机制"不完全准确：有一条窄路，只覆盖一种情况。

| 项 | 现状 | 问题 |
|---|---|---|
| 发通知 | `main/notify.ts` 能发系统通知，点击打开会话 | 只认会话，打不开 Bot |
| 谁判断 | 页面里的 `session/Yours.tsx`，比较 `awaiting_approval` 的变化 | 关掉窗口后页面没了（macOS 关窗不退出应用），这时反而收不到 |
| Bot | 不发通知 | 这次要补的主要缺口 |
| 会话的完成、失败 | 不发通知 | DQ-13 当时说"以后任务结束会发" |
| Dock 角标 | 没有 | DQ-51 |
| 现成的基础 | 守护器的控制连接已经订阅了 `bots/changed` 和 `sessions/changed`（`kernel/supervisor.ts:303`、`:317`），用来判断能否替换服务；未读数由服务层算（`finx-server/src/bots.rs:205`、`:219`） | 一期直接用，不必新开连接 |

## 2. 该不该用苹果推送

结论：**Mac 不用，iPhone 用。**

先排除一个错误的理由：Mac 不是用不了。苹果的能力表里，Developer ID 那一列勾了 Push notifications，FinxWork 这种官网外分发的应用也能用；Electron 也有 `pushNotifications.registerForAPNSNotifications()`。不用是因为不值得：

| | 本地通知（选） | Mac 也走 APNs |
|---|---|---|
| 路径 | 主进程 → 系统 | finx → 中继 → 苹果 → 同一台 Mac |
| 断网时 | 能发（用本地模型时任务也在跑） | 发不出 |
| 内容 | 不离开这台机器 | 要加密，Mac 上还要解密 |
| 签名 | 不变 | 要带描述文件，开发构建也要处理 |
| 自己的服务 | 不需要 | 需要 |
| 多得到的 | — | 只有一点：Cmd-Q 之后 finx 还在跑时也能提醒（§6 有更便宜的办法） |

iPhone 没有这个选择：应用进后台很快被挂起，不能保持连接，能在应用不运行时亮屏的只有 APNs。

## 3. 三条原则

1. **通知只是提醒。** 苹果文档写明 APNs 尽力而为：可能乱序；设备离线时每个 bundle ID 只存一条；可能被限流甚至不送达。所以不能把它当消息通道。打开应用后一律从 finx 取真实内容。
2. **规则只有一处。** 什么事值得告诉主人，只在一个地方判断。一期放在纯函数里，二期整体搬进服务层，不会两边各写一套。
3. **不打扰正在看的人。** 主人在看窗口时，应用内的未读和橙点已经够了。

## 4. 什么时候通知

| 来源 | 事件 | 判断依据 | 标题 / 内容 |
|---|---|---|---|
| Bot | 新消息 | `last.ts` 变了且 `last.from` 是 bot | Bot 名字 / `lastText()` 取的第一行 |
| Bot | 要确认 | `waiting` 从无到有，或换了内容 | Bot 名字 / 等你确认：`waiting` |
| Bot | 这一轮失败 | 新字段 `failed` 从假变真 | Bot 名字 / 这次没能回复 |
| 会话 | 要确认 | 进入 `awaiting_approval`（已有，搬位置） | 会话标题 / 任务在等你 |
| 会话 | 失败 | `running` → `failed` | 会话标题 / 任务失败了 |
| 会话 | 结束 | `running` → `idle`，受开关控制 | 会话标题 / 任务已结束（摘要分不出是做完还是被叫停，所以不说"完成"） |

几个具体判断：

- **新消息比 `last.ts`，不比 `unread`。** 已读和新消息碰巧同时到时，未读可能从 3 变成 1，比数字会漏；时间戳不会。
- **失败必须通知。** Bot 失败时没有气泡，不通知的话主人只会一直等。这正是 D-321 那次"静默的 Bot"。`BotSummary` 现在没有失败信息，要加 `failed`，值来自 `mirror.state()`。
- **帮手的进度不通知。** 帮手做完由 Bot 转告，转告本身就是一条新消息。
- **列表的第一次到达只当基线，不算新消息。** 这是 `Yours.tsx` 已有的规则。重连、重启后也重新取基线，不补发：离开期间的事由 Dock 角标和未读告诉主人。代价是服务重连那一两秒内到达的消息不弹通知，但未读还在。

## 5. 一期：Mac

```
 finx serve ──bots/changed, sessions/changed──▶ 守护器（已订阅）
                                                   │ 新增回调
                                                   ▼
                                  packages/client/alerts.ts      纯函数：前后两份摘要 → 事件
                                                   │
                                                   ▼
                                  main/notify.ts   开关、免打扰、前台判断
                                     │          │            │
                                 系统通知    Dock 角标    撤回已读的通知
                                     │ 点击
                                     ▼
                                 打开窗口 → 跳到 Bot 或会话
```

### 5.1 改动

| 位置 | 改动 |
|---|---|
| `packages/client/src/alerts.ts`（新） | `botAlerts(前, 后)`、`sessionAlerts(前, 后)`、`badgeCount`，都是纯函数，带单元测试 |
| `main/kernel/supervisor.ts` | 把两种摘要变化通过回调交出去；订阅本身不动 |
| `main/notifier.ts`（新）、`main/notify.ts` | 判断在 `notifier.ts`（不依赖 Electron，有单元测试）：开关 → 前台 → 发送，管角标和撤回；`notify.ts` 只对接系统和文字。免打扰在 `alerts.ts` 里判断 |
| `renderer/session/Yours.tsx` | 删掉页面里的判断；`e2e/your-browser.mjs` 跟着验证新路径 |
| `shared/bridge.ts`、preload | 去掉 `notify`，`open-session` 换成 `takeOpenTarget` 和 `onOpenTarget`：页面启动时和收到通知时都主动来取，页面还没加载好也不会丢 |
| Bot 设置面板 | 加一行"免打扰" |
| 设置页 | 加"通知"一页（§5.5） |
| `finx-protocol/src/bot.rs`、`finx-server/src/bots.rs` | `BotSummary` 加 `failed`、`muted`；`bots/update` 能改 `muted`。没有新方法，不升协议版本 |

### 5.2 前台判断

- **算在看**：应用有窗口拿着焦点（`BrowserWindow.getFocusedWindow()`），并且屏幕没锁（`powerMonitor.getSystemIdleState()` 不是 `locked`）。
- 在看时一律不弹系统通知，哪怕正看着 A，B 来了消息。列表那一行和切换按钮的点已经在提示（DQ-61）。
- **顺带改了一处**：`useMarkRead` 原来只看 `document.hasFocus()`，窗口在前台时锁屏离开，新消息可能被标成已读。现在也看屏幕有没有锁，解锁时再补报已读。这个问题是读代码发现的，锁屏这条路径没有实测。

### 5.3 通知本身

- **分组**：`groupId` 是 `bot:<id>` 或 `session:<id>`，系统自动叠在一起。连发四首诗就是一叠四条。`last.ts` 只精确到秒，所以每条的 id 里带正文的哈希，同一秒的两条不会互相顶掉。
- **撤回**：`unread` 归零时 `Notification.removeGroup('bot:<id>')`；确认答完时撤回那条确认。依据是摘要，所以任何设备上读过，这里都会撤，二期不用再改。
- **点击**：打开窗口并跳到目标。窗口可能不存在或页面还没加载好，所以主进程先记下目标，页面启动时和收到提醒时都来取一次。
- **应用退出时**：系统把它发的通知一起撤掉（实测，§5.6）。所以不用接回旧通知；离开期间的事由未读告诉主人。
- **按钮**：一期不加"允许"按钮。批准操作应该先看清要做什么。Bot 默认完全访问，确认本来就少。
- **隐私**：不另设开关。macOS 自己有"显示预览"的设置，按它走。

### 5.4 Dock 角标

角标 = 所有未免打扰 Bot 的 `unread` 之和 + 等确认的会话数。Bot 的确认已经算进 `unread`，不重复。应用退出后角标消失，再打开时按摘要恢复。

### 5.5 设置

"通知"一页：

| 设置 | 默认 | 存在哪 |
|---|---|---|
| 允许通知 | 开 | 桌面端（每台设备不同） |
| 提示音 | 开 | 桌面端 |
| 会话任务结束时通知 | 开（DQ-62） | 桌面端 |
| 试一下：发一条 | 按钮 | — |
| 系统通知设置 | 按钮，只在 macOS 上有 | — |

每个 Bot 的免打扰放在 Bot 的设置面板里，存在 `bot.json`（§7）。免打扰的 Bot：不弹通知、不计入角标，列表里的未读照常。macOS 的专注模式由系统处理，不用管。

### 5.6 实测结果

用已签名的包（Developer ID，未公证）和独立的目录测的，依据是系统日志和应用状态，点击由你在通知中心操作。

| 事项 | 结果 |
|---|---|
| 真实通知送达 | 通过。进通知中心，样式是横幅 |
| 第一次的系统权限 | 第一条通知时系统弹授权窗，允许后正常 |
| 前台不弹，后台弹 | 通过。同样发消息，FinxWork 在最前面时进通知中心 0 条，Finder 在最前面时 1 条，两次都确认消息发出了 |
| 窗口开着时点击 | 通过。应用到前台，约 1 秒内未读清零，通知撤回 |
| 窗口关着时收到并点击 | 通过。关窗后照常收到，点击开新窗口，显示这个 Bot |
| 读过后撤回 | 通过。`bots/read` 后系统日志出现 `removeDelivered` |
| Dock 角标 | 通过。系统记录的 `StatusLabel` 是 1，读过后清空 |
| 退出应用 | 系统撤掉它发的通知，重开后只有未读，不补发 |
| 专注模式 | 系统处理。这次测试时 Mac 的通知被延后、不响，其他应用也一样，FinxWork 的通知照常进了通知中心 |

**测试时要注意**：两份同 bundle ID 的应用同时运行时，系统把点击交给 `/Applications` 那份，测试包收不到。测点击前要退出正式版。

**还没测的**：

- 权限被拒绝后的表现：Electron 44 没有读权限状态的接口。`failed` 事件接上了，只写日志；没有实测拒绝时它会不会触发。设置页目前写"如果没有收到，去系统设置看看"。
- 崩溃后留下的通知：系统可能不撤，点击应该只会打开应用，不会跳转。
- 锁屏判断（§5.2）、Linux 和 Windows。
- 真实的横幅和提示音：测试时专注模式开着，看不到。连发时响几次也没听过；先不限制，真的吵再说。

未签名的开发构建不会把通知送进通知中心，所以自动化走查（`e2e/notifications.mjs`）用 `FINXWORK_E2E_NOTIFIED` 记录"本来要发什么"，用旁边的 `.click` 文件模拟点击，并且当作应用不在前台。

### 5.7 验收

1. 窗口在后台时 Bot 回话：弹通知，内容是第一行，点开到这个 Bot，未读清零，通知从通知中心消失。
2. 关掉窗口（不退出）时同样收到通知，点击后窗口回来，并跳到目标。
3. 窗口在前台时不弹；Dock 角标正确。
4. 要确认时弹通知；在应用里答完，这条通知消失。
5. Bot 这一轮失败时收到通知。
6. 免打扰的 Bot 不弹、不计入角标，列表未读照常。
7. 重启 finx 或重开应用，不补发旧消息。
8. 会话的确认、失败、结束都通知；结束的开关生效。
9. `e2e/your-browser.mjs` 继续通过（路径变了，语义不变）。

## 6. Cmd-Q 之后

macOS 上关窗不退出，一期的主进程方案覆盖。Cmd-Q 不同：finx 还在把任务跑完（IG3），但应用已经不在了，没有谁发通知。

| 做法 | 代价 | 结论 |
|---|---|---|
| 不通知，下次打开时看未读和角标 | 主人走开前按了 Cmd-Q 就收不到；通知中心里已有的也被系统撤掉 | **一期这样做**（DQ-63）。主人明确退出了应用，收不到符合预期 |
| finx 要提醒时，发现没有应用连着，就在后台隐藏启动应用 | 内核要知道桌面应用的存在；Dock 会出现图标。没有验证过 | 真实使用里常遇到再做 |
| 单独带一个极小的通知助手 | 系统通知设置里会多一个应用，权限也要单独给 | 不选 |
| Mac 走 APNs | §2 的全部代价 | 不选 |

## 7. 一期就要定好，二期才不用返工

| 决定 | 一期多花的力气 | 不这样做的话 |
|---|---|---|
| **免打扰存在服务端**（`bot.json`、`BotSummary.muted`） | 协议加一个字段 | 手机和电脑各记一份，要做同步 |
| **跳转目标统一成 `bot:<id>`、`session:<id>`** | 没有额外工作 | 每个端各有一种写法 |
| **撤回跟着摘要走**，不跟"这台机器点了什么" | 没有额外工作 | 手机读过，Mac 上的通知还留着 |
| **发送方不绑在页面上** | 把判断搬到主进程 | 二期的服务层也搬不过去 |
| **规则写成不依赖 Electron 的纯函数** | 没有额外工作 | 二期搬进 Rust 时要从界面代码里拆出来 |

一期**不做**服务端的通知事件流，也不做设备登记。现在只有一个端，从摘要比较就够了，那些等 iPhone 真要做时再加。

## 8. 二期：iPhone

先说清范围：**通知只是 iPhone 工作里较小的一块。** APNs 是单向的，只能说"有事"。在手机上看内容、答确认，都要手机和 Mac 上的 finx 之间有一条连接。这条连接现在没有（finx 只监听本机 socket，远程是 protocol-design §8.3 的"以后"），它才是 iPhone 项目的主体。本节只讲推送，但设计要和那条连接一起定。

```
 Mac: finx serve                     中继（我们的小服务）        苹果         iPhone
 ┌───────────────────┐  密文+票据   ┌──────────────────┐      ┌──────┐     ┌─────────────────────┐
 │ 判断（从桌面搬来）│ ──────────▶ │ 拿 .p8 签名       │ ───▶ │ APNs │ ──▶ │ 通知服务扩展解密    │
 │ 设备登记、在场判断│              │ 不存内容、读不到  │      └──────┘     │ 系统显示通知        │
 │ 端到端加密        │ ◀──410 失效─ │ 按票据限流        │                   │ 失败就显示占位文字  │
 └───────────────────┘              └──────────────────┘                   └─────────────────────┘
          ▲                                                                          │
          └──────────────── 真实内容、答确认：finx 协议的远程连接（另行设计）────────┘
```

### 8.1 为什么由 finx 发，不由桌面应用发

Cmd-Q 之后 finx 还在跑，而这正是最需要通知手机的时候。finx 也可能跑在 Linux 主机上，那里根本没有桌面应用。

到那时，判断从 `alerts.ts` 搬到服务层（`BotRegistry::on_event` 那个算未读的位置），并新增一个 `attention` 事件给客户端。桌面端的比较逻辑随之删除，规则仍然只有一处。

### 8.2 为什么必须有中继

- APNs 的 `.p8` 密钥不能进应用，也不能进开源仓库。苹果写明它"must remain private"。谁拿到它，就能给所有用户的手机发通知。
- 所以必须有一个受控的地方替我们签名。这和"更新只走 GitHub、不要自己的服务器"那条规定不一样：更新有 GitHub 可用，推送没有替代品。**这是一项新增的长期运维，需要你点头（DQ-60）。**

中继只做一件事：

| 接口 | 谁调 | 做什么 |
|---|---|---|
| `POST /v1/register` | iPhone 主应用，带 App Attest 证明 | 把设备 token 加密成票据返回。票据就是加密后的 token，中继不用数据库 |
| `POST /v1/push` | finx，带票据 | 解开票据，签 JWT，转发给 APNs，把 APNs 的结果带回 |

- **没有数据库，不存内容，不记正文。** 票据只能推给一台设备，泄露的影响也止于此。
- **用 topic 专属密钥**，只对 iOS 应用的 topic 和生产环境生效，万一泄露影响更小。苹果支持这种密钥。
- **App Attest 只在 iPhone 主应用里用。** 苹果写明通知服务扩展不支持它；也不是所有设备都支持，要有降级方案。
- **代码开源，放在仓库里。** 但自建中继必须用自己的苹果账号和自己构建的应用，因为 APNs 密钥按开发者团队绑定。

**放在哪**：倾向 Cloudflare Workers，因为 `finxwork.ai` 已经在 Cloudflare，也不用维护服务器。有一个风险要先试：APNs 只接受 HTTP/2。已部署的 Worker 用 `fetch` 发 APNs 据社区反馈可行，本地开发环境不行（[workerd #4841](https://github.com/cloudflare/workerd/issues/4841)），但 Cloudflare 没有承诺这一点。如果不行，就换成任意主机上的一个小 HTTP/2 服务，接口不变。另外还要实测从国内网络访问中继是否稳定。

### 8.3 端到端加密

配对时 Mac 显示二维码，手机扫码，交换 X25519 公钥，得到这对设备共用的密钥。手机的密钥放在钥匙串，和通知服务扩展共享。

```json
{
  "aps": { "alert": { "title": "FinxWork", "body": "你有一条新消息" }, "mutable-content": 1, "thread-id": "<不透明值>" },
  "e": "<base64 密文：Bot 名字、前 300 字、目标、角标>"
}
```

- **扩展要在约 30 秒内解密。** 超时或失败，系统显示原始内容，也就是占位文字，不会泄露。
- **4 KB 上限。** 算上 base64 和外层结构，明文约 2.7 KB。摘要里的 `last.text` 最多 1000 字，全中文约 3 KB，放不下，所以只取前 300 字。其余内容打开应用再取。
- **`alert` 类型必须带可见文字**，否则扩展不运行。这是苹果的要求。

### 8.4 两台设备怎么不一起响

- Mac 向 finx 报告在场：`presence/report { active }`，取值用 §5.2 的前台判断。
- **有设备在场，就不推手机。** 没有在场才推，这时 Mac 和手机都会响，属于预期。
- **一边读了，另一边撤回。** 手机读了，Mac 按摘要撤回。Mac 读了，finx 发一条 `background` 推送让手机清掉。苹果要求这类推送用优先级 5，可能被限流，所以手机打开时还要再对一次。

### 8.5 APNs 请求的取值

| 情况 | `apns-push-type` | 优先级 | 过期 | 说明 |
|---|---|---|---|---|
| 新消息 | `alert` | 10 | 1 天 | 每条独立，用 `thread-id` 成组 |
| 要确认 | `alert` | 10 | 1 天 | `apns-collapse-id` 用确认 ID 的哈希，重试不会出现两条 |
| 撤回 | `background` | 5 | 短 | 尽力而为 |

### 8.6 改动范围

- **finx**：判断下沉、设备登记、在场判断、密文、发送队列；失败退避；中继返回设备失效时删除登记。
- **中继**：很小的独立服务。
- **iPhone**：通知服务扩展、配对、钥匙串共享、深链、APNs token 更新时重新登记。
- **桌面**：配对界面、在场上报。

### 8.7 改不了的限制

- **Mac 合盖或睡眠时，finx 也停了**，既跑不了任务，也发不了推送。这不是通知能解决的。目前代码里也没有防睡眠。要不要"跑任务时不睡"，另外决定。
- **手机上答确认**要等 protocol-design §8.3 的远程连接。在此之前，手机只能收到通知，要回到 Mac 上答。
- 定时任务（F18）要求 finx 常驻，目前 `--idle-exit 600` 会在空闲时退出。方案见 [routine-design.md](../kernel/routine-design.md) §7：有启用的定时任务就不退出，应用登记成登录项。Cmd-Q 后到点不弹通知（DQ-63 不变）。

## 9. 考虑过但不选的

| 方案 | 不选的原因 |
|---|---|
| Mac 也走 APNs | §2 |
| `.p8` 放进应用或由用户自己配 | 密钥必须保密；要求每个用户有开发者账号不现实 |
| CloudKit 订阅：Mac 写一条记录，苹果推给手机 | 确实不需要自己的服务器和密钥，Developer ID 也支持。但 finx 没有应用身份，要另带签名的原生助手；只有 Apple 账号能用，Linux 上的 finx 用不了；延迟和送达没有验证过。如果你坚决不想要中继，这是唯一值得再研究的替代 |
| 通用第三方推送服务 | 多一个依赖，并不省掉"密钥放哪"和加密的工作 |
| 手机在后台保持长连接 | iOS 不允许 |
| 一期就做服务端事件流和设备登记 | 只有一个端时用不上，二期需求明确了再做 |

## 10. 决策与待定

| 编号 | 内容 | 状态 |
|---|---|---|
| DD-132 | Mac 用本地系统通知，不用 APNs | 已实现 |
| DD-133 | 判断放主进程（复用控制连接的订阅），不放页面 | 已实现 |
| DD-134 | 规则是 `packages/client` 里的纯函数；新消息比 `last.ts` | 已实现 |
| DD-135 | 通知只是提醒；重连和重启只取基线，不补发 | 已实现 |
| DD-136 | `muted`、`failed` 进 `BotSummary`；免打扰存在服务端 | 已实现 |
| DD-137 | 撤回跟着摘要走 | 已实现 |
| DD-138 | iPhone 由 finx 经中继发 APNs，端到端加密 | 设计（二期） |
| **DQ-60** | 二期接受自己运营一个小中继吗？不接受就只剩 CloudKit 可研究 | 不急，做 iPhone 前定 |
| **DQ-61** | 窗口在前台、看着别的 Bot 时，不弹系统通知？不弹 | 已定 |
| **DQ-62** | 会话任务完成默认通知？默认开，可关 | 已定 |
| **DQ-63** | Cmd-Q 之后一期不通知？接受 | 已定 |

## 11. 依据

**已查证的原文和代码：**

- [Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)：尽力而为、每个 bundle ID 只存一条、4 KB 上限、各个请求头、`background` 用优先级 5。
- [Establishing a token-based connection to APNs](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)：密钥必须保密、团队密钥和 topic 专属密钥、20 到 60 分钟刷新。
- [Modifying content in newly delivered notifications](https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications)：解密、`mutable-content`、约 30 秒、失败时显示原始内容、必须带 alert。
- [Supported capabilities (macOS)](https://developer.apple.com/help/account/reference/supported-capabilities-macos)：在渲染后的页面里读到，Developer ID 列勾了 Push notifications 和 iCloud: CloudKit。
- [Establishing your app's integrity](https://developer.apple.com/documentation/DeviceCheck/establishing-your-app-s-integrity)：App Attest 的流程、设备可能不支持、通知服务扩展不在支持之列。
- [Electron pushNotifications](https://www.electronjs.org/docs/latest/api/push-notifications)；仓库里 Electron 44.9.0 的 `electron.d.ts`：`getHistory`、`removeGroup`、`groupId`、未签名构建不送达、`handleActivation` 只支持 Windows。
- 本仓库的代码，已在文中标出位置。

**没有验证，二期要先试：**

- Worker 的 HTTP/2 只有社区反馈和 issue，没有官方承诺；国内网络访问中继的稳定性没有测。
- Developer ID 应用实际配 APNs 的过程：只确认了能力表，没有实际构建。因为 Mac 不用 APNs，这一点不影响本方案。
- CloudKit 方案只看了能力表。

一期还没测的见 §5.6。
