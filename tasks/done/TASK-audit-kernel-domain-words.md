---
id: TASK-audit-kernel-domain-words
title: 审计三维内核里残留的医疗/行业专有内容（只出报告，不改代码）
created: 2026-11-13T23:20:00+08:00
write-scope: 只新建 docs/desktop/spatial-kernel-audit.md；不修改任何已有文件
priority: normal
---

## 目标
产出一份报告 `docs/desktop/spatial-kernel-audit.md`（中文），列出三维内核代码里所有带医疗或其他行业含义的内容，供后续清理。**本任务不改任何代码。**

## 背景
项目的分层原则：三维内核是通用的，只提供与行业无关的原子能力（读入体数据、存储、显示、掩码的测量和建网格、标注）；一切行业知识（医学影像的分割算法、阈值、器官大小、窗位预设、免责文字）都放在 skill 里（`crates/finx-core/src/skills/system/medical-imaging/`）。检验标准是：把医疗 skill 整个删掉，内核照样能打开一个 STL 或一个体数据文件夹，能看层面、做标记和测量。设计文档是 `docs/desktop/spatial-design.md`（§2 分层）。

DICOM 文件格式的读取属于"能打开什么文件"，留在内核是允许的，不算问题；但读取之外对 DICOM 字段做医学解释则算。

## 要求
审计范围（只读）：
- `crates/finx-spatial/src/`（全部）
- `crates/finx-core/src/spatial.rs`、`crates/finx-core/src/spatial_script.rs`
- `crates/finx-docs/src/spatial.rs`，以及 `crates/finx-docs/src/store.rs` 里名字带 `spatial` 的部分
- `crates/finx-protocol/src/doc.rs` 里名字带 `Spatial` 的类型
- `apps/desktop/src/renderer/src/spatial/`（界面）
- `crates/finx-spatial/python/finx_spatial/__init__.py`

要找的东西，例如：写死的 skill 名（如 `"medical-imaging"`）、`HU`、`patient`、`superior` / `inferior`、left / right 的患者方位标注、`lung` / `airway` 等器官词、窗宽窗位数值、与 CT 相关的默认值或阈值、面向医学的提示文案、只对医学影像成立的假设（例如假定坐标系是 LPS、假定数值是 int16）。

报告格式：一张表，每行一条，列为：
| 文件:行号 | 内容摘录 | 为什么算行业专有 | 严重程度（高/中/低） | 建议（保留并说明理由 / 改成通用说法 / 移到 skill） |

表后写一段小结：哪几处最该先处理。不要臆测，每条都要给出真实的文件和行号；拿不准的单独列在"存疑"一节。

## 验证
无需跑测试。执行结果里写明报告共多少条、各严重程度各多少条。

## 执行结果
- 新建 `docs/desktop/spatial-kernel-audit.md`（约 20 KB），未修改任何其他文件。行号由 Lead 抽查 4 处（spatial_script.rs:173、SpatialDocView.tsx:52、algo.rs:177、finx_spatial/__init__.py:51）均属实。
- 主表 **43 条**：高 5、中 10、低 28；另有"存疑"5 条（Modality==CT→HU 的定性、patient/LPS 词汇整体改名、survey 直方图 bin 宽 50 是否按 HU 尺度等）。
- 最该先处理：① spatial_script.rs:173 `DEFAULT_SKILL="medical-imaging"`（内核对具体 skill 的唯一硬依赖，连带 :214 工具描述）；② finx_spatial/__init__.py:51-66 器官名回退与左右肺切分逻辑（唯一写在内核里的器官级医学算法）；③ SpatialDocView.tsx:52/327-330 渲染层按名探测并一键启用医学 skill；④ algo.rs:177 cut_off 输出 superior/inferior；⑤ 默认窗写死 CT 数值（spatial.rs:542 与 volume.ts:145）。
- 判为无问题：source.rs/zipsrc.rs/finx-docs spatial.rs 的 DICOM 格式识别、store.rs 的 spatial 生命周期、protocol 的 Spatial* 类型骨架。

## 状态
completed
