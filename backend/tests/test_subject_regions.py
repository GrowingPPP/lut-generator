"""皮肤区域固定在归一化原图上，暖色背景不进入人物保护。"""
import numpy as np
import pytest

from photo.subjects import subject_skin_mask
from photo.stats import analyze, downsample


def analysis(regions, **overrides):
    return {"version": "subject-regions-1", "status": "resolved", "source": "auto",
            "subject_mode": "portrait", "confidence": 0.95,
            "regions": regions, "mask_mode": "skin_candidates", **overrides}


def region(bounds=(0.0, 0.0, 0.5, 1.0), **overrides):
    return {"bounds": list(bounds), "kind": "face", "confidence": 0.95, **overrides}


def test_warm_background_outside_detected_face_is_not_protected():
    image = np.full((20, 40, 3), [0.65, 0.45, 0.32], dtype=np.float32)
    mask = subject_skin_mask(image, analysis([region()])).reshape(20, 40)
    assert mask[:, :20].all()
    assert not mask[:, 20:].any()
    assert analyze(image, skin_mask=mask.ravel()).skin_ratio == 0.5


@pytest.mark.parametrize("overrides", [
    {"subject_mode": "non_portrait"}, {"subject_mode": "unknown"},
    {"status": "uncertain"}, {"status": "failed"}, {"status": "disabled"},
    {"confidence": 0.5}, {"source": "untrusted"},
])
def test_unconfirmed_or_failed_detection_never_falls_back_to_whole_image(overrides):
    image = np.full((20, 40, 3), [0.65, 0.45, 0.32], dtype=np.float32)
    assert not subject_skin_mask(image, analysis([region()], **overrides)).any()


@pytest.mark.parametrize("regions", [[], [region(confidence=0.4)],
    [region(bounds=[-0.2, 0.0, 0.5, 1.0])],
    [region(bounds=[0.8, 0.0, 0.5, 1.0])],
    [region(bounds=[0.0, 0.0, float("nan"), 1.0])],
    [region(bounds=[True, 0.0, 0.5, 1.0])],
    [region(kind="tree")], [region()] * 17,
    [{"bounds": [0.0, 0.0, 0.5, 1.0], "kind": "face"}],
])
def test_empty_low_confidence_or_invalid_regions_disable_protection(regions):
    image = np.full((20, 40, 3), [0.65, 0.45, 0.32], dtype=np.float32)
    assert not subject_skin_mask(image, analysis(regions)).any()


def test_manual_exact_region_can_include_skin_outside_color_heuristic():
    image = np.full((20, 40, 3), [0.08, 0.06, 0.04], dtype=np.float32)
    assert not subject_skin_mask(image, analysis([region()], source="manual")).any()
    mask = subject_skin_mask(image, analysis([region()], source="manual",
                                              mask_mode="all_pixels")).reshape(20, 40)
    assert mask[:, :20].all()
    assert not mask[:, 20:].any()


def test_automatic_detection_cannot_enable_all_pixels_mode():
    image = np.full((20, 40, 3), [0.08, 0.06, 0.04], dtype=np.float32)
    assert not subject_skin_mask(image, analysis([region()], mask_mode="all_pixels")).any()


def test_normalized_coordinates_and_shape_match_stats_for_large_image():
    image = np.full((1200, 800, 3), [0.65, 0.45, 0.32], dtype=np.float32)
    mask = subject_skin_mask(image, analysis([region([0.0, 0.0, 0.5, 1.0])]))
    small = downsample(image)
    assert mask.shape == (small.shape[0] * small.shape[1],)
    assert 0.49 < analyze(image, mask).skin_ratio < 0.51


def test_fixed_skin_pixels_survive_color_changes_in_later_candidates():
    image = np.full((20, 40, 3), [0.65, 0.45, 0.32], dtype=np.float32)
    mask = subject_skin_mask(image, analysis([region()]))
    cool = np.full_like(image, [0.2, 0.3, 0.7])
    measured = analyze(cool, mask)
    assert measured.skin_ratio == 0.5
    assert measured.skin_mean_rgb is not None
    np.testing.assert_allclose(measured.skin_mean_rgb, [0.2, 0.3, 0.7], atol=1e-5)
