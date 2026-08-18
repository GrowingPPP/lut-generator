from agent.graph import run_agent


def _extract_describe(message):
    return {"intent": "describe", "temp": 520.0, "contrast": -0.08}


def _extract_confirm(message):
    return {"intent": "confirm"}


def _extract_empty(message):
    return {"intent": "describe"}


def test_describe_asks_confirmation():
    result = run_agent(_extract_describe, "日系清透")
    assert result["done"] is False
    assert "确认" in result["reply"]
    assert result["params"]["temp"] == 520.0


def test_confirm_generates():
    result = run_agent(_extract_confirm, "确认", params={"temp": 520.0})
    assert result["done"] is True
    assert result["cube_text"].startswith("TITLE")
    assert "LUT_3D_SIZE 33" in result["cube_text"]


def test_empty_clarifies():
    result = run_agent(_extract_empty, "随便来一个")
    assert result["done"] is False
    assert result["reply"]


def test_confirm_without_params_clarifies():
    result = run_agent(_extract_confirm, "确认")
    assert result["done"] is False
    assert result["reply"]


def test_params_accumulate_across_turns():
    result = run_agent(_extract_describe, "再加一点暖色", params={"exposure": 0.2})
    assert result["done"] is False
    assert result["params"]["exposure"] == 0.2
    assert result["params"]["temp"] == 520.0
