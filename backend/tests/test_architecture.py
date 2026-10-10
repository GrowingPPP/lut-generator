"""架构约束的自动化检查。

设计文档(docs/specs/architecture.md、technical.md)明确要求:

    api → agent.auto → photo.* → numpy/PIL

即 `photo/*` 是纯计算层,**不得** import fastapi / openai / storage / agent。
这条约束如果不自动检查,迟早会被破坏 —— 而破坏的代价是「测量层不再能离线单测」,
那时所有 L1 测试都需要 API key 与数据库,整套测试策略就塌了。

同时锁住另外两条同样重要、但同样「不写测试就会漂移」的约定:
  1. 引擎层(lut_engine)不得反向依赖 agent / api / photo
  2. 参数集在三处实现之间保持一致(后端引擎 / 前端引擎 / 工具 schema)
"""
import ast
import re
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
FRONTEND = BACKEND.parent / "frontend"

FORBIDDEN_IN_PHOTO = {"fastapi", "openai", "storage", "agent", "pydantic", "dotenv"}
FORBIDDEN_IN_ENGINE = {"agent", "api", "storage", "photo", "fastapi", "openai"}


def _imports_of(path: Path) -> set:
    """提取一个 .py 文件里所有顶层 import 的根模块名。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                names.add(a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                names.add(node.module.split(".")[0])
    return names


def _py_files(pkg: Path):
    return sorted(p for p in pkg.rglob("*.py") if "__pycache__" not in str(p))


# ---- 1. photo/* 是纯计算层 ----

@pytest.mark.parametrize("path", _py_files(BACKEND / "photo"), ids=lambda p: p.name)
def test_photo_layer_has_no_framework_dependencies(path):
    """photo/* 不得依赖框架层 —— 否则测量层无法脱离 API key / 数据库单测。"""
    hits = _imports_of(path) & FORBIDDEN_IN_PHOTO
    assert not hits, f"{path.name} 依赖了 {sorted(hits)},违反 photo/* 纯计算层约束"


def test_photo_layer_imports_actually_work_standalone():
    """实证:photo 的公开接口能在不碰数据库/LLM 配置的情况下导入与调用。"""
    import os
    saved = {k: os.environ.pop(k, None) for k in
             ("CHROMA_LLM_API_KEY", "OPENAI_API_KEY", "MYSQL_HOST", "MYSQL_DATABASE")}
    try:
        from photo import analyze  # noqa: F401
        from photo.fixtures import make_fixture
        s = analyze(make_fixture("neutral"))
        assert s.width > 0
    finally:
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v


# ---- 2. 引擎层不得反向依赖 ----

@pytest.mark.parametrize("path", _py_files(BACKEND / "lut_engine"), ids=lambda p: p.name)
def test_engine_layer_is_dependency_free(path):
    """lut_engine 是纯数学库,不得依赖上层。"""
    hits = _imports_of(path) & FORBIDDEN_IN_ENGINE
    assert not hits, f"{path.name} 依赖了 {sorted(hits)},引擎层必须保持纯净"


def test_engine_only_depends_on_numpy():
    """引擎的外部依赖只应有 numpy —— 加依赖要显式决策,不能悄悄引入。"""
    allowed = {"numpy", "math", "dataclasses", "typing", "__future__", "re"}
    for path in _py_files(BACKEND / "lut_engine"):
        extra = _imports_of(path) - allowed - {path.stem}
        # 允许包内相对导入(level>0 不会被 _imports_of 收集)
        assert not extra, f"{path.name} 引入了预期外依赖 {sorted(extra)}"


# ---- 3. 参数集三处一致 ----

def test_param_count_consistent_across_implementations():
    """后端 LutParams / 前端 lutEngine / 工具 schema 的参数字段必须一致。

    三处实现(两份引擎 + 一份 schema)靠人工同步必然漂移 ——
    这个项目已经吃过双实现漂移的苦(所以才有 test-parity)。
    """
    from dataclasses import asdict

    from agent.schemas import STYLE_FIELDS, AVAILABLE_FIELDS, MANUAL_EFFECT_FIELDS, ExtractResult
    from api.models import LutParamsModel
    from lut_engine.params import LutParams

    backend_fields = set(LutParams.__dataclass_fields__)
    assert set(LutParamsModel.model_fields) == backend_fields
    engine_defaults = asdict(LutParams())
    for key in ("lift", "gamma", "gain"):
        engine_defaults[key] = list(engine_defaults[key])
    assert LutParamsModel().model_dump() == engine_defaults
    assert backend_fields == set(AVAILABLE_FIELDS)
    assert set(STYLE_FIELDS) == backend_fields - set(MANUAL_EFFECT_FIELDS)
    assert set(ExtractResult.model_fields) - {"intent"} == set(STYLE_FIELDS)
    assert set(MANUAL_EFFECT_FIELDS) == {"curve_points", "external_lut_id", "external_lut_strength", "external_lut_mode"}

    js = (FRONTEND / "src/lib/lutEngine.js").read_text(encoding="utf-8")
    block = re.search(r"export function defaultParams\(\) \{\s*return \{(.*?)\n  \}", js, re.S)
    assert block, "找不到 defaultParams 的定义"
    frontend_fields = set(re.findall(r"(\w+):", block.group(1)))
    assert frontend_fields == backend_fields, (
        f"前端引擎与后端参数集不一致:"
        f" 仅后端有 {sorted(backend_fields - frontend_fields)},"
        f" 仅前端有 {sorted(frontend_fields - backend_fields)}"
    )


def test_frontend_labels_cover_all_params():
    """前端展示层的参数名映射必须覆盖全部参数 —— 漏一个就把原始键名甩给用户。"""
    from lut_engine.params import LutParams

    js = (FRONTEND / "src/lib/autoGrade.js").read_text(encoding="utf-8")
    block = re.search(r"export const PARAM_LABELS = \{(.*?)\n\}", js, re.S)
    assert block, "找不到 PARAM_LABELS"
    labelled = set(re.findall(r"(\w+):", block.group(1)))
    missing = set(LutParams.__dataclass_fields__) - labelled
    assert not missing, f"这些参数没有中文展示名: {sorted(missing)}"


# ---- 4. api 层不得反向依赖引擎内部实现细节 ----

def test_api_uses_engine_public_api_only():
    """api 层只应通过 lut_engine 的公开接口使用引擎,不直接摸子模块。"""
    tree = ast.parse((BACKEND / "api/main.py").read_text(encoding="utf-8"))
    bad = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            if node.module.startswith("lut_engine.") and node.module != "lut_engine.params":
                bad.append(node.module)
    assert not bad, f"api 层直接依赖了引擎内部模块 {bad},应走 lut_engine 公开接口"


def test_auto_module_does_not_touch_http_or_db():
    """agent/auto.py 是编排层,不该碰 HTTP 与数据库。"""
    hits = _imports_of(BACKEND / "agent/auto.py") & {"fastapi", "storage", "pymysql"}
    assert not hits, f"agent/auto.py 依赖了 {sorted(hits)},编排层不应碰 HTTP/DB"
