# 上架 Chrome 应用商店

设计依据：`docs/kernel/browser-design.md` §8.4.6（D-219）。这里是提交时要填的内容和步骤；商店后台的字段名以提交当时为准。

## 1. 步骤

1. **开发者账号**：在 Chrome Web Store 开发者后台注册（一次性费用），填好发布者名称和联系邮箱，完成邮箱验证。
2. **隐私政策**：把第 5 节放到一个公开网址（官网或 GitHub Pages），记下网址。
3. **打包**：先把 `manifest.json` 的 `version` 调高（商店不收已有的版本号），然后：

   ```bash
   pnpm --filter @finx/chrome-extension store-zip
   ```

   产物在 `apps/chrome-extension/dist/`。如果手上有 `manifest.json` 里 `key` 对应的私钥，**第一次**上传加 `--key <私钥.pem>`，这样商店有机会沿用现有 ID `fgaadfmkicjchgjlomjemofnllanlcoo`（这是旧文档里的做法，上传后核对 ID 是否一致）。
4. **新建条目**，上传 zip，按第 2～4 节填写，素材见第 6 节。
5. **可见性**选"不公开"（Unlisted）：搜不到，但有链接就能一键安装，也会自动更新。以后要公开再改。
6. **提交审核**。`debugger` 和 `nativeMessaging` 属于敏感权限，审核可能比普通扩展久。
7. **通过后**：
   - 商店给的 ID 和上面不一样时，填进 `crates/finx-cli/src/cmd_browser.rs` 的 `STORE_EXTENSION_ID`，让宿主清单放行它；
   - 把条目网址填进 `apps/desktop/src/renderer/src/settings/BrowserSettings.tsx` 的 `STORE_URL`，引导第 2 步就换成"添加到 Chrome"按钮；
   - 两处改动随下一个 FinxWork 版本发布。**先等扩展上架，再发这个版本**：应用里的按钮要指向已经存在的条目。

## 2. 条目文案

**名称**：FinxWork

**简短说明**（≤ 132 字符）

- en：Lets the FinxWork desktop agent work in tabs it opens in your Chrome, with your sign-ins. It never sees your other tabs.
- zh_CN：让 FinxWork 桌面端的智能体在你的 Chrome 里打开标签页，使用你的登录状态；它看不到你自己的标签页。

**详细说明**（en）

> FinxWork is a desktop AI agent. This extension lets it use your own Chrome for web tasks, so it works with the sites you are already signed in to.
>
> - It needs the FinxWork desktop app on the same computer; on its own it does nothing.
> - The agent's tabs open in a separate window, in a tab group named "FinxWork". It only ever controls the tabs it opened and the tabs those open. Your other tabs are never attached or read.
> - Chrome shows "FinxWork started debugging this browser" while the agent works. Closing that bar takes control back at once.
> - Actions on public sites ask for your approval in FinxWork first.
> - The extension talks only to the FinxWork app on your computer, through Chrome's native messaging. It has no server of its own and loads no remote code.

**详细说明**（zh_CN）

> FinxWork 是一个桌面端 AI 智能体。这个扩展让它用你自己的 Chrome 完成网页任务，直接使用你已经登录的网站。
>
> - 需要同一台电脑上装有 FinxWork 桌面端，单独安装不起作用。
> - 智能体的标签页开在单独的窗口里，放在名为"FinxWork"的标签组中。它只控制自己打开的标签页，以及由这些标签页打开的标签页；你自己的标签页从不附加，也不读取。
> - 智能体工作时，Chrome 顶部会显示"FinxWork 已开始调试此浏览器"，关掉这条提示就立即收回控制。
> - 在公网站点上的操作，会先在 FinxWork 里征求你的同意。
> - 扩展只通过 Chrome 的 Native Messaging 与本机的 FinxWork 应用通信，没有自己的服务器，也不加载远程代码。

**类别**：工具（Productivity / Developer Tools 二选一，以后台现有分类为准）

## 3. 单一用途

> Let the FinxWork desktop app's agent open, read and operate browser tabs on the user's behalf, in the user's own Chrome.

## 4. 权限说明

| 权限 | 说明（提交时用英文） |
|---|---|
| `debugger` | Reads and operates the pages of tabs the agent opened (accessibility tree, screenshots, clicks and typing) through the Chrome DevTools Protocol. Attached only to the agent's own tabs; never to tabs the user opened. Chrome shows its debugging bar while attached, and closing it ends control. |
| `nativeMessaging` | Connects to the FinxWork desktop app on the same computer (host `com.finxwork.browser`), which sends the agent's commands and receives the results. This is the extension's only connection. |
| `tabs` | Opens, activates and closes the agent's tabs, and notices when one of them opens another tab, so that tab is the agent's too. |
| `tabGroups` | Puts the agent's tabs in a group named "FinxWork" so the user can tell them apart. |
| `alarms` | Reconnects to the desktop app once a minute if the connection dropped, and applies a pending update while the agent is not using a tab. |

**远程代码**：否。所有代码都在扩展包里。

## 5. 隐私与数据使用

**数据使用声明**（后台勾选项，按实际情况）：

- 处理的数据：**网站内容**（智能体标签页里的文字、无障碍树、截图）、**浏览记录**（智能体标签页的网址和标题）。用户在这些页面上输入的个人信息，也可能出现在页面内容里。
- 这些数据只发给同一台电脑上的 FinxWork 应用；扩展本身不向任何服务器发送数据。
- 声明：不出售数据；不用于与单一用途无关的目的；不用于信用评估或放贷。

**隐私政策草稿**（放到公开网址；由负责人审定，必要时请法务看过）：

> **FinxWork Chrome Extension Privacy Policy**
>
> The FinxWork extension connects your Chrome to the FinxWork desktop app on the same computer, so the app's AI agent can work in tabs it opens.
>
> **What the extension handles.** For tabs the agent opened (and tabs those tabs opened), the extension reads page content, such as text, the accessibility tree and screenshots, along with the tabs' addresses and titles, and performs the clicks and typing the agent asks for. It does not read or attach to any other tab.
>
> **Where it goes.** The extension sends this data only to the FinxWork app on your computer, through Chrome's native messaging. The extension has no server and sends nothing over the network itself. The FinxWork app may send page content to the AI model provider you configured in it, under that provider's terms, in order to carry out your request.
>
> **What is kept.** The extension stores nothing beyond the current browser session. The FinxWork app keeps conversation records, which may include page content, on your computer, where you can delete them.
>
> **Sharing.** We do not sell this data, use it for advertising, or use it for any purpose other than carrying out your requests in FinxWork.
>
> **Control.** Closing Chrome's "is debugging this browser" bar ends the agent's control of its tabs. Removing the extension, or stopping it in FinxWork's settings, ends it completely.
>
> **Contact.** `<联系邮箱>`

## 6. 素材

| 素材 | 规格 | 状态 |
|---|---|---|
| 图标 | 128×128 PNG | 已有：`icons/128.png` |
| 截图 | 1280×800 或 640×400，至少 1 张 | 待做：FinxWork 标签组里的标签页 + 桌面端对话；设置 › 浏览器的"使用中" |
| 小宣传图 | 440×280 | 可选 |

## 7. 以后每次更新

1. 调高 `manifest.json` 的 `version`，`pnpm --filter @finx/chrome-extension store-zip`，在后台上传新包。
2. 改动牵涉 finx 对扩展的要求时（新的 CDP 方法、帧格式、浏览器级方法的行为），按 D-219 的顺序走：**先发能说新 bridge 版本的扩展，等商店推送开，再发要求它的 FinxWork**。
