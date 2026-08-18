"""生成前后端引擎数学一致性对比的 golden 数据,输出到项目根 golden.json。

用法:cd backend && ../.venv/bin/python scripts/gen_golden.py
"""
import json
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lut_engine import LutParams, generate_lut

SIZE = 33
SAMPLE_IDX = [0, 8, 16, 24, 32]
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

# 覆盖照片线(sRGB)、视频线(V-Log)、tone_map 变化、色相色域、全算子
CASES = [
    {"name": "identity", "params": {}},
    {"name": "warm", "params": {"temp": 500.0, "tint": 100.0}},
    {"name": "contrast_sat", "params": {"contrast": 0.3, "saturation": 0.4}},
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
]


def main():
    cases_out = []
    for case in CASES:
        engine = LutParams(**case["params"])
        lut = generate_lut(engine, size=SIZE)
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
        })

    golden = {"size": SIZE, "cases": cases_out}
    out_path = PROJECT_ROOT / "golden.json"
    out_path.write_text(json.dumps(golden, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {out_path} ({len(cases_out)} cases)")


if __name__ == "__main__":
    main()
