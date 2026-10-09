"""参数提取(tool calling)的回归测试。

用假 client 覆盖各条返回路径,不打真实 API。覆盖点:
  - 正常 tool_call → 解析出参数字典
  - thinking 耗尽预算(content 空 + finish_reason=length)→ 显式报错,不静默降级
  - 模型没调工具 → 返回空 dict
  - 工具入参非法 JSON / 不符合 schema → 返回空 dict
  - 工具 schema 与 ExtractResult 一致,且不含服务端不认的键
"""
import json
from types import SimpleNamespace

import pytest

from agent.llm import BudgetExhaustedError, _model_name, extract_result
from agent.schemas import TOOL_NAME, build_tool_schema


def _tool_call(arguments: str, name: str = TOOL_NAME):
    return SimpleNamespace(function=SimpleNamespace(name=name, arguments=arguments))


def _client(*, tool_calls=None, content="", finish_reason="stop"):
    """假 OpenAI client:记录调用入参,返回构造好的响应。"""
    captured = {}

    def _create(**kwargs):
        captured.update(kwargs)
        message = SimpleNamespace(tool_calls=tool_calls, content=content)
        return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason=finish_reason)])

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=_create)))
    client.captured = captured
    return client


def test_parses_tool_call():
    client = _client(tool_calls=[_tool_call('{"intent": "describe", "temp": 520, "contrast": -0.08}')])
    out = extract_result(client, "日系清透")
    assert out["intent"] == "describe"
    assert out["temp"] == 520
    assert out["contrast"] == -0.08


def test_omitted_fields_are_not_in_result():
    """未提及的字段不应出现在结果里,否则会被当成用户已确认的风格。"""
    client = _client(tool_calls=[_tool_call('{"intent": "describe", "temp": 300}')])
    out = extract_result(client, "暖一点")
    assert "contrast" not in out
    assert "base_photo_style" not in out


def test_sends_tool_schema_and_no_tool_choice():
    """thinking 模式传 tool_choice 会被服务端 400 拒绝,必须不传。"""
    client = _client(tool_calls=[_tool_call('{"intent": "confirm"}')])
    extract_result(client, "确认")
    sent = client.captured
    assert sent["tools"][0]["function"]["name"] == TOOL_NAME
    assert "tool_choice" not in sent
    # 必须显式给足 max_tokens:thinking 模型思考阶段也吃这个预算
    assert sent["max_tokens"] and sent["max_tokens"] >= 1000


def test_budget_exhausted_raises_instead_of_silent_fallback():
    """实测 max_tokens=200 时稳定复现:content 空 + finish_reason=length。

    这种「什么都没拿到」不能和「用户没提参数」混为一谈 —— 后者走 clarify 是合理的,
    前者会让用户按了「确认」却被反问一句「先说说想要什么效果」。
    """
    client = _client(tool_calls=None, content="", finish_reason="length")
    with pytest.raises(BudgetExhaustedError) as e:
        extract_result(client, "确认")
    assert "MAX_TOKENS" in str(e.value)


def test_no_tool_call_returns_empty():
    client = _client(tool_calls=None, content="好的,我明白了。", finish_reason="stop")
    assert extract_result(client, "嗯") == {}


def test_invalid_json_arguments_returns_empty():
    client = _client(tool_calls=[_tool_call("这不是 JSON")])
    assert extract_result(client, "暖一点") == {}


def test_schema_violation_returns_empty():
    """temp 超出 schema 允许范围时 pydantic 会拒,回落为空 dict。"""
    client = _client(tool_calls=[_tool_call('{"intent": "describe", "lift": [0.1, 0.2]}')])
    assert extract_result(client, "暗部抬一点") == {}


def test_bad_intent_returns_empty():
    client = _client(tool_calls=[_tool_call('{"intent": "unknown_intent"}')])
    assert extract_result(client, "随便") == {}


@pytest.mark.parametrize("params", [
    {"temp": 3001},
    {"exposure": 3.01},
    {"tone_map": 1.01},
    {"highlights": -1.01},
    {"split_balance": 1.01},
    {"lift": [0, 0.101, 0]},
    {"gamma": [1, 0.49, 1]},
    {"gain": [1, 1, 1.51]},
])
def test_out_of_range_targets_return_empty(params):
    payload = {"intent": "describe", **params}
    client = _client(tool_calls=[_tool_call(json.dumps(payload))])
    assert extract_result(client, "调整风格") == {}


@pytest.mark.parametrize("field", ["exposure", "gain"])
@pytest.mark.parametrize("value", [True, "1", float("nan"), float("inf"), -float("inf")])
def test_non_numeric_or_non_finite_targets_return_empty(field, value):
    payload = {"intent": "describe", field: [value, 1, 1] if field == "gain" else value}
    client = _client(tool_calls=[_tool_call(json.dumps(payload))])
    assert extract_result(client, "调整风格") == {}


def test_valid_numeric_targets_at_bounds_are_preserved():
    payload = {"intent": "describe", "temp": 3000, "exposure": -3,
               "lift": [-0.1, 0, 0.1], "gamma": [0.5, 1, 1.5], "gain": [1.5, 1, 0.5]}
    client = _client(tool_calls=[_tool_call(json.dumps(payload))])
    assert extract_result(client, "调整风格") == payload


@pytest.mark.parametrize("name", ["propose_correction", "invented_tool"])
def test_wrong_tool_name_returns_empty(name):
    client = _client(tool_calls=[_tool_call('{"intent": "describe", "temp": 300}', name=name)])
    assert extract_result(client, "暖一点") == {}


def test_params_and_history_reach_prompt():
    client = _client(tool_calls=[_tool_call('{"intent": "describe", "temp": 900}')])
    extract_result(client, "再暖一点", params={"temp": 400}, history=["用户:暖一点", "助手:好的"])
    user_msg = client.captured["messages"][1]["content"]
    assert "400" in user_msg
    assert "暖一点" in user_msg


def test_tool_schema_drops_pydantic_metadata():
    """服务端不认 $defs/title,必须内联并剔除,否则可能被拒或被忽略。"""
    tool = build_tool_schema()
    params = tool["function"]["parameters"]
    flat = json.dumps(params, ensure_ascii=False)
    assert "$defs" not in flat
    assert "$ref" not in flat
    assert '"title"' not in flat
    # 约束信息必须还在
    assert params["properties"]["base_photo_style"]["anyOf"][0]["enum"] == ["STD", "NAT", "VIVD", "VLOG"]
    assert params["properties"]["intent"]["enum"] == ["confirm", "describe"]
    assert "lift" in params["properties"]


def test_default_model_is_flash(monkeypatch):
    """默认模型必须与 .env.example / README 一致,避免三处漂移。"""
    from agent.llm import DEFAULT_MODEL
    monkeypatch.delenv("CHROMA_LLM_MODEL", raising=False)
    assert DEFAULT_MODEL == "deepseek-flash"
    assert _model_name() == "deepseek-flash"
    monkeypatch.setenv("CHROMA_LLM_MODEL", "deepseek-v4-pro")
    assert _model_name() == "deepseek-v4-pro"


def test_documented_default_model_matches_code():
    """代码默认值、.env.example、README 表格三处必须一致。

    注意只校验「默认值那一行」:README 别处提到 deepseek-v4-pro 做对比是允许的。
    """
    import re
    from pathlib import Path

    from agent.llm import DEFAULT_MODEL

    root = Path(__file__).resolve().parent.parent.parent
    example = (root / ".env.example").read_text(encoding="utf-8")
    assert f"CHROMA_LLM_MODEL={DEFAULT_MODEL}" in example

    readme = (root / "README.md").read_text(encoding="utf-8")
    row = re.search(r"\|\s*`CHROMA_LLM_MODEL`\s*\|\s*模型名\s*\|\s*`([^`]+)`\s*\|", readme)
    assert row, "README 里找不到 CHROMA_LLM_MODEL 的默认值行"
    assert row.group(1) == DEFAULT_MODEL, f"README 写 {row.group(1)},代码默认 {DEFAULT_MODEL}"


def test_docs_do_not_claim_either_model_skips_thinking():
    """别再写「某个模型是非 thinking」—— 实测两个模型都会返回 reasoning_content。

    DeepSeek 的 thinking mode 默认开启,所以这个断言针对的是「按模型分类思考与否」这类
    错误表述(曾写错过一次:把官方 Tool Calls 页的 Non-thinking 示例当成 flash 的定性)。
    """
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent.parent
    for rel in ("README.md", ".env.example"):
        text = (root / rel).read_text(encoding="utf-8")
        for bad in ("非 thinking", "非thinking", "不支持思考"):
            assert bad not in text, f"{rel} 出现疑似错误表述:{bad}"


def test_response_with_reasoning_content_is_handled():
    """带 reasoning_content 的响应(思考模式的正常形态)必须能正常取到 tool_call。

    思考内容在 message.reasoning_content,主流程只读 content/tool_calls,
    这里锁住「多出来的字段不会影响解析」。
    """
    reasoning = SimpleNamespace(reasoning_content="先判断意图…… 用户说暖一点,应给正数")
    captured = {}

    def _create(**kwargs):
        captured.update(kwargs)
        message = SimpleNamespace(
            tool_calls=[_tool_call('{"intent": "describe", "temp": 300}')],
            content="",
            reasoning_content=reasoning.reasoning_content,
        )
        usage = SimpleNamespace(completion_tokens=180, completion_tokens_details=SimpleNamespace(reasoning_tokens=70))
        return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="tool_calls")], usage=usage)

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=_create)))
    out = extract_result(client, "暖一点")
    assert out == {"intent": "describe", "temp": 300}
    # 不能把 thinking 开关或 reasoning 参数混进请求
    assert "extra_body" not in captured
    assert "reasoning_effort" not in captured
    # temperature 在思考模式下被忽略,传了也没意义,当前实现不该传
    assert "temperature" not in captured


# ---- API 使用审计发现的三个问题 ----

def test_client_sets_explicit_timeout_and_retries():
    """SDK 默认 read timeout 600s + max_retries=2 → 最坏阻塞 30 分钟,必须显式收紧。"""
    from agent.llm import DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_SECONDS, get_llm

    client = get_llm()
    assert DEFAULT_TIMEOUT_SECONDS <= 60, "超时过长,用户界面等不起"
    assert client.max_retries == DEFAULT_MAX_RETRIES
    read_timeout = client.timeout if isinstance(client.timeout, (int, float)) else client.timeout.read
    assert read_timeout == DEFAULT_TIMEOUT_SECONDS
    # 最坏阻塞时间应是「秒级」而不是「分钟级」
    worst = read_timeout * (client.max_retries + 1)
    assert worst <= 120, f"最坏阻塞 {worst}s 仍然太长"


def test_empty_choices_does_not_raise():
    """服务端异常返回空 choices 时不能变成 IndexError 冒到 API 层。"""
    def _create(**kwargs):
        return SimpleNamespace(choices=[], usage=None)

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=_create)))
    assert extract_result(client, "暖一点") == {}


def test_malformed_tool_call_does_not_raise():
    """tool_calls 结构异常(缺 function/arguments)也要安全返回空 dict。"""
    for bad in (
        [SimpleNamespace()],                                  # 缺 function
        [SimpleNamespace(function=SimpleNamespace())],        # 缺 arguments
    ):
        client = _client(tool_calls=bad)
        assert extract_result(client, "暖一点") == {}


def test_schema_keeps_additionalProperties_false():
    """additionalProperties 是约束语义,不能被 schema 精简逻辑丢掉。"""
    params = build_tool_schema()["function"]["parameters"]
    assert params.get("additionalProperties") is False
    # 其他约束也要在
    assert params["properties"]["lift"]["anyOf"][0]["minItems"] == 3
    assert params["properties"]["intent"]["enum"] == ["confirm", "describe"]


def test_hallucinated_field_is_rejected_not_silently_dropped():
    """模型编造字段时应判非法(走 clarify),而不是被静默丢弃后当成正常结果。"""
    from agent.schemas import ExtractResult
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ExtractResult.model_validate({"intent": "describe", "temp": 300, "nonexistent": 1})

    client = _client(tool_calls=[_tool_call('{"intent": "describe", "bogus_field": 1}')])
    assert extract_result(client, "暖一点") == {}


def test_strict_mode_is_not_used_because_it_conflicts_with_optional_fields():
    """strict 模式要求所有属性都 required,与本项目「未提及字段可省略」结构性冲突,故不启用。

    这条测试锁住设计决策:如果有人想改用 strict,必须同时把 lift/gamma/gain 等
    全设为 required —— 那会让模型在用户没提时也补默认值,正是要避免的污染。
    """
    from agent.schemas import ExtractResult

    params = build_tool_schema()["function"]["parameters"]
    assert "strict" not in build_tool_schema()["function"]
    required = set(params.get("required", []))
    optional_fields = set(ExtractResult.model_fields) - required
    assert optional_fields, "若所有字段都 required,说明设计已变,需重新评估 strict"
    assert {"lift", "gamma", "gain", "temp"} <= optional_fields
