# PPT 对照工具

把 finx-slide（BetterOffice）画出的幻灯片和 PowerPoint 导出的参考图逐页对照，并检查保存是否只改了被编辑的部件。脚本需要 Python 3 和 Pillow。

样本和参考图不进仓库，放在被 gitignore 的目录里：

```
tools/ppt-corpus/corpus/<deck>.pptx        测试稿
tools/ppt-corpus/corpus/pp/<deck>-<n>.png  PowerPoint 的参考图（在 PowerPoint 里“导出 → PNG”，n 从 1 起）
tools/ppt-corpus/out/                      渲染结果和对照图
```

## 渲染

```bash
cargo run --release -p finx-slide --example render -- tools/ppt-corpus/corpus/deck_office.pptx tools/ppt-corpus/out/bo 1080
```

## 逐页对照

第一个 `名称=目录` 是参考，其余各列打印相对它的平均 RGB 差和灰度差大于 40 的像素占比，并生成拼图：

分数在参考图的原始尺寸上计算；候选图尺寸不同时会等比例缩放。宽高比不一致时会标记 `ASPECT MISMATCH`，不计算分数；缺图会标记 `MISSING`。因此新版分数不一定能和旧版固定拉伸到 1080×607 后的分数直接比较。

```bash
python3 tools/ppt-corpus/compare.py deck_office tools/ppt-corpus/out/compare_deck_office.png PowerPoint=tools/ppt-corpus/corpus/pp BetterOffice=tools/ppt-corpus/out/bo
```

单页热力图，差异像素标红：

```bash
python3 tools/ppt-corpus/heat.py tools/ppt-corpus/corpus/pp/deck_office-2.png tools/ppt-corpus/out/bo/deck_office-2.png tools/ppt-corpus/out/heat-2.png
```

热力图同样要求两张图宽高比一致。

## 保存检查

列出保存后逐字节变了的部件，有变化时退出码为 1：

```bash
python3 tools/ppt-corpus/zipdiff.py original.pptx saved.pptx
```

`Deck::save` 自己也做同样的检查：除被编辑的幻灯片外，任何部件有变化都会返回错误。

## 集成测试

finx-slide 的集成测试读同一批样本：

```bash
FINX_PPT_SAMPLES=tools/ppt-corpus/corpus cargo test -p finx-slide
```

没有设 `FINX_PPT_SAMPLES` 时，这些测试直接通过、不运行。设 `FINX_PPT_RENDER_OUT=<目录>` 会把渲染结果写出来。
