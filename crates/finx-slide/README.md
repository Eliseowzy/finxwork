# finx-slide

PowerPoint 文稿：渲染幻灯片、导出 Markdown、查找和替换文字、外科式保存（只改被编辑的部件，保存后自检）。引擎是 BetterOffice 的 fork（根 `Cargo.toml` 里的 `betteroffice-pptx`，按 rev 锁定），字体取自本机，唯一内置的是 Carlito / Caladea（Calibri / Cambria 的度量兼容字体，SIL OFL，位于 `fonts/`，附 `OFL-*.txt`，`include_bytes!` 编入；来自 `@betteroffice/fonts` 0.4.2）：本机和 Office 的字体优先，缺 Calibri/Cambria 时才用它们，这样换行与 PowerPoint 一致，见 `src/fonts.rs`。前端同样的字体由 `apps/desktop/electron.vite.config.ts` 提供。

桌面端的交互式编辑使用 BetterOffice 的 React/WASM 编辑器，在前端 Canvas 直接绘制；本 crate 的 PNG 接口用于离线渲染和对照测试。字体提供器也供浏览器编辑器使用，见 [PPTX 编辑器设计](../../docs/desktop/presentation-editor-design.md)。

## 对着本地的 fork 联调

在仓库根目录建 `.cargo/config.toml`（已被 gitignore，不要提交）：

```toml
[patch."https://github.com/Eliseowzy/betteroffice"]
betteroffice-pptx = { path = "../betteroffice/crates/betteroffice-pptx" }
```

之后 `cargo build` 用的就是本地 checkout，fork 上的改动无需推送就能试。打了补丁时 Cargo 会把 `Cargo.lock` 里这些包的 git 来源去掉，这样的 `Cargo.lock` 不要提交；删掉补丁后再构建一次，锁文件就恢复了。fork 上有了新的提交、要正式引用时，删掉这个文件，把根 `Cargo.toml` 的 `rev` 改成 `git -C <fork> rev-parse origin/finx/0.5` 的完整提交号，再 `cargo update -p betteroffice-pptx`。

fork 把 `libm` 锁在 `=0.2.15`，所以本仓库的 `Cargo.lock` 也用 0.2.15。

## 测试

```bash
cargo test -p finx-slide
```

带真实样本的集成测试见 `tools/ppt-corpus/README.md`。
