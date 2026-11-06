# BetterOffice fork

PPT 编辑器用的 `@betteroffice/pptx`、`@betteroffice/pptx-react`、`@betteroffice/pptx-i18n` 不从 npm 安装，而是从我们的 fork 构建：

- 仓库：<https://github.com/Eliseowzy/betteroffice>，分支 `finx/0.5`（上游 `openooxml/betteroffice`）
- 桌面端：`pnpm-workspace.yaml` 的 `overrides` 把三个包指向 fork release 里的 tarball；`apps/desktop/package.json` 写同一个版本号
- Rust 侧（`finx-slide`）：根 `Cargo.toml` 用同一 fork 的 git `rev`，见 `crates/finx-slide/README.md`

所有修改（JS 与 Rust/WASM）都直接提交在 fork 源码里，再整体构建发布。不要再用 `pnpm patch` 改发行包的 dist，也不要单独替换 wasm 文件：这两种做法改不了编译进 wasm 的逻辑，且每次升级都要重做。`@betteroffice/fonts` 我们不改，用 npm 上的发布版。

## 版本号

`<上游版本>-finx.g<fork 提交号前 8 位>`，例如 `0.5.1-finx.g980c3dc0`。由 fork 的 `bun run pack:finx` 生成，三个包互相锁定同一版本；工作区有未提交改动时拒绝打包（`--allow-dirty` 会加 `.dirty` 后缀，只用于本地试验）。

## 工具链

一次性安装：Rust `wasm32-unknown-unknown` target、`cargo install wasm-pack --version 0.15.0 --locked`、`brew install binaryen`（wasm-opt）、bun（`npm i -g bun`）。fork 里第一次构建前运行 `bun install`。

## 改引擎的流程

1. 在 fork 的 `finx/0.5` 上改代码并提交（Rust 改动跑对应 crate 的 `cargo test`，TS 改动跑包内测试）。
2. 本地试：
   ```bash
   cd ~/betteroffice && bun run pack:finx --out /tmp/bo-finx
   ```
   把 `pnpm-workspace.yaml` 的三个 override 临时改成 `file:/tmp/bo-finx/betteroffice-<包>-<版本>.tgz`，`apps/desktop/package.json` 改成同一版本，`pnpm install`，然后 `pnpm --dir apps/desktop typecheck` 并 `pnpm dev` 实测。
3. 发布：推送 fork 分支，以版本号为 tag 建 release，上传 `/tmp/bo-finx` 下的全部文件（三个 tgz、`manifest.json`、`SHA256SUMS`）：
   ```bash
   git -C ~/betteroffice push origin finx/0.5
   gh release create v<版本> /tmp/bo-finx/* -R Eliseowzy/betteroffice --target <完整提交号> --title v<版本> --notes "<改了什么>"
   ```
4. 把 override 改成 release 地址 `https://github.com/Eliseowzy/betteroffice/releases/download/v<版本>/betteroffice-<包>-<版本>.tgz`，`pnpm install` 更新锁文件（锁文件记录完整性哈希），提交。

上游有新版本时，在 fork 上把上游合进 `finx/0.5`，按同样流程发布。上游语言包的 key 变化时，`apps/desktop/src/renderer/src/docs/pptx/zh-CN.ts` 要同步（类型检查会报出缺的和多的 key）。
