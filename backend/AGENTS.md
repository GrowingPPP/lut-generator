# 后端开发规则

适用于 `backend/`，与根目录 [AGENTS.md](../AGENTS.md) 一起使用。

## 分层与契约

- `lut_engine/` 保持纯数学库，不反向依赖 API、模型、照片或存储层。公开引擎接口从 `lut_engine` 使用。
- `photo/` 保持可离线运行的计算层，不依赖 FastAPI、模型 SDK、存储、agent 或 Pydantic；数据类型与区域掩膜逻辑放在该层自身模块。
- `agent/auto.py` 负责编排，不直接访问 HTTP 或数据库；API 负责身份、请求边界与持久化。分层约束由 `tests/test_architecture.py` 校验。
- 引擎字段以 `lut_engine/params.py` 为准；同步 `api/models.py`、`agent/schemas.py` 与前端 `defaultParams()`。工具 JSON Schema 从 Pydantic 模型生成，不能手写一套漂移的字段表。
- `STYLE_FIELDS`、`MANUAL_EFFECT_FIELDS`、`CorrectionProposal` 有不同用途。新增引擎字段不能自动意味着模型可修改；人工效果字段继续排除在风格工具之外。
- 风格提取返回绝对目标值，校正提议返回增量；RGB 增量逐通道相加。不要混用这两种应用语义，入口校验也不能被引擎内部兼容限幅替代。
- 拒绝不支持的额外请求字段，保留既有合法请求的兼容。同步错误码、前端请求、恢复指纹与契约测试。
- 沿用 Python 的现有命名与格式，不为单一任务整库重排；注释说明领域或技术原因。

## 数据与作业

- 所有项目、版本、LUT、修订、会话与报告操作都校验账号归属。
- 项目删除、关联写入、版本及报告保存使用事务；沿用同一锁顺序，防止检查后删除和反向加锁造成竞争。
- `WorkspaceDeletedError` 与 `WorkspaceMissingError` 分别保留已删除与不存在的语义；删除标记阻止旧客户端重新注册项目。
- 删除项目解除 LUT 的来源关联，保留资产及其修订。专属会话才可清理，共享会话与固定自动会话按现有规则处理。
- 自动作业必须保持请求幂等、取消边界、来源核对及一次正式保存；删除项目后使运行结果和续跑失效。
- 当前活动作业由进程内 registry 管理，服务按单 worker 约束运行。不要把它描述为跨进程任务队列；扩展部署需另做持久队列方案。

## 图片与模型

- 使用 `photo/color_management.py` 的规范化图片路径处理方向、ICC 与 sRGB；V-Log 保留其输入编码。导出沿用现有采样语义与 sRGB 输出契约。
- 图片、缩略图和人物掩膜不得作为数据库长期内容保存；保存来源摘要、参数、统计与归一化区域等必要信息。
- 人物证据绑定照片来源和输入条件。识别失败或不确定不能回退为“暖色像素就是人物”；人工修正可覆盖识别结论。
- 不用更宽阈值掩盖错误输入、非有限数值、模型非法响应或颜色管理错误。
- 模型路径测试使用可控桩；实际服务调用需要遵守根目录的授权与隐私边界。不要打印模型密钥或图片 data URL。
- 关闭 `use_vision` 只关闭自动修图图像发送，统计和文字提议仍可能调用真实模型。API 的 `CHROMA_FAKE_GRADE` 任意非空值用于跳过真实模型，没有按字符串区分的四种测试模式；具体失败和候选行为使用桩覆盖。

## 验证命令

均从仓库根目录执行：

```bash
make test
PYTHONPATH=backend .venv/bin/python -m pytest backend/tests/test_workspace_api.py -q
PYTHONPATH=backend .venv/bin/python -m pytest backend/tests/test_architecture.py -q
```

常规 pytest 会先加载 `backend/conftest.py`，连接并初始化专用 MySQL 测试库；即使只选一个计算层测试，默认也需要数据库。测试账号需有测试库的建库和表操作权限。不得将 `CHROMA_TEST_DATABASE` 指向开发或生产数据，也不得打开 `CHROMA_ALLOW_CLEAR_DEV_DB` 绕过保护。

确认完全不依赖 API/storage 的纯计算测试可离线执行，例如：

```bash
PYTHONPATH=backend .venv/bin/python -m pytest --noconftest -p no:cacheprovider backend/tests/test_recipe_parity.py -q
```

`--noconftest` 不能用于数据库测试。参数、数学、曲线、外部 LUT 合成或 `.cube` 输出变化还须运行 `make check`；渲染或图片规范化变化覆盖对应 `test_photo_*`、前后端对拍和真实浏览器预览。只声明实际完成的验收。
