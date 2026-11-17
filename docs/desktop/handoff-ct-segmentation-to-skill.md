# 交接：CT 分割从内核迁到 skill 脚本

> 2026-11-13，分支 `feat/document-editor`，全部未提交。

## 1. 为什么做

用户的真实片 `~/Downloads/47085165.zip`（低剂量胸部 CT）上，旧内核的 recipe 把两肺算成"右肺 3703 mL、左肺 31 mL"，助手据此告诉用户"左肺几乎不含气，建议尽快就医"。这是错误结论。原因是两肺在心脏前方粘连成一块，`keep_largest 2` 留下的是"合并双肺 + 一块碎片"，`split_side` 把碎片当成了左肺。

和用户讨论后定的原则（已写进记忆 `harness-atoms-skill-logic`）：

- **内核（FinxWork）只提供领域无关的原子能力**：读入体数据、存储、显示、掩码的测量和建网格、标注。
- **分割这类领域逻辑全部放在 skill 的 Python 脚本里**，经 `spatial_script` 运行，交回掩码。
- FinxWork 不随包带 Python 解释器（现状：随包带 `uv`，Python 和依赖首次使用时下载，这一点用户没有再提异议）。

## 2. 已经做完的

### 内核（Rust）
- **删除 recipe 引擎**：`crates/finx-spatial/src/recipe.rs` 已删；`algo.rs` 只保留 Grid、Mask、统计、直径、`cut_off`（新加，判断掩码是否顶到扫描头脚两端）。阈值、连通、形态学、区域生长、`grow_until_leak` 等分割算子都删了。
- **删除 `spatial_build` 工具**和 `finx-docs` 里的 `DocStore::spatial_build`、`BuiltStructure`。
- **脚本提交扩展**（`crates/finx-core/src/spatial_script.rs`）：
  - `structure` 新增字段 `opacity`、`hidden`、`expect_ml`、`notes`、`unreliable`，都做了校验；
  - 新类型 `profile`（方位标注、单位、窗位预设、免责文字）。
- **应用提交**（`crates/finx-core/src/spatial.rs` 的 `SpatialScriptData::apply`）：并行给每个结构量体积、建网格（`hidden` 的不建网格，只存掩码）；做三项通用检查（空、超出 `expect_ml`、脚本自报 `unreliable`）并在返回文本里标 `UNRELIABLE`；顶到扫描两端时注明。
- Python 模块 `crates/finx-spatial/python/finx_spatial/__init__.py`：`submit.structure(...)` 加了上述参数，新增 `submit.profile(...)`。

### skill
- 新脚本 `crates/finx-core/src/skills/system/medical-imaging/scripts/chest_structures.py`：体表、气道、双肺（含粘连拆分）、`lungs_closed`、左右肺、肺血管、骨骼。要点：
  - **两肺粘连**：逐步腐蚀直到分成两个大小相当的核心，再用分水岭长回去（`split_fused`），在粗网格（约 1.5 mm）上做以提速；
  - **气道种子**：只在体中线 50 mm 内、截面积 20–1500 mm² 的封闭空气里找，避免选到体侧被包住的空气；
  - **气道生长**：阈值逐级放宽，体积突增时改用波前生长，只剪掉渗漏的分支（从旧 Rust `grow_until_leak` 移植）；结果小于 15 mL 时，在 0.5 mm 高斯平滑后的片子上再试一次，取更大且未渗漏的那次；
  - 工作区先裁到体表的外接框，`closed` 在粗网格上做并去掉边缘一圈，骨骼限定在体内（排除检查床）。
  - 往 stderr 打 `time <id> N s`，评测工具会显示。
- `recipes/chest.json` 已删除，`bundle.rs` 已同步。`SKILL.md` 第 3 步和 `references/building.md` 已改写为"跑脚本、改输入参数"。
- `docs/desktop/spatial-design.md` §2、§4、§5.2、§6 等已更新，记录了去掉配方的原因。

### 评测
- `crates/finx-spatial/examples/ct_eval.rs` 改为跑 skill 脚本（方式与 `spatial_script` 相同），解释器取 `CT_EVAL_PYTHON` 或 `~/.finx/cache/uv/envs/medical-imaging/bin/python`；`CT_EVAL_WORK=DIR` 可保留每个案例的工作目录，便于手工复跑。
- `~/ct-eval/cases.json` 已加入 `real/47085165`。
- 旧 recipe 的基线：`~/ct-eval/results/recipe-final.json`。

### 测试（都通过过，最后几处脚本改动之后还没重跑）
- `cargo test -p finx-spatial`：通过（`tests/chest.rs` 改为"把体模真值当掩码交给内核量"）。
- `finx-core` 的 `check_submissions_rejects_bad_lines`、`approval_and_trust`、`phantom_open_build_slice_finding_refuse_and_undo`：通过。
- 新增的 `spatial_script::tests::phantom_chest_structures`（用 uv 跑胸部脚本的端到端测试）**还没跑过**。

## 3. 当前结果（手工复跑，最新脚本）

| 片子 | 气道 | 右肺 | 左肺 | 血管 | 骨骼 | 脚本耗时 |
|---|---|---|---|---|---|---|
| 47085165（出问题的那份） | 23.0 mL | 2010 mL | 1671 mL | 115 mL | 948 mL | 约 15 s |
| 47083958 | 26.3 mL | 4283 mL | 4029 mL | 168 mL | 1361 mL | 约 12 s |

左肺不再是 31 mL，问题已修。体模族上一轮全部 ✓，只有 child 和 no_trachea_top 按预期被标记（体积低于成人预期）。

## 4. 还没做的（按顺序）

1. **跑全量评测并和旧基线对比**（被中断的那一步）：
   ```bash
   cargo build -p finx-spatial --release --example ct_eval
   ./target/release/examples/ct_eval run --out ~/ct-eval/results/script-2.json > ~/ct-eval/script-2.log 2>&1
   ./target/release/examples/ct_eval diff ~/ct-eval/results/recipe-final.json ~/ct-eval/results/script-2.json
   ```
   注意：`diff` 会把"时间变长"报成退步。旧基线只计 Rust 建模时间，新的还含 Python 启动和写掩码、建网格，所以**时间项不可直接比**，只看 Dice、体积范围和"错了却没标"（`silent_wrong`）这几项。上一轮还有一项 47083958 气道 0.1 mL 的退步，已经修好，需要确认。
2. **跑测试**：
   ```bash
   cargo test -p finx-spatial
   cargo test -p finx-core --lib spatial
   ```
   第二条包含需要 uv 和网络的端到端测试（`phantom_chest_structures`、`phantom_lung_nodule_candidates`）。
3. **去掉脚本里的调试计时**？目前保留也无害（只写 stderr），可以不动。
4. `cargo build --bin finx` 重新编译内核。
5. 在应用里对 `47085165.zip` 真实走一遍 `/ct`，确认三维模型里左右肺都正常，并且模型的回答不再说"左肺不含气"。
6. 清理：`.ct-debug/`（调试截图，可删），`~/ct-eval/work/`（评测工作目录，体积大，可删）。

## 5. 交给 DSH Lead 的任务（`tasks/open/`）

按仓库根目录 `CLAUDE.md` 的约定下发，完成后会移到 `tasks/done/` 并附结果。下发时都还没开始：

- `TASK-phantom-fused-and-pocket-variants`：体模加三个变体（两肺粘连、体侧封闭空气、高噪声），用来回归这次的三个问题。完成后要在 `ct_eval` 上跑一遍新变体。
- `TASK-audit-kernel-domain-words`：只读审计内核里残留的医疗专有内容，输出 `docs/desktop/spatial-kernel-audit.md`。已知会有：`"medical-imaging"` 默认 skill 名、`unit: "HU"` 写死、`volume.rs` 的患者方位、`cut_off` 的 superior/inferior。
- `TASK-regen-protocol-schema`：`SpatialStructure.origin` 注释改了，需要重新生成 `schema.json` 和 `generated.ts`，否则 `cargo test -p finx-protocol` 会失败。

## 6. 未决问题

- `ct-segmentation-plan.md` 仍按旧架构（配方 + 内核算子）写成，需要按本次方向重写或标注过时。
- 内核里"医疗痕迹"清理（等审计报告出来再定）。
- 没有 Python 环境时就没有三维模型，这是本方案的已知代价，用户已接受。

## 7. 接手记录（2026-11-13 晚，DSH Lead）

第 4 节全部完成，`tasks/open/` 三项任务全部做完移入 `tasks/done/`：

1. **评测**：两轮结果 `~/ct-eval/results/script-2.json`（原 14 案例）和 `script-3.json`（含三个新体模变体）。对旧基线 `recipe-final.json` 的 diff 只有血管 Dice 小幅下降（0.971→0.958，thick_5mm 0.851→0.765），全部仍在容差内、无 ✗、无 silent_wrong；47083958 气道 0.1 mL 的退步已确认修好。真实片 47085165：右肺 2009.7 / 左肺 1671.3 mL。新变体 `fused_lungs` 双肺粘连也能正确分侧（Dice 1.000）、`side_air_pocket` 气道 Dice 1.000、`very_noisy` 全过。
2. **测试**：`cargo test -p finx-spatial` 33 通过（含三个新变体）；`cargo test -p finx-core --lib` 311 通过，含 `phantom_chest_structures` 端到端（uv + 网络，约 60 s）。
3. **内核重编译 + 无头实测**：`cargo build --bin finx` 后用 `finx exec` 对 `47085165.zip` 完整走了一遍 /ct：气道 23.0 / 右肺 2009.7 / 左肺 1671.3 / 血管 104.6 / 骨骼 948.4 mL，无 UNRELIABLE、无空结构。**GUI 里的三维模型目视确认还没做**，需要有人打开桌面应用看一眼。
4. **顺带修了一个 bug**：`spatial_script` 工具在单线程 runtime（`finx exec` 等前台命令）下 panic——`spatial.rs` 里用 `tokio::task::block_in_place` 阻塞等待 `spatial_ops`。已把 `ScriptData::apply` 改成 `#[async_trait]` 真异步（spatial.rs、spatial_script.rs、spatial_script/tests.rs 三处），CLI 与桌面端都正常。
5. **同步了两份过期的生成快照**：`crates/finx-protocol/schema.json` + `packages/protocol/src/generated.ts`（TASK-regen-protocol-schema），以及 `crates/finx-core/tests/snapshots/tools.json`（FINX_UPDATE_SNAPSHOTS=1；分支上新增的 spatial 工具从未同步进快照，导致 `the_tool_contract_is_the_one_in_the_repository` 失败，现已修）。
6. **审计报告**已出：`docs/desktop/spatial-kernel-audit.md`，主表 43 条（高 5 / 中 10 / 低 28）+ 存疑 5 条，小结指出最该先处理的五处（`DEFAULT_SKILL="medical-imaging"`、内核 Python 包里的肺分侧回退、渲染层按名探测医学 skill、`cut_off` 的 superior/inferior、写死的 CT 默认窗）。
7. **清理**：`.ct-debug/` 和 `~/ct-eval/work/` 已删。脚本里的 stderr 调试计时保留（第 3 节）。

剩余给下一个人：GUI 目视确认（上面 3）、§6 的三项未决、以及把本分支上混着的 document-editor 改动与 CT 改动分开提交。
