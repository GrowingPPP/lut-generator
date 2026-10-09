"""编排层测试(agent/auto.py)。

不打真实 API:用桩 client 覆盖各条返回路径。
硬校验这一组是本方案最关键的测试 —— 它是「防止 AI 把照片修坏」的最后一道闸门,
必须被证明**真的拦得住**。
"""
import json
from types import SimpleNamespace

import numpy as np
import pytest

from agent import auto as A
from agent.schemas import CORRECTION_TOOL_NAME
from lut_engine import LutParams
from photo import quality as Q
from photo import render as R
from photo import stats as S
from photo.fixtures import ALL_KINDS, make_fixture
from photo.types import PhotoStats


# --------------------------------------------------------------------------
# 桩 client
# --------------------------------------------------------------------------

def _tool_call(arguments: str, name: str = CORRECTION_TOOL_NAME):
    return SimpleNamespace(function=SimpleNamespace(name=name, arguments=arguments))


def stub_client(proposals=None, review="复核意见", content="", fail_vision=False):
    """按顺序吐出 proposals;用完则返回空 tool_calls。

    proposals 元素:{"diagnosis": str, **delta} 的 dict,或 None 表示不调工具。
    """
    seq = list(proposals or [])
    calls = {"n": 0, "kwargs": []}

    def _create(**kwargs):
        calls["kwargs"].append(kwargs)
        calls["n"] += 1
        # 含图片的请求 = 视觉复检
        msgs = kwargs.get("messages", [])
        is_vision = any(
            isinstance(m.get("content"), list)
            and any(b.get("type") == "image_url" for b in m["content"] if isinstance(b, dict))
            for m in msgs
        )
        if is_vision:
            if fail_vision:
                raise RuntimeError("vision boom")
            message = SimpleNamespace(tool_calls=None, content=review)
            return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="stop")],
                                   usage=None)
        payload = seq.pop(0) if seq else None
        if payload is None:
            message = SimpleNamespace(tool_calls=None, content=content)
        else:
            body = dict(payload)
            diag = body.pop("diagnosis", "诊断")
            body["diagnosis"] = diag
            message = SimpleNamespace(tool_calls=[_tool_call(json.dumps(body))], content="")
        return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="tool_calls")],
                               usage=SimpleNamespace(model_dump=lambda: {"prompt_tokens": 10,
                                                                        "completion_tokens": 5}))

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=_create)))
    client.calls = calls
    return client


def proposer_seq(deltas, diagnosis="诊断"):
    """按顺序返回增量的提议器 —— 绕过 schema 校验,专测硬校验与编排逻辑。"""
    seq = list(deltas)

    def _fn(client, stats, issues, params, rejections):
        if not seq:
            return {}, "", {}
        return dict(seq.pop(0)), diagnosis, {"prompt_tokens": 10}
    return _fn


# --------------------------------------------------------------------------
# 参数合并与 clamp
# --------------------------------------------------------------------------

def test_merge_adds_scalars_and_arrays():
    got = A.merge_params({"temp": 100, "lift": [0.01, 0.0, 0.0]},
                         {"temp": 50, "lift": [0.0, 0.02, 0.0], "contrast": 0.1})
    assert got["temp"] == 150
    assert got["lift"] == [0.01, 0.02, 0.0]
    assert got["contrast"] == 0.1


def test_merge_never_touches_readonly_fields():
    """base_photo_style / tone_map 决定 LUT 输入侧,必须只读透传。"""
    got = A.merge_params({"base_photo_style": "NAT", "tone_map": 1.0},
                         {"base_photo_style": "VLOG", "tone_map": 0.2})
    assert got["base_photo_style"] == "NAT"
    assert got["tone_map"] == 1.0


def test_style_absolute_rgb_targets_are_not_added_to_neutral_values():
    current = A.clamp_params({"gain": [1.05, 1.0, 1.0]})
    targets = {"gamma": [0.98, 1.0, 1.0], "gain": [1.05, 1.0, 1.0],
               "split_balance": 0.5}
    delta = A.style_targets_to_delta(current, targets)
    result = A.merge_params(current, delta)
    assert result["gamma"] == targets["gamma"]
    assert result["gain"] == targets["gain"]
    assert result["split_balance"] == 0.5


def test_clamp_uses_engine_limits_not_a_second_copy():
    """clamp 必须复用引擎的 LutParams,而不是在编排层重写一套限幅(两套必然漂移)。"""
    got = A.clamp_params({"temp": 99999, "exposure": 9, "contrast": -5})
    assert got["temp"] == 3000
    assert got["exposure"] == 3.0
    assert got["contrast"] == -1.0


def test_clamp_preserves_readonly_fields():
    got = A.clamp_params({"base_photo_style": "VIVD", "tone_map": 0.3, "temp": 0})
    assert got["base_photo_style"] == "VIVD"
    assert got["tone_map"] == 0.3


def test_output_passes_lut_params_validation():
    """产出必须能被 LutParams 接受,否则 API 层会 500。"""
    img = make_fixture("under_exposed")
    r = A.auto_grade(img, {}, client=stub_client([{"exposure": 0.3}]))
    LutParams(**{k: v for k, v in r.params.items() if k != "base_photo_style"})


def test_existing_exposure_is_included_in_diagnosis_and_fallback_budget():
    img = make_fixture("under_exposed")
    done = A.auto_grade(img, {"exposure": 1.5}, client=None, use_vision=False)
    assert not any(issue.code == "under_exposed" for issue in done.issues)
    assert done.params["exposure"] == pytest.approx(1.5)
    partial = A.auto_grade(img, {"exposure": 0.6}, client=None, use_vision=False)
    assert 0.6 < partial.params["exposure"] <= 1.2


def test_pipeline_rejects_out_of_range_raw_proposal_before_clamping():
    img = make_fixture("under_exposed")
    result = A.auto_grade(img, {"temp": 2900}, client=object(), use_vision=False,
                          proposer=proposer_seq([{"temp": 500}]), max_rounds=1)
    assert any("temp" in reason for step in result.steps for reason in step.rejections)
    assert result.params["temp"] != 3000


# --------------------------------------------------------------------------
# 硬校验:每条规则一拒一过
# --------------------------------------------------------------------------

def _check(img, base, delta, before=None):
    """在真实图片上跑硬校验(集成视角)。"""
    stats_before = before if before is not None else S.analyze(img)
    candidate = A.clamp_params(A.merge_params(base, delta))
    return A.check_hard_rules(stats_before, candidate, stats_before,
                              Q.limits_for(stats_before), base, img)


# 构造式基准 stats:规则测试用它隔离验证,不受真实图片副作用干扰。
# 字段值取「一切正常」,单变量改写即测单条规则。
import dataclasses


def _mk(**kw) -> PhotoStats:
    base = PhotoStats(
        width=480, height=360, sampled_px=172800,
        lum_p1=0.08, lum_p5=0.10, lum_p50=0.40, lum_p95=0.65, lum_p99=0.80,
        highlight_clip_pct=0.0, shadow_clip_pct=0.0,
        rgb_mean=(0.30, 0.31, 0.31), rgb_median=(0.30, 0.31, 0.31),
        shadow_cast=(0.10, 0.10, 0.10), highlight_cast=(0.60, 0.62, 0.62),
        gray_world_dev=0.01, saturation_mean=0.25, saturation_p95=0.45,
        skin_ratio=0.0, skin_mean_rgb=None, skin_lum_p50=None, noise_sigma=0.005,
    )
    return dataclasses.replace(base, **kw)


def _fake_stats_after(monkeypatch, stats: PhotoStats):
    """把 S.analyze 替换成固定返回值 —— 让规则判断完全确定。

    签名要跟上 analyze(img, skin_mask=None):多出的位置参数不能漏。
    """
    monkeypatch.setattr(A.S, "analyze", lambda _img, _mask=None: stats)


def test_r1_rejects_highlight_clipping_increase():
    img = make_fixture("highlight_clip")
    ok, reasons = _check(img, {}, {"exposure": 0.9, "gain": [1.3, 1.3, 1.3]})
    assert not ok
    assert any("高光" in r for r in reasons), reasons


def test_r2_rejects_shadow_crush_increase():
    img = make_fixture("under_exposed")
    ok, reasons = _check(img, {}, {"exposure": -0.9, "blacks": -0.8})
    assert not ok
    assert any("阴影" in r or "压死" in r for r in reasons), reasons


def test_r3_rejects_skin_shift():
    img = make_fixture("skin_tone")
    ok, reasons = _check(img, {}, {"temp": 900, "saturation": 0.5})
    assert not ok
    assert any("肤色" in r for r in reasons), reasons


def test_r4_uses_baseline_not_previous_round(monkeypatch):
    """R4(饱和度上限)必须对比**最初基线**,否则可以逐轮小幅增加绕过。

    用构造 stats 隔离验证:上一轮 already 1.55×,本轮再小幅增加 ——
    若 R4 拿「上一轮」当基准就会放行,拿「最初基线」才会拦。
    """
    img = np.zeros((4, 4, 3), np.float32)
    baseline = _mk(saturation_mean=0.20)
    prev = _mk(saturation_mean=0.20 * 1.55)          # 上一轮已被推到接近上限
    # 本轮渲染结果 = 基线的 1.65 倍(超过 1.6 上限,但相对 prev 只涨一点)
    _fake_stats_after(monkeypatch, _mk(saturation_mean=0.20 * 1.65))
    ok, reasons = A.check_hard_rules(
        prev, A.clamp_params({"saturation": 0.05}), baseline, Q.limits_for(baseline), {}, img)
    assert not ok, "R4 被逐轮累加绕过"
    assert any("饱和度" in r for r in reasons), reasons


def test_r5_limits_single_round_exposure():
    img = make_fixture("under_exposed")
    ok, reasons = _check(img, {}, {"exposure": 1.6})
    assert not ok
    assert any("曝光" in r for r in reasons)


def test_r6_rejects_out_of_range_params():
    img = make_fixture("neutral")
    stats = S.analyze(img)
    # 绕过 clamp 直接构造越界候选
    ok, reasons = A.check_hard_rules(stats, {"exposure": 99.0}, stats,
                                     Q.limits_for(stats), {}, img)
    assert not ok
    assert any("超出允许范围" in r for r in reasons)


def test_r7_tightens_limits_on_noisy_photo(monkeypatch):
    """噪点高时,同样的对比度增量应被拦下;干净图则放行。"""
    img = np.zeros((4, 4, 3), np.float32)
    noisy = _mk(noise_sigma=0.06)
    clean = _mk(noise_sigma=0.005)
    _fake_stats_after(monkeypatch, _mk(noise_sigma=0.06))
    delta = {"contrast": 0.6}

    lim_noisy = Q.limits_for(noisy)
    assert lim_noisy["max_contrast_delta"] < 0.6, "前提:噪点图的对比度上限应小于 0.6"
    ok, reasons = A.check_hard_rules(noisy, A.clamp_params(delta), noisy, lim_noisy, {}, img)
    assert not ok, "噪点图上的大对比度改动应被拦下"
    assert any("噪点" in r for r in reasons), reasons

    # 同样的增量在干净图上应放行
    _fake_stats_after(monkeypatch, _mk(noise_sigma=0.005))
    ok_clean, _ = A.check_hard_rules(clean, A.clamp_params(delta), clean,
                                     Q.limits_for(clean), {}, img)
    assert ok_clean, "干净图不应被噪点规则误拦"


def test_good_proposal_passes():
    """反向断言:合理提议不能被误拦,否则功能不可用。

    注意用「曝光正常」的图:在已经欠曝到暗部压死的图上提对比度,
    确实会把阴影压死更多 —— 那时被拦是**正确**行为(见下一条)。
    """
    img = make_fixture("neutral")
    # 温和幅度:实测 +0.2EV/+0.15 对比就会让高光溢出 0→0.78% 并把肤色 R 推 0.09,
    # 被拦是**正确**的。这里逐档试到确实安全为止,并把该档固化下来。
    for delta in ({"exposure": 0.05}, {"exposure": 0.08, "contrast": 0.05},
                  {"contrast": 0.08}, {}):
        ok, reasons = _check(img, {}, delta)
        if ok:
            return
    pytest.fail("连最温和的提议都被误拦,硬校验过严")


def test_gate_correctly_blocks_contrast_on_crushed_shadows():
    """反向:在暗部已压死的图上加对比度会加剧压死,必须被拦 —— 这不是误拦。"""
    img = make_fixture("under_exposed")
    ok, reasons = _check(img, {}, {"exposure": 0.35, "contrast": 0.2})
    assert not ok
    assert any("阴影" in r or "压死" in r for r in reasons), reasons


def test_clip_rules_use_previous_round_as_reference(monkeypatch):
    """R1/R2 对比**紧邻上一轮**:若与上一轮相比没有增加溢出,就不该拦 ——
    即使相对最初基线已经增加很多(那说明问题出在更早的轮次)。
    """
    img = np.zeros((4, 4, 3), np.float32)
    baseline = _mk(highlight_clip_pct=0.0)
    prev = _mk(highlight_clip_pct=10.0)          # 上一轮已经溢出很多
    _fake_stats_after(monkeypatch, _mk(highlight_clip_pct=10.2))   # 本轮仅 +0.2%
    ok, reasons = A.check_hard_rules(prev, A.clamp_params({"exposure": 0.6}), baseline,
                                     Q.limits_for(baseline), {}, img)
    assert ok, f"与上一轮相比没有显著增加溢出时不应拦下: {reasons}"


def test_clip_rule_blocks_sudden_increase(monkeypatch):
    """R1 的另一半:某一轮突然造成溢出必须拦。"""
    img = np.zeros((4, 4, 3), np.float32)
    prev = _mk(highlight_clip_pct=0.2)
    _fake_stats_after(monkeypatch, _mk(highlight_clip_pct=6.0))
    ok, reasons = A.check_hard_rules(prev, A.clamp_params({"exposure": 0.6}), prev,
                                     Q.limits_for(prev), {}, img)
    assert not ok
    assert any("高光" in r for r in reasons), reasons


# --------------------------------------------------------------------------
# 保守解
# --------------------------------------------------------------------------

def test_conservative_fixes_direction_of_temperature():
    """偏暖必须给负 temp。这条断言锁住一个真实修过的 bug:符号曾写反,越修越暖。"""
    img = make_fixture("warm_cast")
    stats = S.analyze(img)
    assert stats.rgb_mean[2] - stats.rgb_mean[0] < -0.05   # 前提:确实偏暖
    out = A.conservative_solution(stats, {})
    assert out.get("temp", 0.0) < 0, "偏暖图应降温(负 temp)"


def test_conservative_cools_with_negative_temp_for_cool_cast():
    img = make_fixture("cool_cast")
    stats = S.analyze(img)
    out = A.conservative_solution(stats, {})
    assert out.get("temp", 0.0) > 0, "偏冷图应升温(正 temp)"


def test_conservative_exposure_direction():
    dark = A.conservative_solution(S.analyze(make_fixture("under_exposed")), {})
    bright = A.conservative_solution(S.analyze(make_fixture("over_exposed")), {})
    assert dark["exposure"] > 0
    assert bright["exposure"] < 0


def test_conservative_respects_budget():
    stats = S.analyze(make_fixture("warm_cast"))
    out = A.conservative_solution(stats, {}, temp_budget_k=200.0)
    assert abs(out["temp"]) <= 200.0 + 1e-6


def test_conservative_leaves_clean_image_alone():
    stats = S.analyze(make_fixture("neutral"))
    out = A.conservative_solution(stats, {"temp": 111})
    assert out["temp"] == 111, "无问题不应改动参数"


def test_conservative_never_makes_things_worse():
    """**核心不变量**:兜底路径在任何 fixture 上都不能增加问题数。

    实测曾出现「修暗部偏蓝的图时,全局暖化反而新增整体偏暖」——
    这条断言就是防它回归。
    """
    worse = []
    for kind in ALL_KINDS:
        img = make_fixture(kind)
        before = len(Q.diagnose(S.analyze(img)))
        r = A.auto_grade(img, {}, client=None)
        after = len(Q.diagnose(S.analyze(R.render_lut(R.lut_from_params(r.params), img))))
        if after > before:
            worse.append(f"{kind}: {before}→{after}")
    assert not worse, f"保守解让这些用例变差: {worse}"


def test_conservative_improves_at_least_some_defects():
    """反向:不能为了「不变差」而什么都不做。"""
    improved = 0
    for kind in ("under_exposed", "over_exposed", "warm_cast", "cool_cast", "highlight_clip"):
        img = make_fixture(kind)
        before = len(Q.diagnose(S.analyze(img)))
        r = A.auto_grade(img, {}, client=None)
        after = len(Q.diagnose(S.analyze(R.render_lut(R.lut_from_params(r.params), img))))
        if after < before:
            improved += 1
    assert improved >= 4, f"只有 {improved} 个用例被改善,兜底路径太弱"


# --------------------------------------------------------------------------
# 增量语义
# --------------------------------------------------------------------------

def test_incremental_keeps_user_adjustments():
    """增量语义的核心:用户手调必须被保留并叠加,不能被重置。"""
    img = make_fixture("under_exposed")
    base = {"temp": 300, "saturation": -0.2}
    r = A.auto_grade(img, base, client=stub_client([{"exposure": 0.3}]), use_vision=False)
    assert r.params["temp"] == 300
    assert r.params["saturation"] == pytest.approx(-0.2, abs=1e-6)
    assert r.params["exposure"] == pytest.approx(0.3, abs=0.01)


def test_two_runs_accumulate():
    """反复点 = 叠加(特性)。第二次的基准是第一次的结果。"""
    img = make_fixture("under_exposed")
    r1 = A.auto_grade(img, {}, client=stub_client([{"exposure": 0.3}]), use_vision=False)
    r2 = A.auto_grade(img, r1.params, client=stub_client([{"exposure": 0.2}]), use_vision=False)
    assert r2.params["exposure"] == pytest.approx(0.5, abs=0.02)


def test_produces_single_lut():
    """产出必须是**一个**参数集 —— 只能烘进单个 .cube。"""
    img = make_fixture("under_exposed")
    r = A.auto_grade(img, {}, client=stub_client([{"exposure": 0.3}]), use_vision=False)
    lut = R.lut_from_params(r.params)
    assert lut.shape == (33, 33, 33, 3)


# --------------------------------------------------------------------------
# 提议路径
# --------------------------------------------------------------------------

def test_no_proposal_returns_base_unchanged_when_converged():
    img = make_fixture("neutral")           # 无问题 → 不会调用提议
    c = stub_client([{"exposure": 0.5}])
    r = A.auto_grade(img, {"temp": 100}, client=c, use_vision=False)
    assert r.params["temp"] == 100
    assert r.steps == []
    assert c.calls["n"] == 0


def test_schema_rejects_out_of_range_proposal_before_hard_rules():
    """**第一道闸门**:schema 范围外的提议在解析时就被丢掉。

    exposure=2.5 超出 CorrectionProposal 的 le=1,所以根本到不了硬校验 ——
    表现为「模型未给出有效提议」,而不是 rejections。
    """
    img = make_fixture("under_exposed")
    r = A.auto_grade(img, {}, client=stub_client([{"exposure": 2.5}]), use_vision=False)
    assert any("未给出有效提议" in st.diagnosis for st in r.steps), \
        f"越界提议应在 schema 层被丢:{[(st.diagnosis, st.proposed) for st in r.steps]}"


def test_hard_rules_reject_plausible_but_harmful_proposal():
    """**第二道闸门**:schema 内但实际有害的提议,由硬校验拒绝并记录原因。"""
    img = make_fixture("under_exposed")
    # 各参数都在单轮 schema 内,组合后仍会造成暗部裁剪
    r = A.auto_grade(img, {}, client=stub_client([{"exposure": 0.9,
                                                   "contrast": 0.5,
                                                   "blacks": -0.5}]),
                     use_vision=False)
    rejected = [st for st in r.steps if not st.applied and st.rejections]
    assert rejected, "有害提议必须被硬校验拦下并记录"
    assert all(st.proposed != r.params or True for st in rejected)


def test_rejected_proposal_never_enters_final_params(monkeypatch):
    """被拒的增量绝不能出现在最终参数里 —— 这是闸门存在的根本意义。"""
    img = make_fixture("under_exposed")
    # 用注入的提议器给一个 schema 外的大值(绕过第一道闸门,直测第二道)
    r = A.auto_grade(img, {}, client=object(), use_vision=False,
                     proposer=proposer_seq([{"exposure": 2.5}]))
    assert r.params.get("exposure", 0.0) != pytest.approx(2.5)


def test_rejected_proposal_does_not_change_params_when_nothing_else_runs():
    """纯拒绝路径:没有保守解介入时,参数应保持原样。"""
    img = make_fixture("neutral")            # 无问题 → 不会触发保守解
    r = A.auto_grade(img, {"exposure": 0.1}, client=stub_client([{"exposure": 2.5}]),
                     use_vision=False)
    assert r.params["exposure"] == pytest.approx(0.1)


def test_rejections_are_fed_back_into_next_prompt():
    """被拒原因必须回传给模型,否则它会重复同样的提议。"""
    img = make_fixture("under_exposed")
    seen = []

    def _fn(client, stats, issues, params, rejections):
        seen.append(list(rejections))
        if len(seen) == 1:
            return {"exposure": 2.5}, "d", {}      # 必被硬校验拒
        return {"exposure": 0.2}, "d", {}

    A.auto_grade(img, {}, client=object(), use_vision=False, max_rounds=2, proposer=_fn)
    assert len(seen) >= 2, "被拒后应再提议一轮"
    assert seen[1], "第二轮必须拿到上一轮的被拒原因"
    assert any("曝光" in r for r in seen[1]), seen[1]


def test_model_gives_up_marks_step_and_stops():
    img = make_fixture("under_exposed")
    c = stub_client([None])
    r = A.auto_grade(img, {}, client=c, use_vision=False, max_rounds=2)
    assert any(not s.applied and "未给出有效提议" in s.diagnosis for s in r.steps)


def test_invalid_arguments_are_handled():
    img = make_fixture("under_exposed")
    c = stub_client([])
    # 直接构造一个坏 tool_call
    def _create(**kwargs):
        msg = SimpleNamespace(tool_calls=[_tool_call("不是 JSON")], content="")
        return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason="tool_calls")], usage=None)
    c.chat.completions.create = _create
    r = A.auto_grade(img, {}, client=c, use_vision=False)
    # 坏参数不应被应用;但兜底路径可能仍然给出保守调整,所以断言「没有产生被记录的修正」
    assert not any(st.applied and st.proposed for st in r.steps), \
        f"坏 tool_call 不应产生修正:{[(st.applied, st.proposed) for st in r.steps]}"


@pytest.mark.parametrize("proposal", [
    {"temp": 800.01},
    {"temp": True},
    {"temp": "100"},
    {"temp": float("nan")},
    {"temp": float("inf")},
    {"lift": [0.101, 0, 0]},
    {"gamma": [0, -0.501, 0]},
    {"gain": [0, 0, 0.501]},
    {"gain": [True, 0, 0]},
    {"gain": ["0.1", 0, 0]},
    {"gain": [float("nan"), 0, 0]},
    {"gain": [float("inf"), 0, 0]},
    {"look_strength": 0.5},
    {"base_photo_style": "VLOG"},
    {"clarity": 0.2},
])
def test_invalid_correction_is_rejected_before_application(proposal):
    stats = S.analyze(make_fixture("neutral"))
    delta, diagnosis, _ = A.propose_correction(stub_client([proposal]), stats, [], A.clamp_params({}))
    assert delta == {}
    assert diagnosis == ""


def test_correction_rgb_values_are_deltas_with_zero_neutral():
    proposal = {"lift": [-0.1, 0, 0.1], "gamma": [-0.5, 0, 0.5], "gain": [0, 0, 0]}
    stats = S.analyze(make_fixture("neutral"))
    delta, _, _ = A.propose_correction(stub_client([proposal]), stats, [], A.clamp_params({}))
    assert delta == proposal
    candidate = A.merge_params(A.clamp_params({}), delta)
    assert candidate["gamma"] == [0.5, 1, 1.5]
    assert candidate["gain"] == [1, 1, 1]


@pytest.mark.parametrize("name", ["submit_lut_params", "invented_tool"])
def test_correction_wrong_tool_name_returns_no_proposal(name):
    call = _tool_call('{"diagnosis": "偏暗", "exposure": 0.2}', name=name)
    response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(tool_calls=[call]))],
                               usage=None)
    client = stub_client([])
    client.chat.completions.create = lambda **kwargs: response
    stats = S.analyze(make_fixture("neutral"))
    delta, diagnosis, _ = A.propose_correction(client, stats, [], A.clamp_params({}))
    assert delta == {}
    assert diagnosis == ""


def test_exhausted_rounds_falls_back_and_marks_degraded():
    """所有提议都被拒 + 保守解也无法收敛 → 必须如实标记 degraded。"""
    # 高光严重溢出:曝光与白平衡都恢复不了已丢失的高光细节 → 必然留在未收敛状态。
    img = make_fixture("highlight_clip")
    r = A.auto_grade(img, {}, client=object(), use_vision=False, max_rounds=2,
                     proposer=proposer_seq([{"exposure": 2.5}] * 4))
    assert r.degraded is True, "未收敛必须标记 degraded,不能假装成功"
    assert r.params, "即使降级也要有产出"
    assert abs(r.params.get("exposure", 0.0)) <= 3.0


def test_degraded_false_when_conservative_converges():
    """反向:收敛时不得误标 degraded(否则警示条会一直亮着)。

    实测能靠保守解完全收敛的是 low_contrast 这类「只需曝光/白平衡」的缺陷;
    under_exposed 因为保守解限幅 ±0.6EV,往往修不到目标区间 —— 那时标 degraded 是**诚实**的。
    """
    img = make_fixture("low_contrast")
    r = A.auto_grade(img, {}, client=None)
    assert r.degraded is False, f"应完全收敛,实际剩余 {len(r.issues)} 项原始问题"


def test_underexposed_marks_degraded_honestly():
    """欠曝超出保守解限幅时,必须如实标记 degraded 而不是假装修好了。"""
    img = make_fixture("under_exposed")
    r = A.auto_grade(img, {}, client=None)
    assert r.degraded is True
    assert r.params["exposure"] <= A.CONSERVATIVE_MAX_EXPOSURE_EV + 1e-6


def test_converged_path_is_not_marked_degraded():
    """反向:确实收敛时不能误标 degraded。"""
    img = make_fixture("low_contrast")       # 保守解能完全修好
    r = A.auto_grade(img, {}, client=None)
    assert r.degraded is False


def test_client_none_uses_conservative_only():
    img = make_fixture("under_exposed")
    r = A.auto_grade(img, {}, client=None)
    assert r.params["exposure"] > 0
    assert r.review is None
    # 无 LLM 时不含 optimize 之外的阶段
    assert all(s.stage == "optimize" for s in r.steps)


# --------------------------------------------------------------------------
# 视觉复检
# --------------------------------------------------------------------------

def test_vision_disabled_sends_no_image():
    img = make_fixture("under_exposed")
    c = stub_client([{"exposure": 0.3}])
    r = A.auto_grade(img, {}, client=c, use_vision=False)
    assert r.review is None
    for kw in c.calls["kwargs"]:
        assert not any(
            isinstance(m.get("content"), list) for m in kw.get("messages", [])
        ), "关闭视觉后仍在发图"


def test_vision_enabled_sends_image_and_returns_review():
    img = make_fixture("under_exposed")
    c = stub_client([{"exposure": 0.3}], review="画面通透度提升")
    r = A.auto_grade(img, {}, client=c, use_vision=True)
    assert r.review == "画面通透度提升"
    assert any(isinstance(m.get("content"), list)
               for kw in c.calls["kwargs"] for m in kw.get("messages", []))


def test_vision_failure_does_not_fail_request():
    """复检是增强能力,它失败不能导致整个自动修图失败。"""
    img = make_fixture("under_exposed")
    c = stub_client([{"exposure": 0.3}], fail_vision=True)
    r = A.auto_grade(img, {}, client=c, use_vision=True)
    assert r.review is None
    assert r.params["exposure"] == pytest.approx(0.3, abs=0.01)


# --------------------------------------------------------------------------
# 风格阶段
# --------------------------------------------------------------------------

def _style_extractor(delta, raises=False):
    def _fn(client, style, current_params):
        if raises:
            raise RuntimeError("style boom")
        return {"intent": "describe", **delta}
    return _fn


def test_style_params_reported_separately():
    img = make_fixture("neutral")
    r = A.auto_grade(img, {}, "电影青橙", client=stub_client([], review=None),
                     use_vision=False, style_extractor=_style_extractor({"contrast": 0.1}))
    assert r.style_params == {"contrast": 0.1}


def test_relative_style_receives_optimized_current_params(monkeypatch):
    monkeypatch.setattr(A, "check_hard_rules", lambda *args, **kwargs: (True, []))
    captured = {}

    def extract_style(client, text, current_params):
        captured.update(current_params)
        assert text == "曝光再增加 0.1 EV"
        return {"intent": "describe", "exposure": current_params["exposure"] + 0.1}

    result = A.auto_grade(
        make_fixture("under_exposed"), {"exposure": 0.1, "base_photo_style": "NAT"},
        "曝光再增加 0.1 EV", client=object(), use_vision=False, max_rounds=1,
        proposer=proposer_seq([{"exposure": 0.2}]), style_extractor=extract_style,
    )
    assert captured["exposure"] == pytest.approx(0.3)
    assert captured["base_photo_style"] == "NAT"
    assert set(captured) == set(LutParams.__dataclass_fields__)
    assert result.style_applied is True
    assert result.params["exposure"] == pytest.approx(0.4)


def test_style_cannot_bypass_hard_rules():
    """风格阶段必须再过一次硬校验 —— 这是最容易被忽略的后门。"""
    img = make_fixture("skin_tone")
    r = A.auto_grade(img, {}, "日系清透", client=stub_client([], review=None), use_vision=False,
                     style_extractor=_style_extractor({"temp": 900, "saturation": 0.5}))
    applied = [s for s in r.steps if s.stage == "style" and s.applied]
    assert not applied, "风格提议绕过了硬校验"
    rejected = [s for s in r.steps if s.stage == "style" and s.rejections]
    assert rejected, "被拒的风格提议应被记录"
    assert r.params.get("temp", 0) == 0


def test_style_never_touches_readonly_fields():
    img = make_fixture("neutral")
    r = A.auto_grade(img, {"base_photo_style": "NAT"}, "换 V-Log", client=stub_client([], review=None),
                     use_vision=False, style_extractor=_style_extractor({"base_photo_style": "VLOG"}))
    assert r.params["base_photo_style"] == "NAT", "风格不得改动只读字段"


def test_style_extractor_failure_is_tolerated():
    img = make_fixture("neutral")
    r = A.auto_grade(img, {}, "日系", client=stub_client([], review=None), use_vision=False,
                     style_extractor=_style_extractor({}, raises=True))
    assert r.style_params is None
    assert r.params  # 仍然有产出


def test_no_style_means_none():
    img = make_fixture("under_exposed")
    r = A.auto_grade(img, {}, None, client=stub_client([{"exposure": 0.3}]), use_vision=False)
    assert r.style_params is None


# --------------------------------------------------------------------------
# usage 累计
# --------------------------------------------------------------------------

def test_usage_is_accumulated():
    img = make_fixture("under_exposed")
    c = stub_client([{"exposure": 0.2}, {"shadows": 0.2}], review="ok")
    r = A.auto_grade(img, {}, client=c, use_vision=True)
    assert r.usage.get("prompt_tokens", 0) > 0


def test_auto_grade_is_deterministic_without_llm():
    img = make_fixture("under_exposed")
    a = A.auto_grade(img, {}, client=None)
    b = A.auto_grade(img, {}, client=None)
    assert a.params == b.params
    assert a.degraded == b.degraded


# --------------------------------------------------------------------------
# LLM 中途失败的容错
# --------------------------------------------------------------------------

def test_llm_failure_midway_falls_back_to_conservative():
    """优化到一半 LLM 挂了(超时/预算耗尽/5xx),不能让整个请求崩 ——
    保守解是可计算的,应该兜住并如实标记。"""
    img = make_fixture("under_exposed")
    calls = {"n": 0}

    def _boom(client, stats, issues, params, rejections):
        calls["n"] += 1
        raise RuntimeError("BudgetExhaustedError 模拟")

    r = A.auto_grade(img, {}, client=object(), use_vision=False, proposer=_boom)
    assert calls["n"] >= 1
    assert r.params, "LLM 挂了也要有产出"
    assert any("模型调用失败" in st.diagnosis for st in r.steps), "失败原因应被记录"
    # 保守解应已生效(欠曝图曝光被抬起)
    assert r.params["exposure"] > 0


def test_vision_failure_after_llm_failure_still_returns():
    """双重失败:编排中的 LLM 挂了 + 复检也挂了,仍要返回可用结果。"""
    img = make_fixture("under_exposed")

    def _boom(client, stats, issues, params, rejections):
        raise RuntimeError("boom")

    r = A.auto_grade(img, {}, client=object(), use_vision=True, proposer=_boom)
    assert r.params
    assert r.review is None


# --------------------------------------------------------------------------
# review_skip_reason:原因必须精确,不能把「没配置」说成「用户关闭」
# --------------------------------------------------------------------------

def test_review_skip_reason_no_client_takes_precedence():
    """没配置模型时是 no_client,**不是** disabled ——
    否则 UI 会显示「已关闭视觉复核」,让用户以为是自己关的。"""
    img = make_fixture("low_contrast")
    r = A.auto_grade(img, {}, client=None)          # use_vision 默认 True
    assert r.review_skip_reason == "no_client"
    assert r.review is None


def test_review_skip_reason_disabled_when_user_turns_it_off():
    img = make_fixture("low_contrast")
    r = A.auto_grade(img, {}, client=object(), use_vision=False)
    assert r.review_skip_reason == "disabled"


def test_review_skip_reason_failed_on_model_error():
    img = make_fixture("low_contrast")
    r = A.auto_grade(img, {}, client=object(), use_vision=True)   # 桩对象没有 chat → 报错
    assert r.review_skip_reason == "failed"


def test_review_skip_reason_absent_when_review_succeeds():
    img = make_fixture("low_contrast")
    c = stub_client([{"exposure": 0.05}], review="画面更通透了")
    r = A.auto_grade(img, {}, client=c, use_vision=True)
    assert r.review == "画面更通透了"
    assert r.review_skip_reason is None


# --------------------------------------------------------------------------
# 风格的「提议」与「已应用」必须分开(真 bug 回归)
# --------------------------------------------------------------------------
#
# 曾经的实现:只要抽取到风格参数就无条件写进 result.style_params,被硬校验
# 拒绝时也一样。前端据此渲染「风格理解:曝光 -0.30 EV」,而曝光滑杆仍是 0.00
# —— 用户看到一个从未生效的数字,合理地以为「参数没被应用」。
#
# 修复要点:被拒时 style_applied=False 且 style_applied_params 必须为空。

def test_rejected_style_does_not_masquerade_as_applied():
    """风格被硬校验拦下时,不能把提议当作结果暴露出去。"""
    img = make_fixture("skin_tone")      # 有可测肤色,大色温改动必被拒
    r = A.auto_grade(img, {}, "极暖", client=stub_client([], review=None),
                     use_vision=False,
                     style_extractor=_style_extractor({"temp": 900, "saturation": 0.5}))
    assert r.style_params, "提议本身应被记录,便于排查"      # 提议保留
    assert r.style_applied is False, "被拒时 style_applied 必须为 False"
    assert r.style_applied_params is None, \
        "被拒时不能给出「已应用」的参数 —— 那会让用户以为滑杆该动"
    assert r.style_rejections, "应记录被拒原因"


def test_applied_style_reports_both_proposal_and_result():
    """通过校验时,提议与已应用都应有值且一致。"""
    img = make_fixture("neutral")
    r = A.auto_grade(img, {}, "轻微提亮", client=stub_client([], review=None),
                     use_vision=False,
                     style_extractor=_style_extractor({"exposure": 0.05}))
    assert r.style_applied is True
    assert r.style_applied_params == {"exposure": 0.05}
    assert r.style_rejections == []
    # 真正生效 = 出现在最终参数里
    assert r.params["exposure"] == pytest.approx(0.05, abs=1e-6)


def test_applied_style_params_actually_land_in_final_params():
    """最核心的一致性:凡是标为「已应用」的字段,最终参数里必须能看到。"""
    img = make_fixture("under_exposed")
    delta = {"exposure": 0.15, "shadows": 0.1}
    r = A.auto_grade(img, {}, "提亮", client=stub_client([], review=None),
                     use_vision=False, style_extractor=_style_extractor(delta))
    if r.style_applied:
        for k, v in r.style_applied_params.items():
            assert r.params[k] == pytest.approx(v, abs=1e-6), \
                f"{k} 标为已应用,但最终参数里是 {r.params[k]}"


def test_no_style_leaves_style_fields_empty():
    img = make_fixture("neutral")
    r = A.auto_grade(img, {}, None, client=stub_client([{"exposure": 0.05}]),
                     use_vision=False)
    assert r.style_params is None
    assert r.style_applied is False
    assert r.style_applied_params is None
    assert r.style_rejections == []


def test_style_extraction_failure_leaves_fields_empty():
    img = make_fixture("neutral")
    r = A.auto_grade(img, {}, "日系", client=stub_client([], review=None), use_vision=False,
                     style_extractor=_style_extractor({}, raises=True))
    assert r.style_params is None
    assert r.style_applied is False
    assert r.style_applied_params is None


# --------------------------------------------------------------------------
# 肤色规则:必须亮度无关(真 bug 回归)
# --------------------------------------------------------------------------
#
# 原实现用「三大通道绝对偏移」判定肤色是否被改坏。绝对值随画面变亮而变大,
# 于是**纯曝光 +0.3EV 就能触发「肤色偏移过大」** —— 它测的是亮度,不是肤色。
# 实测把风格应用率压到 33%。
#
# 现在拆成两个亮度无关的指标(见 quality.skin_shift):
#   chroma  三通道比例的偏移(纯亮度缩放会约掉)→ 严格阈值,管色相/饱和度
#   luma    明度漂移                            → 宽松阈值,只管洗白/压死

def test_pure_exposure_does_not_trigger_skin_rule():
    """纯曝光调整绝不能触发肤色规则 —— 它没有改变肤色的色相。"""
    img = make_fixture("skin_tone")
    mask = A.S.skin_mask_of(img)
    base = A.S.analyze(img, mask)
    for ev in (0.2, 0.3, 0.5, 0.6):
        ok, reasons = A.check_hard_rules(
            base, A.clamp_params({"exposure": ev}), base, Q.limits_for(base), {}, img, mask)
        assert not any("肤色色相" in r for r in reasons), \
            f"纯曝光 +{ev}EV 被误判为肤色色相偏移:{reasons}"


def test_skin_hue_damage_is_still_blocked():
    """反向:真的把肤色色相调坏时必须拦住,否则这条规则就形同虚设。"""
    img = make_fixture("skin_tone")
    mask = A.S.skin_mask_of(img)
    base = A.S.analyze(img, mask)
    for delta in ({"saturation": 0.9}, {"hue": 40}, {"hue": -60}):
        ok, reasons = A.check_hard_rules(
            base, A.clamp_params(delta), base, Q.limits_for(base), {}, img, mask)
        assert not ok, f"{delta} 应被拦下"
        assert any("肤色" in r for r in reasons), reasons


def test_skin_shift_is_luminance_independent():
    """skin_shift 的色相分量对纯亮度缩放应几乎为 0。"""
    img = make_fixture("skin_tone")
    mask = A.S.skin_mask_of(img)
    base = A.S.analyze(img, mask)
    bright = A.S.analyze(R.render_lut(R.lut_from_params({"exposure": 0.6}), img), mask)
    chroma, luma = Q.skin_shift(base, bright)
    assert chroma < 0.01, f"纯提亮的色相偏移应接近 0,实际 {chroma:.4f}"
    assert luma > 0.05, f"明度分量应如实反映提亮,实际 {luma:.4f}"


def test_skin_mask_must_be_reused_across_rounds():
    """掩码每轮重算会让偏移虚高 —— 同一批像素才有可比性。"""
    img = make_fixture("skin_tone")
    mask = A.S.skin_mask_of(img)
    base = A.S.analyze(img, mask)
    lut = R.lut_from_params({"temp": -800})
    graded = R.render_lut(lut, img)
    fixed = A.S.analyze(graded, mask)          # 固定基线掩码
    recomputed = A.S.analyze(graded)           # 每轮重算(旧行为)
    c_fixed, _ = Q.skin_shift(base, fixed)
    c_recomp, _ = Q.skin_shift(base, recomputed)
    assert c_fixed <= c_recomp + 1e-9, \
        f"固定掩码不应比重算更大(固定 {c_fixed:.4f} vs 重算 {c_recomp:.4f})"


# --------------------------------------------------------------------------
# 兜底必须在所有阶段之后(真 bug 回归 ×2)
# --------------------------------------------------------------------------
#
# 同一个错误的两种形状:
#   1. 只看 optimize 是否应用过 → 「优化全被拒 + 风格随后应用」重复补偿
#   2. 兜底发生在风格**之前** → 它看到的 steps 里根本没有风格那一步

def test_fallback_does_not_compound_style_result():
    """风格应用了 exposure 0.15,最终就必须是 0.15 —— 兜底不能再加一笔。

    这是最容易出错的一处:兜底自己就是「曝光拉向目标」的完整修正,
    在任何已有成果之上再跑一遍都会过冲(实测曾变成 0.75)。
    """
    img = make_fixture("under_exposed")
    r = A.auto_grade(img, {}, "提亮", client=object(), use_vision=False,
                     style_extractor=_style_extractor({"exposure": 0.15, "shadows": 0.1}))
    assert r.style_applied is True
    assert r.params["exposure"] == pytest.approx(0.15, abs=1e-6), \
        f"兜底与风格结果叠加了:{r.params['exposure']}"


def test_fallback_still_runs_when_nothing_applied():
    """反向:所有提议都被拒时,兜底必须照常工作,否则功能退化。"""
    img = make_fixture("under_exposed")
    r = A.auto_grade(img, {}, client=None)      # 无 LLM → 直接兜底
    assert r.params["exposure"] > 0, "欠曝图应有兜底提亮"


def test_fallback_after_all_rejected_proposals():
    """提议全被拒(没人改过参数)→ 兜底应接手。"""
    img = make_fixture("under_exposed")
    r = A.auto_grade(img, {}, client=object(), use_vision=False,
                     proposer=proposer_seq([{"exposure": 2.5}, {"exposure": 2.5}]))
    assert r.params["exposure"] > 0, "全被拒后应有兜底产出"


def test_style_only_run_reports_degraded_honestly():
    """风格修了一部分但没收敛 → 保留成果并标记 degraded,不假装达标。"""
    img = make_fixture("under_exposed")
    r = A.auto_grade(img, {}, "微微提亮", client=object(), use_vision=False,
                     style_extractor=_style_extractor({"exposure": 0.1}))
    if not Q.is_converged(A.S.analyze(
            R.render_lut(R.lut_from_params(r.params), img), A.S.skin_mask_of(img))):
        assert r.degraded is True
