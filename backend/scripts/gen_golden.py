"""生成前后端引擎数学一致性对比的 golden 数据,输出到项目根 golden.json。

用法:cd backend && ../.venv/bin/python scripts/gen_golden.py
"""
import json
import sys
from dataclasses import asdict, replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lut_engine import LutParams, generate_lut, identity_curves, parse_cube

SIZE = 33
SAMPLE_IDX = [0, 8, 16, 24, 32]
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
EXTERNAL_ID = "11111111-2222-3333-4444-555555555555"
FREE_CURVES = identity_curves()
FREE_CURVES["master"] = [[0,.02],[.2,.14],[.55,.65],[.8,.93],[1,1]]
FREE_CURVES["r"] = [[0,0],[.3,.38],[.7,.75],[1,1]]
FREE_CURVES["b"] = [[0,0],[.3,.2],[.8,.75],[1,.96]]
EXTERNAL_CUBE = ("LUT_3D_SIZE 2\nDOMAIN_MIN .1 .2 .3\nDOMAIN_MAX .9 .8 .7\n"+
                 "\n".join(f"{.2*r+.8*b} {g} {.7*r+.3*b}" for b in [0,1] for g in [0,1] for r in [0,1])+"\n")

# 覆盖照片线(sRGB)、视频线(V-Log)、tone_map 变化、色相色域、全算子
CASES = [
    {"name": "identity", "params": {}},
    {"name": "warm", "params": {"temp": 500.0, "tint": 100.0}},
    {"name": "contrast_sat", "params": {"contrast": 0.3, "saturation": 0.4}},
    {"name": "contrast_pivot", "params": {"contrast": -0.7, "contrast_pivot": 0.55}},
    {"name": "hue_extreme", "params": {"hue": 90.0}},
    {
        "name": "full_ops",
        "params": {
            "vibrance": 0.3,
            "lift": [0.05, 0.0, -0.03],
            "gamma": [0.9, 1.0, 1.1],
            "gain": [1.05, 1.0, 0.95],
        },
    },
    {"name": "vlog_default", "params": {"base_photo_style": "VLOG"}},
    {"name": "vlog_tone03", "params": {"base_photo_style": "VLOG", "tone_map": 0.3}},
    {"name": "vlog_tone0_exposure", "params": {"base_photo_style": "VLOG", "tone_map": 0.0, "exposure": 0.5}},
    {"name": "vlog_zero_look", "params": {"base_photo_style": "VLOG", "tone_map": 0.7,
                                           "exposure": 0.4, "look_strength": 0.0,
                                           "split_shadow_sat": 0.8}},
    {"name": "half_look", "params": {"look_strength": 0.5, "contrast": 0.25,
                                      "selective_hue_shift": 20, "selective_saturation": 0.3}},
    # ---- 影调分区与分离色调(逐点新算子)----
    {"name": "highlights_shadows", "params": {"highlights": -0.7, "shadows": 0.7}},
    {"name": "whites_blacks", "params": {"whites": 0.15, "blacks": 0.15}},
    {"name": "tone_bounds", "params": {"whites": -1.0, "blacks": 1.0, "contrast": -1.0}},
    {"name": "curve_s", "params": {"curve": 0.6}},
    {"name": "curve_neg", "params": {"curve": -0.5}},
    {"name": "split_tone", "params": {"split_shadow_hue": 220.0, "split_shadow_sat": 0.7,
                                      "split_highlight_hue": 40.0, "split_highlight_sat": 0.6,
                                      "split_balance": 0.45}},
    {"name": "mid_selective", "params": {"split_mid_hue": 28.0, "split_mid_sat": 0.35,
                                          "selective_hue_center": 25.0,
                                          "selective_hue_width": 50.0,
                                          "selective_hue_shift": -18.0,
                                          "selective_saturation": 0.25}},
    {"name": "split_balance_extreme", "params": {"split_shadow_sat": 0.8, "split_highlight_sat": 0.8,
                                                 "split_balance": 0.1}},
    {"name": "tone_full_stack", "params": {"highlights": -0.5, "shadows": 0.6, "whites": 0.1,
                                           "blacks": 0.12, "curve": 0.4, "contrast": 0.2,
                                           "split_shadow_hue": 210.0, "split_shadow_sat": 0.5,
                                           "split_highlight_hue": 35.0, "split_highlight_sat": 0.45}},
    {"name": "tone_extreme", "params": {"highlights": -1.0, "shadows": 1.0, "whites": 0.3,
                                        "blacks": 0.3, "curve": 1.0}},
    {"name": "free_curves", "params": {"curve_points": FREE_CURVES, "contrast": .2, "look_strength": .7}},
    {"name": "external_display_curves", "params": {"curve_points": FREE_CURVES, "external_lut_id": EXTERNAL_ID,
         "external_lut_strength": .63, "saturation": .25}, "artifact_signal": "sRGB"},
    {"name": "external_rec709_display", "params": {"base_photo_style": "VLOG", "external_lut_id": EXTERNAL_ID,
         "external_lut_strength": .8, "tone_map": .4}, "artifact_signal": "Rec709"},
    {"name": "external_input_curves", "params": {"base_photo_style": "VLOG", "curve_points": FREE_CURVES,
         "external_lut_id": EXTERNAL_ID, "external_lut_strength": 1, "external_lut_mode": "input", "exposure": -.3},
         "artifact_signal": "VLOG"},
]


def main():
    cases_out = []
    for case in CASES:
        engine = LutParams(**case["params"])
        artifact = None
        if case.get("artifact_signal"):
            signal = case["artifact_signal"]
            artifact = replace(parse_cube(EXTERNAL_CUBE),input_encoding=signal,output_encoding="Rec709" if signal=="VLOG" else signal)
        lut = generate_lut(engine, size=SIZE, external_lut=artifact)
        samples = []
        for r in SAMPLE_IDX:
            for g in SAMPLE_IDX:
                for b in SAMPLE_IDX:
                    out = lut[r, g, b]
                    samples.append({
                        "idx": [r, g, b],
                        "out": [round(float(out[0]), 9), round(float(out[1]), 9), round(float(out[2]), 9)],
                    })
        # 输出完整参数(补全默认值),lift/gamma/gain 转 list 以对齐 JS 端字段
        params_full = asdict(engine)
        for k in ("lift", "gamma", "gain"):
            params_full[k] = list(params_full[k])
        cases_out.append({
            "name": case["name"],
            "params": params_full,
            "samples": samples,
            **({"artifact": {"id":EXTERNAL_ID,"size":artifact.size,"domain_min":artifact.domain_min,"domain_max":artifact.domain_max,
                             "input_encoding":artifact.input_encoding,"output_encoding":artifact.output_encoding,
                             "data":artifact.data.transpose(2,1,0,3).reshape(-1).tolist()}} if artifact else {}),
        })

    golden = {"size": SIZE, "cases": cases_out}
    out_path = PROJECT_ROOT / "golden.json"
    out_path.write_text(json.dumps(golden, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {out_path} ({len(cases_out)} cases)")


if __name__ == "__main__":
    main()
