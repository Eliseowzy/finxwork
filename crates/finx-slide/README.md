# finx-slide

PowerPoint 文稿：渲染幻灯片、导出 Markdown、查找和替换文字、外科式保存（只改被编辑的部件，保存后自检）。引擎是 BetterOffice 的 fork（根 `Cargo.toml` 里的 `betteroffice-pptx`，按 rev 锁定），字体全部取自本机（不内置任何字体），见 `src/fonts.rs`。

## 对着本地的 fork 联调

在仓库根目录建 `.cargo/config.toml`（已被 gitignore，不要提交）：

```toml
[patch."https://github.com/Eliseowzy/betteroffice"]
betteroffice-pptx = { path = "/Users/eliseo/betteroffice/crates/betteroffice-pptx" }
```

之后 `cargo build` 用的就是本地 checkout，fork 上的改动无需推送就能试。打了补丁时 Cargo 会把 `Cargo.lock` 里这些包的 git 来源去掉，这样的 `Cargo.lock` 不要提交；删掉补丁后再构建一次，锁文件就恢复了。fork 上有了新的提交、要正式引用时，删掉这个文件，把根 `Cargo.toml` 的 `rev` 改成 `git -C <fork> rev-parse origin/finx/0.5` 的完整提交号，再 `cargo update -p betteroffice-pptx`。

fork 把 `libm` 锁在 `=0.2.15`，所以本仓库的 `Cargo.lock` 也用 0.2.15。

## 测试

```bash
cargo test -p finx-slide
```

带真实样本的集成测试见 `tools/ppt-corpus/README.md`。
