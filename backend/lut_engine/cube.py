""".cube 文件序列化。"""
import numpy as np

# 松下基准 Photo Style 标签
PHOTO_STYLE_TAGS = {
    "STD": "STD",
    "NAT": "NAT",
    "VIVD": "VIVD",
    "VLOG": "VLOG",
}


def lut_to_cube(lut, title=None, photo_style=None):
    """3D LUT 数组 → .cube 文本。

    photo_style 非空时注入松下机内头 #LUMIXPHOTOSTYLE;为 None 输出标准 .cube(后期软件用)。
    """
    size = lut.shape[0]
    lines = []
    if title:
        lines.append(f'TITLE "{title}"')
    if photo_style:
        tag = PHOTO_STYLE_TAGS.get(photo_style)
        if tag:
            lines.append(f"#LUMIXPHOTOSTYLE {tag}")
    lines.append(f"LUT_3D_SIZE {size}")
    # .cube 数据顺序:R 最快,其次 G,最慢 B
    data = lut.transpose(2, 1, 0, 3).reshape(-1, 3)
    for r, g, b in data:
        lines.append(f"{r:.6f} {g:.6f} {b:.6f}")
    return "\n".join(lines) + "\n"
