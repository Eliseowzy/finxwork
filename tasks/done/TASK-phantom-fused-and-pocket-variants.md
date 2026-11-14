---
id: TASK-phantom-fused-and-pocket-variants
title: 给合成胸部体模加三个变体：两肺粘连、体侧封闭空气、高噪声
created: 2026-11-13T23:20:00+08:00
write-scope: crates/finx-spatial/tests/common/phantom.rs（只改这一个文件）
priority: high
---

## 目标
在合成胸部 CT 体模族里新增三个变体，用来回归我们在真实片上遇到的三个分割错误。验收标准：

1. `phantom::family()` 返回的列表末尾多出三个变体，名字分别是 `fused_lungs`、`side_air_pocket`、`very_noisy`；原有 11 个变体的名字、顺序、数值完全不变（默认体模逐体素不变）。
2. `cargo test -p finx-spatial` 全部通过。
3. `cargo check -p finx-spatial -p finx-core --all-targets` 通过（`crates/finx-core/src/spatial.rs` 用 `#[path]` 引用了这个文件）。

## 背景
- 文件 `crates/finx-spatial/tests/common/phantom.rs` 生成一个合成胸部 CT（体表椭圆、两个椭球肺、心脏切迹、气管和主支气管、脊柱、肋骨、血管、一个磨玻璃结节）。`struct Variant` 描述一个变体，`Phantom::hu(p)` 给出患者坐标 p（LPS，mm：x 向患者左，y 向后，z 向上）处的 CT 值，`hu_base` 是默认体模的值，`in_lung` / `in_airway` / `in_body` 等是解析真值，评测工具（`crates/finx-spatial/examples/ct_eval.rs`）用它们算 Dice。
- 现有常量：`LUNG_R` 中心 x=-72、半径 56；`LUNG_L` 中心 x=72、半径 50，两肺在中线处相隔约 16 mm。体表是 `(x/158)^2 + ((y-8)/112)^2 <= 1`。肺内约 -860 HU，空气 -1000，软组织 40。
- 请先通读该文件，沿用它的写法（`Variant` 字段 + `..d()`、`hu()` 里按字段叠加效果）。

## 要求
给 `Variant` 加字段（默认值都表示"无此效果"），并在 `hu()` 和相关真值函数里实现：

1. **`fused_lungs`（两肺在心脏前方粘连）**：加一条连接两肺的含气"桥"。桥是一个小长方体：x 从 -20 到 20，y 从 -62 到 -56（靠前），z 从 110 到 140，CT 值与肺组织相同（-860 加同样的噪声）。桥内的体素在真值里算肺：`in_lung` 对该变体返回 true，并且 x<0 的部分属于右肺、x>0 的部分属于左肺（评测按 `x[0] < 0.0` 分左右，所以不用改评测）。注意桥要避开心脏切迹的判断（桥内直接算肺，不受 `HEART` 椭球排除）。如果按上面的坐标桥没有同时接上两个肺椭球，请调整 y / z 范围直到它两端都伸进肺里，并在执行结果里写明最终坐标。
2. **`side_air_pocket`（体侧被包住的空气）**：在身体内部、靠患者右侧边缘、扫描最顶部加一块封闭空气：椭球中心 `[-135.0, 10.0, 240.0]`，半径 `[8.0, 14.0, 12.0]`，CT 值 -1000（加与体外空气同样的噪声）。它在体表椭圆之内（所以被身体包住）、在肺和气道之外。真值：它不是气道（`in_airway` 不变）、不是肺。它的截面积要比气管大（气管半径 8 mm，截面约 200 mm²；这块约 350 mm²），这样"选最顶层最大的封闭空气块当气管"的旧做法会选错。
3. **`very_noisy`（高噪声）**：就是现有 `sigma` 字段取 120.0（现有 `low_dose` 是 60.0），不需要新字段。

每个新字段写一行英文文档注释，说明它模拟什么（参照现有字段的注释风格）。不要改 `family()` 之外已有变体的定义，不要改其他文件。

## 验证
```bash
cargo test -p finx-spatial
cargo check -p finx-spatial -p finx-core --all-targets
```
另外请写一个临时检查（不用提交）或在执行结果里给出证据：`fused_lungs` 变体里，CT 值 <= -400 且在体内的体素构成的最大连通块同时包含 x<-40 和 x>40 的体素（即两肺确实连成一块）。

## 执行结果
- `Variant` 新增字段 `fused: bool`、`side_pocket: bool`（各一行英文文档注释，默认 false，原 11 个变体逐体素不变）；`family()` 末尾追加 `fused_lungs`、`side_air_pocket`、`very_noisy`（sigma 120.0，复用现有字段）。
- **桥的最终坐标与任务给的不同**：任务给的 x ∈ [-20, 20] 经验算接不上两肺（y ≈ -58 处右肺只到 x ≈ -39，左肺从 x ≈ +43 开始），按任务授权调整为长方体 x ∈ [-50, 55]、y ∈ [-58, -52]、z ∈ [110, 140]（常量 `BRIDGE`），两端各伸入肺椭球 ≥ 5 mm，且避开心脏椭球。桥内 CT 值 -860 + 与肺相同的噪声，`in_lung` 对桥直接返回 true（不受 HEART 排除）；x<0 归右肺、x>0 归左肺（评测按 `x[0] < 0.0` 分侧，无需改评测）。
- `side_air_pocket`：椭球 `POCKET` = 中心 [-135, 10, 240]、半径 [8, 14, 12]，-1000 HU 加体外空气同款噪声；不是气道/肺。发现一处任务没写的问题并修正：气袋中心落在肋骨真值带（body 0.73 ∈ (0.7, 0.8)）内，`in_bone` 对该变体在气袋内返回 false。
- 连通性证据（临时测试 `tmp_fused_check.rs`，验证后已删）：`fused_lungs` 中 HU ≤ -400 且在体内的最大 6-连通块为 1,362,887 体素，x 从 -126.8 mm 到 121.6 mm，即两肺确实连成一块；同时断言气袋在体内、非肺/气道/骨、读值 < -900 HU，全部通过。
- 验证：`cargo test -p finx-spatial` 33 通过 0 失败；`cargo check -p finx-spatial -p finx-core --all-targets` 通过。
- 带新变体的 ct_eval（`results/script-3.json`）：三个新变体全部 ✓ 无旗标——`fused_lungs` 双肺 dice 1.000 且正确分侧（右 1677.9 mL / 左 1201.2 mL，"separated where the join is narrowest (after wearing 4 mm)"）；`side_air_pocket` 气道 dice 1.000（种子没被体侧气袋骗到）；`very_noisy` 气道 dice 0.940、骨骼 0.969，全部在容差内。

## 状态
completed
