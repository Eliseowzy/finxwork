# 三维内核行业专有内容审计报告

审计日期：2026-11-13。依据任务 `tasks/open/TASK-audit-kernel-domain-words.md`（分层原则见 `docs/desktop/spatial-design.md` §2）。

**判定标准**：把 `crates/finx-core/src/skills/system/medical-imaging/` 整个删掉，内核仍能打开 STL / 体数据文件夹、看层面、做标记和测量。DICOM 文件格式的读取（按 `DICM` 魔数识别、分组、排序、解码像素、RescaleSlope/Intercept 重标定、PixelPadding → NODATA）留在内核是允许的，不计入问题；`crates/finx-spatial/src/source.rs`、`zipsrc.rs`、`crates/finx-docs/src/spatial.rs` 的格式探测、`crates/finx-docs/src/store.rs` 的 spatial 生命周期管理、`crates/finx-protocol/src/doc.rs` 的 Spatial* 类型骨架经逐行核对均属此类或纯通用结构，未列入下表。

行号均已逐条与当前工作区文件核对。

## 处理进度

2026-11-14 已处理小结里的五项（行号是审计当时的，改后有偏移）：

1. `spatial_script.rs` 的 `DEFAULT_SKILL` 已删，`script` 模式必须传 `skill`；工具描述去掉 "(a CT)"、HU、`k_towards_head`；下载说明不再列医学包。
2. `finx_spatial/__init__.py` 的 lungs / 左右肺回退已删（建模脚本本来就交回 `lungs`、`lung_right`、`lung_left`，回退是死代码）；数组改名 `values`（`hu` 留作别名），`unit` 不再默认 "HU"。
3. 界面不再按名字找医学 skill：skill 在 `SKILL.md` 头部写 `metadata.suggest-for: spatial-volume`，经 `SkillEntry.suggest_for` 传到界面，提示文案改成通用的。
4. `algo::cut_off` 输出 `+z` / `-z`，由 skill 的 `references/building.md` 解释成 superior / inferior。
5. 兜底窗位改为所显示数据的最小值到最大值（`spatial_slice` 和界面的层面视图都是）。

其余中、低各条未动。

## 发现明细

| 文件:行号 | 内容摘录 | 为什么算行业专有 | 严重程度 | 建议 |
|---|---|---|---|---|
| crates/finx-core/src/spatial_script.rs:173 | `const DEFAULT_SKILL: &str = "medical-imaging";` | 内核把医学 skill 名写死为脚本运行环境的默认值；医疗 skill 删除后 `script` 模式默认环境不存在，且 :181 的 `FIRST_DOWNLOAD` 宣称下载 scipy/SimpleITK 等医学包 | 高 | 移到 skill：默认 skill 必须显式传入（`skill` 参数必填或由会话配置注入），内核不内置任何 skill 名 |
| crates/finx-core/src/spatial_script.rs:214 | `DESCRIPTION: "Run a Python script over a volume document (a CT). … load().hu is int16 HU … .k_towards_head) …"` | 工具描述把体数据文档直接定义为 CT，向模型灌输医学假设（HU、int16、头方向），并默认读者是医学 skill | 高 | 改成通用说法：按 meta.json 契约描述（`unit` 由文档声明、值类型由 `volume.npy` 决定），删掉 "(a CT)" 和 `.hu`/`k_towards_head` 等医学措辞 |
| apps/desktop/src/renderer/src/spatial/SpatialDocView.tsx:52 | `const med = res.skills.find((s) => s.name === "medical-imaging" \|\| /[\\/]medical-imaging[\\/]SKILL\.md$/i.test(s.path));` | 渲染层按名字探测医学 skill，还有 `enableMedicalSkill`（:61）直接打开它；skill 删除后此 UI 永远不出现，但这是界面层的行业耦合 | 高 | 移到 skill：由 skill 提供自己的"启用提示"插件/横幅；或改成配置驱动的"推荐 skill"注册表 |
| apps/desktop/src/renderer/src/spatial/SpatialDocView.tsx:327-330 | `<span>{t("spatial.enableSkillHint")}</span> … {t("spatial.enableSkill")}` | 提示文案为「已打开医学影像检查，启用医学影像 skill 可辅助识别肺部等结构与发现」（字符串本体在 `apps/desktop/src/locales/{en,zh-CN}/session.json:979/952`，超出本次范围但同源） | 高 | 移到 skill；至少把文案与 skill 探测一并改成配置驱动 |
| crates/finx-spatial/python/finx_spatial/__init__.py:51-66 | `"""…`lungs` falls back to lung_right \| lung_left, and each side to its half of `lungs`.""" if name == "lungs" …` | 内核的 Python 读入库内置了器官名（lungs/lung_right/lung_left）和"患者右侧=图像左半"的医学几何知识，还对半切分掩码——这是纯医学逻辑写进了内核包 | 高 | 移到 skill：`segment()` 只按名字查表；肺部合并/分侧逻辑挪到 medical-imaging 的脚本或其自己的 helper 里 |
| crates/finx-spatial/src/algo.rs:177-192 | `/// The ends of the head-foot axis a mask touches (`"superior"`, `"inferior"`) … out.push(if up { "superior" } else { "inferior" });` | `cut_off` 的输出值是解剖方位词 superior/inferior，进入结构统计文本（"end of the scan"语义靠它），非医学用户无从理解 | 中 | 改成通用说法：输出 `"top end"`/`"bottom end"`（沿 k 正/负方向），由 skill 决定怎么措辞成 superior/inferior |
| crates/finx-core/src/spatial.rs:542 | `} else { (-1000.0, 1000.0) };`（默认窗，另见 :365 参数文档 `default: profile's first window or [-1000, 1000]`） | 无 profile 窗时的兜底显示窗是 CT 软组织全距；工业 CT（灰度 0..255）或 float 体数据会几乎全黑，但仍"能看层面"，故不算致命 | 中 | 改成通用说法：兜底窗按 `survey` 的 min/max 或单位自适应；至少不写死 CT 数值 |
| apps/desktop/src/renderer/src/spatial/volume.ts:145 | `return out.length ? out : [{ name: fallback, width: 2000, level: 0 }];` | 前端默认窗 width 2000 / level 0，是 HU 尺度（≈[-1000,1000]）的默认值 | 中 | 改成通用说法：默认窗取数据 min..max 映射，或由 profile/单位驱动 |
| crates/finx-spatial/src/dicom.rs:297-301 | `value: if series.modality == "CT" { ValueMeaning::Calibrated { unit: "HU".into() } } else { ValueMeaning::Raw },` | 读 RescaleSlope/Intercept 属读取，但按 Modality==CT 判定"单位是 HU"是对字段的医学解释（名称层面），写死在读取器里 | 中 | 改成通用说法：只填 `Calibrated { unit: "HU" }` 的判据交给可配置的映射，或把 unit 命名下放给 skill 通过 `profile.unit` 提交（内核默认 Raw）。另见"存疑" |
| crates/finx-core/src/spatial.rs:1015 | `"k_towards_head": info.direction[2][2] > 0.0,`（同名字段还写进 spatial_script.rs:50 的契约文档与 python/finx_spatial/__init__.py:6,38） | 内核导出给脚本的几何契约用"头"（head）这个患者概念命名；对任何非人体体数据该名字无意义 | 中 | 改成通用说法：改为 `k_axis_sign`/`k_increases_towards` 之类的几何描述（方向由 direction 矩阵本身已可得出，此字段只是便利） |
| crates/finx-core/src/spatial_script.rs:693-694 | `if p.orientation.as_deref().is_some_and(\|o\| o != "patient" && o != "none") { return Err("profile.orientation: want \"patient\" or \"none\"…` | 内核校验的 profile 枚举值是医学词 `patient`（协议侧 `crates/finx-protocol/src/doc.rs:295` 注释同样写 `patient` (L/R, A/P, S/I)） | 中 | 改成通用说法：枚举改为 `anatomical`/`world`/`none` 之类（需与渲染端 `SpatialDocView.tsx:118,417`、`scene.ts` 的分支同步迁移） |
| crates/finx-spatial/python/finx_spatial/__init__.py:33-37 | `self.hu = np.load(…); … self.unit = self.meta.get("unit", "HU")` | 数组属性名叫 `hu`，且 unit 缺省值写死 "HU"——内核包把 CT 单位当成默认事实 | 中 | 改成通用说法：属性改名 `values`（保留 `hu` 作别名过渡），unit 无值时不假设 |
| crates/finx-spatial/src/volume.rs:6-12 | `/// Voxel values are stored as `i16` for now: CT in HU fits. Wider types come with the industrial pack, as new variants. pub enum DType { I16, }` | 体素只支持 int16，理由是"CT 的 HU 放得下"——以医学数据为容量设计依据；工业体数据（uint16/float）进不来（仍能开 STL，但打不开非 int16 体数据，属于能力假设而非文案） | 中 | 保留并说明理由：作为已知容量限制（注释已声明扩展路径），但建议把注释改为按存储宽度而非按 CT 论述，并尽早加 U16/F32 变体 |
| crates/finx-core/src/spatial.rs:302 | `"Survey: … axes run towards [{}, {}, {}] (L/R, A/P, S/I of the patient), …"` | 面向模型的输出文案里解释方位字母为患者左右/前后/头脚 | 中 | 改成通用说法：去掉 "of the patient"，或按 profile.orientation 决定是否解释为解剖方位 |
| crates/finx-spatial/src/render.rs:6-10 | `//! Layout, as radiology reads them … the image's left is the patient's right and its top is the front; … the head up.` | 切片渲染的布局约定以"放射科读法"定义（左=患者右、头在上）。翻转逻辑本身几何通用，但约定词面是医学的且无条件生效 | 中 | 改成通用说法：文档改写为"读取器约定"（与 canvas 端 `volume.ts:24` 的放射学约定一致即可），或按 orientation 分支；另见"存疑" |
| crates/finx-spatial/src/volume.rs:17 | `/// A physical quantity with one calibration, as HU for CT. The values are already rescaled.` | 注释用 HU/CT 举例（`ValueMeaning::Calibrated` 本身通用） | 低 | 改成通用说法（举例换成通用物理量），保留枚举 |
| crates/finx-spatial/src/volume.rs:23-25 | `/// The value of voxels with no data, as outside a CT's circular field of view (§7.2).` | NODATA 语义用 CT 视野外举例 | 低 | 改成通用说法：无数据体素（读取器标记），例子非医学 |
| crates/finx-spatial/src/volume.rs:33-36,118-135 | `/// The first voxel's centre, in patient coordinates LPS (VD-27), mm. … pub fn to_patient(…)` | 几何字段与函数名以患者 LPS 表述；几何本身（origin+direction）完全通用 | 低 | 保留并说明理由（当前唯一体数据来源 DICOM 天然是患者系），长期可统一改叫 source/world 坐标并保留 LPS 为其特例；见"存疑" |
| crates/finx-spatial/src/volume.rs:41 | `/// The pack's fields, keys prefixed with its id, as `medical.kernel`.` | 文档示例引用医学行业包名 | 低 | 改成通用说法（示例换 `<pack>.<field>`） |
| crates/finx-spatial/src/volume.rs:52-58 | `/// The patient side a direction points to in LPS (VD-27) … [('R','L'),('A','P'),('I','S')]` | `side_of` 产出患者方位字母 R/L/A/P/I/S；算法层无条件计算（展示受 orientation 门控） | 低 | 保留并说明理由：DICOM 方向余弦的语义就是这六个字母；若做坐标系改名可一并中性化为 +x/−x 之类 |
| crates/finx-spatial/src/algo.rs:7-15,52-62,295,338 | `/// Where voxels sit in patient space … LPS mm. … pub fn to_patient … Centre of mass, LPS mm.` | Grid 的文档与命名同上，均为患者系表述 | 低 | 同 volume.rs：保留或随坐标系改名 |
| crates/finx-spatial/src/algo.rs:200-201 | `/// The patient side each of i, j, k runs towards (`L`, `P`, `S`, …). pub towards: [char; 3],` | Survey 字段以患者方位表述（值就是 side_of 的输出） | 低 | 同上；字段可改名 `axis_ends` |
| crates/finx-spatial/src/mesh.rs:8,508,568,646 | `/// …in the source's units (LPS mm for surfaces of a volume). … let origin = g.to_patient(…)` | 网格层同样使用 LPS/patient 命名 | 低 | 同上 |
| crates/finx-spatial/src/mesh.rs:520-521 | `// A surface still this large (a spongy mask, as an airway leaked into the lungs) would take minutes…` | 注释用气道漏进肺举例解释降采样 | 低 | 改成通用说法（"多孔/海绵状掩码"） |
| crates/finx-spatial/src/render.rs:108-110 | `/// Draw the plane's second axis from the bottom up: for coronal and sagittal planes whose slices run towards the head, so the head is at the top.` | "头在上"的翻转依据写成患者概念（逻辑只是 k 方向符号） | 低 | 改成通用说法：沿 k 正方向朝上 |
| crates/finx-spatial/src/render.rs:189,232,251 | `value: ValueMeaning::Calibrated { unit: "HU".into() }, … window: (-1000.0, 1000.0)`（测试夹具；`brick.rs:389` 同） | 测试数据使用 HU 与 CT 窗 | 低 | 保留并说明理由：测试数据跟随被测行为，源头清理后自然改写；非运行时问题 |
| crates/finx-spatial/src/dicom.rs:279-282 | `/// Reads a usable series … as modality values (HU for CT) clamped to `i16`. …` | 读取文档注释含 HU/CT 表述（重标定本身允许） | 低 | 改成通用说法：重标定后的模态值 |
| crates/finx-core/src/spatial_script.rs:47-50 | `/// … meta.json: {"spacing": [dk,dj,di], … "unit": "HU", "image_numbers": …, "k_towards_head": bool, …}` | 契约文档示例写死 unit "HU"（实际导出用 `info.unit`，见 spatial.rs:1013） | 低 | 改成通用说法：`"unit": <volume's unit>` |
| crates/finx-core/src/spatial_script.rs:195 | `/// e.g. `medical-imaging/scripts/lung_nodule_candidates.py`. Runs without asking.` | 参数文档以医学 skill 脚本为例 | 低 | 改成通用说法（示例换 `<skill>/scripts/<file>.py`） |
| crates/finx-core/src/spatial.rs:368 | `/// Named window from the document's profile (e.g. "lung", "mediastinum", "bone").` | 参数文档用肺窗/纵隔窗/骨窗举例 | 低 | 改成通用说法（举例换成中性预设名） |
| crates/finx-core/src/spatial.rs:371,727,742,786-788,867 | `/// Patient LPS point [x, y, z] in mm to zoom around. … /// Position [x, y, z] in patient LPS mm. … "Place or update an AI marker at a 3D patient LPS coordinate…"` | 工具参数文档/描述多处称坐标为"patient LPS" | 低 | 改成通用说法：LPS/world mm（坐标语义与 DICOM 读取器契约绑定，可保留 LPS 一词但去掉 patient） |
| crates/finx-core/src/spatial.rs:384-397 | `fn lps_label … if v[2] >= 0.0 { "S" } else { "I" }` | 边缘标注函数输出 L/R/A/P/S/I（与 volume.rs:side_of 同源） | 低 | 保留并说明理由（DICOM 语义），或随坐标系改名 |
| crates/finx-core/src/spatial.rs:1027 | `// Structures are measured and meshed first … a chest has half a dozen and a surface takes seconds.` | 注释以"一个胸部有半打结构"解释并行设计 | 低 | 改成通用说法（"典型文档有若干结构"） |
| crates/finx-core/src/spatial.rs:1286-1289,1346-1347,1369 | `windows: vec![("lung".into(), 1500.0, -600.0)], disclaimer: Some("not a diagnosis".into()) … name: "Right lung nodule" … "Small GGO in right lung"` | 测试夹具使用肺窗数值、"not a diagnosis"、GGO 结节文案 | 低 | 保留并说明理由：测试数据，源头清理后随带改写 |
| apps/desktop/src/renderer/src/spatial/SpatialDocView.tsx:118-120,417 | `// Orientation: patient (LPS) vs generic XYZ. … viewer?.setOrientation(spatial?.profile?.orientation === "patient"); … patientOrientation={spatial.profile?.orientation !== "none"}` | 渲染端解析 orientation 枚举值 "patient"（默认开启患者方位显示） | 低 | 随枚举改名迁移；默认值语义（未声明时当患者方位）建议显式化 |
| apps/desktop/src/renderer/src/spatial/SliceView.tsx:7-8 | `// renders coarse-first when uncached, supports window presets, hover HU/value readout, patient-side edge labels…` | 注释含 HU 与 patient-side（实际读数显示 `volume.unit`，:158，通用） | 低 | 改成通用说法：value readout、方位标签 |
| apps/desktop/src/renderer/src/spatial/scene.ts:318,333,596,601-610 | `// A patient is seen from the front (anterior, −y) … /** Patient coordinates (LPS): the head up … */ … g.fillText(this.patient ? "LPS"[i] : "XYZ"[i], …) … g2.fillText("RAI"[i], …)` | 3D 相机注释与角标轴标签用患者/anterior/head 表述；XYZ 分支已通用 | 低 | 保留并说明理由：gizmo 标签受 patientOrientation 门控且与 DICOM 语义一致；注释可中性化 |
| apps/desktop/src/renderer/src/spatial/volume.ts:167-185 | `// ── patient sides (LPS: +x left, +y back, +z head) ── … export function sideOf … edges` | 前端方位计算模块用患者方位表述（volume.test.ts:24-26 的"放射学约定"测试同源） | 低 | 保留并说明理由：仅在 orientation=patient 时展示；命名可随枚举改名 |
| apps/desktop/src/renderer/src/spatial/SpatialView.tsx:118、SpatialDocView.tsx:436-439 | `{needsDisclaimer(sealed) && … {profile?.disclaimer?.trim() \|\| t("spatial.disclaimer")}}` | 兜底免责文案「标记中有 AI 给出的结果，仅供参考，不能代替专业人员的判断」（字符串在 locales/{en,zh-CN}/session.json:975/948，超出范围） | 低 | 保留并说明理由：机制通用（AI 结果需提示）；措辞偏医疗咨询语境，可改成中性的"AI 生成、仅供参考" |
| crates/finx-spatial/python/finx_spatial/__init__.py:1-13 | `volume.npy int16 HU, shape (k, j, i) … "k_towards_head": bool` | 包文档把导出契约描述为 int16 HU 与头方向 | 低 | 改成通用说法：值类型/单位以 meta.json 为准 |
| crates/finx-spatial/python/finx_spatial/__init__.py:69-70 | `"""The k index of the image whose number (as printed on the film / report) is n."""` | "胶片/报告上印的图像号"是医学影像语境 | 低 | 改成通用说法：读取器给的图像编号 |
| apps/desktop/src/renderer/src/spatial/volume.test.ts:6,12-16 | `const w = windowsOf([["肺窗", 1500, -600], … const lung = { name: "肺窗", width: 1500, level: -600 };` | 前端测试用肺窗数值 | 低 | 保留并说明理由：测试数据 |
| crates/finx-protocol/src/doc.rs:64,125,169-173,295 | `/// surface, LPS mm. … /// A 3D camera, LPS mm. … /// The first voxel's centre, LPS mm. … /// The values' unit when calibrated (`HU`); … /// `patient` (L/R, A/P, S/I shown) or `none`.` | 协议类型文档以 LPS/HU/patient 表述（结构本身通用，`unit`、`windows` 均为透传字段） | 低 | 随内核整体改名/改例迁移；`SpatialProfile` 本身按设计属于 skill 提交内容，方向正确 |

## 存疑

以下各条拿不准是否算"行业专有"，单独列出：

- **crates/finx-spatial/src/dicom.rs:297-301（CT → unit "HU"）**：可以认为这是"读取之外对字段的医学解释"（问题）；也可以认为 RescaleSlope/Intercept 是像素标定的一部分，给这个标定起名 HU 只是命名（允许）。两种读法都成立，取决于团队对"读取"边界的界定。若从严处理，可让读取器一律标 `Raw`、由 skill 经 `profile.unit` 声明 HU。
- **患者坐标系（LPS）作为内核契约**：`volume.rs`/`algo.rs`/`mesh.rs`/协议/前端的几何全部以 LPS/patient 词汇表述。几何结构（origin+direction 矩阵）是完全通用的，"patient" 只是 DICOM 读取器天然产出的语义。是整体改名为 world/source 坐标系（一次大面积纯重命名），还是保留 LPS 作为约定的坐标系名（文档改由"读取器决定语义"表述），属于设计取舍而非明确违规。
- **crates/finx-spatial/src/render.rs:6-10 放射学布局约定**：左=患者右、头朝上的读法是放射科约定，但任何 LPS 体数据用同一约定显示都自洽（3D 端 `scene.ts:318` 与前端 `volume.test.ts:24-26` 都遵循它）。它更像"显示约定"而非"医学知识"。
- **crates/finx-core/src/spatial.rs:296 `survey(&v, 50.0)`**：直方图 bin 宽写死 50 个单位，疑似按 HU 尺度选取；对 0..255 的灰度体数据只有几个 bin（仍可用，只是粒度失当）。是否算 CT 假设存疑。
- **apps/desktop/src/locales/{en,zh-CN}/session.json 中的 spatial.* 文案**（enableSkill/enableSkillHint/disclaimer 等）在本次审计范围之外，但它们是渲染层医学横幅（上表高项）的实际文案来源，清理时应一并处理。

## 小结

按"删掉医疗 skill 后内核仍能开 STL、看层面、做标记测量"的标准，最该先处理的是：

1. **`crates/finx-core/src/spatial_script.rs:173` 的 `DEFAULT_SKILL = "medical-imaging"`** —— 唯一一处内核代码在运行时依赖具体 skill 名的地方，删 skill 后 `script` 模式默认环境直接指向不存在的 skill；连带 :214 的工具描述（"(a CT)"、HU、k_towards_head）一起改。
2. **`crates/finx-spatial/python/finx_spatial/__init__.py:51-66` 的 lungs/左右肺回退逻辑** —— 内核 Python 包里唯一一段真正的器官级医学算法（含"患者右=图像左半"假设），必须挪进 medical-imaging。
3. **`apps/desktop/src/renderer/src/spatial/SpatialDocView.tsx:52,327-330` 的医学 skill 探测与启用横幅** —— 界面对医学 skill 的硬耦合；至少应配置驱动，理想是 skill 自带。
4. **`crates/finx-spatial/src/algo.rs:177-192` 的 superior/inferior 输出值** —— 内核输出里的解剖词，改为通用方向词后由 skill 翻译。
5. **默认窗数值（`crates/finx-core/src/spatial.rs:542`、`apps/desktop/src/renderer/src/spatial/volume.ts:145`）** —— CT 尺度的兜底窗让非 CT 体数据显示近全黑，最接近"删 skill 后体验损坏"的一条。

统计：主表共 **43** 条 —— 高 **5** 条、中 **10** 条、低 **28** 条；存疑 **5** 条（不计入主表）。除报告外未修改任何文件。
