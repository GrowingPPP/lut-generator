# AI 开发上下文与任务指南

本指南帮助新接手者定位当前实现、维护领域边界并交接任务。规则入口为根目录 [AGENTS.md](../../AGENTS.md)，操作命令见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

## 文档组织

使用大小写固定的 `AGENTS.md`：根文件提供全局规则，`backend/AGENTS.md` 和 `frontend/AGENTS.md` 提供目录内约束。这符合 [AGENTS.md 开放格式](https://agents.md/)的 Markdown 与嵌套文件约定；不需要私有 schema 或按编辑器分别维护相同规则。

开发工具若不自动发现 AGENTS 文件，在任务中明确要求先读根文件和受影响目录文件。项目指南不依赖某个工具专有斜杠命令；用实际可用的读取、编辑、验证和审查能力完成任务。

## 先理解产品对象

| 概念 | 当前含义与关键边界 |
|---|---|
| 调色项目 | 可继续编辑的参数、输入、目标、保护和样张上下文；内部仍叫 workspace |
| 项目草稿 | 本机浏览器保存完整编辑状态与历史；账号元数据不等于跨设备完整草稿同步 |
| 命名版本 | 项目内保存的阶段快照；固定 A/B 选择不会随当前编辑自动变化 |
| 完整效果 LUT | 包含当前全部效果与单张校正的资产快照 |
| 可复用风格 | 保存风格贡献及依赖，追加到兼容输入上；不等同于替换全部参数 |
| 查看样张 / AI 主样张 | 看照片细节与指定 AI 输入是不同操作，多张样张共用当前效果 |
| 输入基准 | 样张信号与 LUT 预期输入必须匹配；EXIF 不能代替用户确认 Photo Style |
| 人物保护区域 | 源图上估计或人工修正的检查区域，只约束全局调色的质量判断 |
| AI 作业 | 冻结参数、来源与上下文的请求；幂等恢复、取消和续跑遵守原身份 |
| 预览缓存 / 原文件 | 可选缩小缓存可刷新恢复；原始 File 需重新绑定才能原分辨率导出 |

详细边界分别见 [调色项目管理](../specs/color-project-management.md)、[风格与版本](../specs/style-workspace-design.md)、[自动人物保护](../specs/automatic-subject-protection.md)。

## 当前实现定位

| 任务 | 优先阅读的代码 | 设计与验证依据 |
|---|---|---|
| 页面、登录与创作入口 | `frontend/src/App.jsx`、`frontend/src/StudioView.jsx`、`frontend/src/GenerateView.jsx` | [四步创作重构](../specs/guided-creation-redesign.md) |
| 四步导航与交付 | `frontend/src/hooks/useCreationFlow.js`、`frontend/src/lib/creationFlow.js`、`frontend/src/components/CreationNavigation.jsx`、`frontend/src/components/CreationPhotoSetup.jsx`、`frontend/src/components/CreationDelivery.jsx` | [四步创作重构](../specs/guided-creation-redesign.md)，步骤仅是查看偏好，不维护第二份调色状态 |
| 工作台、移动与放大调色布局 | `frontend/src/CreationFlow.css`、`frontend/src/StudioView.css`、`frontend/src/components/ToolPanel.jsx`、`frontend/src/components/ParameterPanel.jsx`、`frontend/src/components/ui/ComparisonControl.jsx` | [前端体验审核及第一批验收](../specs/ui-ux-pro-max-audit-2026-10-13.md)，普通与放大共用基础／全部展示偏好；底部面板大小和比较分界不创建调色历史 |
| 项目管理与本机恢复 | `frontend/src/hooks/useWorkspace.js`、`frontend/src/lib/workspace.js`、`frontend/src/lib/draftStorage.js`、`frontend/src/lib/projectManagement.js`；`backend/api/workspaces.py`、`backend/storage/db.py` | [项目管理](../specs/color-project-management.md) |
| 参数与模型允许调整项 | `backend/lut_engine/params.py`、`backend/api/models.py`、`backend/agent/schemas.py`；`frontend/src/lib/lutEngine.js`、`frontend/src/lib/parameterControls.js`、`frontend/src/lib/parameterHelp.js` | [LUT 设计修订](../lut-design-remediation.md)、`backend/tests/test_architecture.py` |
| 自动调色与作业恢复 | `backend/agent/auto.py`、`backend/agent/llm.py`、`backend/api/auto_jobs.py`；`frontend/src/hooks/useAutoRetouchController.js`、`frontend/src/lib/autoGrade.js`、`frontend/src/lib/autoJobs.js`、`frontend/src/lib/autoJobStorage.js` | [质量与加载](../specs/ai-quality-and-loading.md)、[四步创作重构](../specs/guided-creation-redesign.md)，控制器生命周期独立于当前可见步骤 |
| 人物识别及人工区域 | `backend/agent/subjects.py`、`backend/photo/subjects.py`、`backend/api/photos.py`；`frontend/src/lib/subjectAnalysis.js`、`frontend/src/components/SubjectProtectionPanel.jsx` | [人物保护设计](../specs/automatic-subject-protection.md) |
| 上传、色彩、预览与导出 | `backend/photo/color_management.py`、`backend/photo/render.py`、`backend/photo/export.py`；`frontend/src/lib/photoApi.js`、`frontend/src/lib/photoMetadata.js`、`frontend/src/lib/displayColor.js`、`frontend/src/lib/lutPreview.js`、`frontend/src/hooks/usePreview.js` | [样张兼容](../specs/sample-photo-compatibility.md)、[照片一致性](../specs/ai-retouch-photo-consistency.md) |
| 曲线与外部 LUT | `backend/lut_engine/curves.py`、`backend/lut_engine/imported.py`、`backend/lut_engine/lut3d.py`；`frontend/src/lib/curveMath.js`、`frontend/src/lib/cubeLut.js`、`frontend/src/lib/importedLuts.js` | [扩展设计](../specs/extended-grading-design.md) |
| 风格资产与历史修订 | `backend/api/main.py`、`backend/api/asset_metadata.py`、`backend/storage/db.py`；`frontend/src/components/LibraryView.jsx`、`frontend/src/components/StyleSaveDialog.jsx`、`frontend/src/lib/styleRecipe.js` | [风格与版本](../specs/style-workspace-design.md)、[资产删除](../specs/library-deletion.md) |
| 控件、主题与视觉 | `frontend/src/components/ui/`、`frontend/src/components/SelectField.jsx`、`frontend/src/themes.css`、`frontend/src/lib/theme.js` | [Radix 体验](../specs/radix-ui-experience.md)、[主题](../specs/theme-design.md)、[视觉质量](../specs/visual-quality.md) |
| 加载与重试 | `frontend/src/components/FeatureLoader.jsx`、`frontend/build/lazyModuleUrls.mjs`、`frontend/scripts/check_build_loading.mjs` | [质量与加载](../specs/ai-quality-and-loading.md) |

表中的代码路径均相对仓库根目录。文件移动或职责变化时同步维护该表；检索实现优先使用 `rg` 与 `rg --files`。

## 常见任务的检查顺序

### 新增或改变可调整参数

确认其能由 3D LUT 表达，明确输入、默认值、范围、保护与贡献归类；同步后端引擎、API 模型、Pydantic 工具、前端引擎、控件及新手说明。决定该字段是模型可调整项还是人工效果项，再跑架构契约和完整一致性检查。

### 预览全黑、图片不对或导出不一致

依次检查实际文件绑定、方向/ICC 规范化、输入确认、异步响应是否过期、33³ 网格/采样与显示转换；使用同一照片和冻结参数比较前端与后端。区分 JPEG 有损差异与真实颜色链路差异。不要用调参抵消解码问题。

### 自动修图误保护或效果没有变化

先检查主样张、目标模式、保护字段、人物证据和区域、候选增量及硬校验原因；核对报告展示的是实际应用项还是提议项。识别失败、字段被锁和质量拦截要有不同的用户说明，不能伪造成功或只扩大阈值。

### 草稿、项目删除或刷新恢复

检查账号/项目身份、修订、挂起事务、排队保存、作业回执和删除标记；验证来源变更、另一标签页更新及迟到响应。项目删除后核对 LUT 与修订仍可用、原文件不变及最后一个项目只有一个替代草稿。

### 界面与加载

先确认用户主要操作和当前页面层级，再复用已有组件及主题变量；检查曲线展开、放大调参、长名称与异常状态。构建后检查 manifest 门禁，不能通过静态引入全部功能消除异步加载问题。

## 任务描述与交接

发起任务时至少提供：用户目标、问题或复现、范围、已有约束、验收结果。没有材料时先完成可独立推进的部分，只有实际阻塞才请求补充。

可复用任务描述：

```text
目标：让用户完成什么操作，或解决什么现象。
依据：现有设计、复现条件、素材位置和已授权测试范围。
范围：需要涉及的模块，以及必须保留的数据与兼容行为。
验收：正常、失败、刷新/取消等相关边界；所需软件和浏览器验证。
先读根与对应目录 AGENTS.md，说明方法；行为变更先补方案，完成后独立复核。
```

交接或完成说明包含：

- 已实现的行为与决定，关联的设计文档。
- 受影响模块与接口/数据兼容边界。
- 实际执行的命令、浏览器场景及结果。
- 尚未执行的验证、具体限制与下一步所需材料。
- 临时账号、文件或服务的清理状态，以及提交号和是否已推送。

提交后的交接优先记录到相关设计或验收文档，不长期维护可能包含私人路径和已过期状态的全局会话日志。

## 文档时效与未完成验收

`docs/specs/architecture.md`、`technical.md` 等较早设计包含旧参数数量、早期入口与当时性能数据；用于理解最初取舍，不能直接当作当前字段或页面清单。当前入口由上表与代码核实，字段由架构契约测试核实；近期专题文档记录对应功能的实施范围。

历史模型测试只支持当时配置、素材与调用范围。真实艺术效果矩阵和相机实机验收继续待办；新增软件回归不自动完成这两项。发现过时说明时，在相关任务内有依据地更新，不改写历史验收结论。

早期 `test-plan.md` 中的 `smoke_auto_grade.py` 和四种假调色模式不是现有执行入口；采用贡献指南中的命令。视觉文字复核当前提供建议，不自动重写或回退参数。多段色彩转换可以采样合成到一个最终 `.cube`，关键约束是预览、检查与导出使用相同合成链路。
