# NimbleOffice fork

PPT 与 Word 编辑器用的 `@nimbleoffice/pptx`、`pptx-react`、`pptx-i18n`、`docx`、`docx-react`、`docx-i18n` 不从 npm 安装，而是从我们的 fork 构建：

- 仓库：<https://github.com/Eliseowzy/nimbleoffice>（私有，源自 BetterOffice `openooxml/betteroffice`，独立维护，不再合入上游），当前提交见 `vendor/nimbleoffice/manifest.json`
- 桌面端：八个 tarball 提交在 `vendor/nimbleoffice/`，`pnpm-workspace.yaml` 的 `overrides` 用 `file:` 指向它们；`apps/desktop/package.json` 写同一个版本号
- Rust 侧（`finx-slide`、`finx-word`）：根 `Cargo.toml` 用同一 fork 的 git `rev`，必须与 JS 包同一提交（Word 的保存由 JS 引擎读内核 Rust 引擎的状态，版本错位会读不懂），见 `crates/finx-slide/README.md`

所有修改（JS 与 Rust/WASM）都直接提交在 fork 源码里，再整体构建发布。不要再用 `pnpm patch` 改发行包的 dist，也不要单独替换 wasm 文件：这两种做法改不了编译进 wasm 的逻辑，且每次升级都要重做。Calibri/Cambria 的替身字体（Carlito、Caladea）不再从 `@nimbleoffice/fonts` 取（它现在只带压缩字体包），渲染进程与打包检查都用 `crates/finx-slide/fonts` 里同一份文件。

## 版本号

`<NimbleOffice 版本>-finx.g<fork 提交号前 8 位>`，例如 `0.5.1-finx.g980c3dc0`。由本仓库的 `tools/nimbleoffice/pack.ts` 生成，八个包（含 fonts、fonts-latin：fork 的 docx 需要 `fonts/progressive`，fonts-latin 0.4.2 不在 npm）互相锁定同一版本；工作区有未提交改动时拒绝打包（`--allow-dirty` 会加 `.dirty` 后缀，只用于本地试验）。

## 工具链

一次性安装：Rust `wasm32-unknown-unknown` target、`cargo install wasm-pack --version 0.15.0 --locked`、`brew install binaryen`（wasm-opt）、bun（`npm i -g bun`）。fork 里第一次构建前运行 `bun install`。

## 改引擎的流程

1. 在 fork 上改代码并提交（Rust 改动跑对应 crate 的 `cargo test`，TS 改动跑包内测试），推送到 `Eliseowzy/nimbleoffice`。
2. 打包：
   ```bash
   bun tools/nimbleoffice/pack.ts --repo ~/nimbleoffice --out /tmp/nimble-pack
   ```
3. 用 `/tmp/nimble-pack` 的全部文件（八个 tgz、`manifest.json`、`SHA256SUMS`）替换 `vendor/nimbleoffice/` 的内容；`pnpm-workspace.yaml` 的 override、`apps/desktop/package.json` 改成新版本号，`Cargo.toml` 的 rev 改成同一提交。
4. `pnpm install`、`cargo update --workspace` 更新两个锁文件，`pnpm --dir apps/desktop typecheck` 并 `pnpm dev` 实测，提交。

fork 是私有仓库：Cargo 通过 git 命令行拉取（`.cargo/config.toml` 的 `net.git-fetch-with-cli`），本机用 `gh auth` 的凭证；CI 用仓库 secret `NIMBLEOFFICE_TOKEN`（对 `Eliseowzy/nimbleoffice` 有只读权限的 token）。

NimbleOffice 语言包的 key 变化时，`apps/desktop/src/renderer/src/docs/pptx/zh-CN.ts` 要同步（类型检查会报出缺的和多的 key）。
