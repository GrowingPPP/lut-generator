import numpy as np

from lut_engine.cube import lut_to_cube, PHOTO_STYLE_TAGS


def _make_lut(size=2):
    lut = np.zeros((size, size, size, 3))
    for r in range(size):
        for g in range(size):
            for b in range(size):
                lut[r, g, b] = [r, g, b]
    return lut


def test_header_and_line_count():
    lut = _make_lut(2)
    text = lut_to_cube(lut, title="test", photo_style="STD")
    lines = text.strip().split("\n")
    assert lines[0] == 'TITLE "test"'
    assert "#LUMIXPHOTOSTYLE STD" in lines
    assert "LUT_3D_SIZE 2" in lines
    data = [l for l in lines if not l.startswith(("#", "TITLE", "LUT"))]
    assert len(data) == 8


def test_photo_style_header():
    text = lut_to_cube(_make_lut(), photo_style="STD")
    assert "#LUMIXPHOTOSTYLE STD" in text


def test_no_photo_style_when_none():
    text = lut_to_cube(_make_lut())
    assert "#LUMIXPHOTOSTYLE" not in text


def test_data_order_r_fastest():
    lut = np.zeros((2, 2, 2, 3))
    lut[0, 0, 0] = [0.0, 0.0, 0.0]
    lut[1, 0, 0] = [1.0, 1.0, 1.0]
    text = lut_to_cube(lut)
    lines = text.strip().split("\n")
    data = [l.split() for l in lines if not l.startswith(("#", "TITLE", "LUT"))]
    assert data[0] == ["0.000000", "0.000000", "0.000000"]
    assert data[1] == ["1.000000", "1.000000", "1.000000"]
