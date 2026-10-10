"""LLM 输出的结构化结果。intent 区分「确认生成」与「描述/调整风格」。

工具 schema 由 ExtractResult 生成,不手写第二份 JSON Schema —— 模型看到的入参约束
与这里的 pydantic 校验共用一份定义,加字段时不会漏改一边。
"""
from typing import Annotated, Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

RGBOffsetValue = Annotated[float, Field(ge=-0.1, le=0.1)]
RGBScaleValue = Annotated[float, Field(ge=0.5, le=1.5)]
RGBScaleDelta = Annotated[float, Field(ge=-0.5, le=0.5)]

# 风格参数字段,任一非空即认为用户表达了风格诉求
STYLE_FIELDS = (
    "base_photo_style", "tone_map", "look_strength",
    "temp", "tint", "exposure", "contrast", "contrast_pivot", "saturation",
    "hue", "vibrance", "lift", "gamma", "gain",
    # 影调分区与分离色调(逐点,可烘进 33³ LUT)
    "highlights", "shadows", "whites", "blacks", "curve",
    "split_shadow_hue", "split_shadow_sat",
    "split_highlight_hue", "split_highlight_sat", "split_balance",
    "split_mid_hue", "split_mid_sat",
    "selective_hue_center", "selective_hue_width",
    "selective_hue_shift", "selective_saturation",
)
MANUAL_EFFECT_FIELDS = ("curve_points", "external_lut_id", "external_lut_strength", "external_lut_mode")
AVAILABLE_FIELDS = STYLE_FIELDS + MANUAL_EFFECT_FIELDS

TOOL_NAME = "submit_lut_params"
CORRECTION_TOOL_NAME = "propose_correction"

TOOL_DESCRIPTION = (
    "提交从用户消息中解析出的意图与调色参数。"
    "intent=confirm 表示用户确认/同意生成;intent=describe 表示用户在描述或调整风格。"
    "调色参数必须是调整后的绝对目标值,不是增量;只能使用 schema 中已有字段。"
    "未提及的参数一律留空(不要填默认值)。"
)


class ExtractResult(BaseModel):
    # strict=True 仅控制本地类型校验,不启用工具服务端的 strict 模式。
    # extra="forbid":模型编造字段时直接判为非法(返回空 dict → 走 clarify 让用户重发),
    # 而不是被静默丢掉。同时让生成的 schema 带上 additionalProperties: false。
    #
    # 注意:不要改用 strict=true 服务端强校验 —— 官方要求 strict 模式下「所有属性都必须
    # 列为 required」,而本项目刻意让未提及的字段可省略(避免默认值污染),两者结构性冲突。
    # 实测 /beta + strict 会报 "Required properties must match all properties in the object"。
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    intent: Literal["confirm", "describe"] = Field(
        ..., description="用户意图:confirm=确认生成或同意;describe=描述或调整风格"
    )
    base_photo_style: Optional[Literal["STD", "NAT", "VIVD", "VLOG"]] = Field(
        None, description="基准照片风格,只能是 STD、NAT、VIVD、VLOG 之一,未提及则留空"
    )
    temp: Optional[float] = Field(
        None, ge=-3000, le=3000, description="冷暖相对偏移,范围 -3000 到 3000,正数偏暖；以 6500K 为参考的 RGB 增益,不是拍摄光源色温"
    )
    tint: Optional[float] = Field(
        None, ge=-500, le=500, description="色调偏移,范围 -500 到 500,正数偏绿、负数偏洋红"
    )
    exposure: Optional[float] = Field(
        None, ge=-3, le=3, description="曝光,单位 EV,范围 -3 到 3,正数提亮"
    )
    contrast: Optional[float] = Field(
        None, ge=-1, le=1, description="对比度,范围 -1 到 1,如 -0.15 表示轻微降低对比"
    )
    contrast_pivot: Optional[float] = Field(
        None, ge=0.1, le=0.9, description="对比中心,编码域灰阶值 0.1 到 0.9,默认 0.462"
    )
    saturation: Optional[float] = Field(
        None, ge=-1, le=1, description="饱和度,范围 -1 到 1,如 -0.1 表示轻微降低饱和"
    )
    hue: Optional[float] = Field(
        None, ge=-180, le=180, description="色相旋转,单位度,范围 -180 到 180"
    )
    vibrance: Optional[float] = Field(
        None, ge=-1, le=1, description="自然饱和度,范围 -1 到 1"
    )
    tone_map: Optional[float] = Field(
        None, ge=0, le=1, description="V-Log 显示映射强度,0 到 1,默认 1,会影响中间调及高光"
    )
    look_strength: Optional[float] = Field(
        None, ge=0, le=1, description="创意风格强度,0 到 1。0 保留输入转换、曝光和白平衡校正"
    )
    highlights: Optional[float] = Field(
        None, ge=-1, le=1, description="高光,-1 到 1,负数压高光,正数提亮部；无法恢复已剪切的细节"
    )
    shadows: Optional[float] = Field(
        None, ge=-1, le=1, description="阴影,-1 到 1,正数提阴影,负数压暗部。如「暗部提一点」约 +0.3"
    )
    whites: Optional[float] = Field(
        None, ge=-1, le=1, description="白部层次,-1 到 1,正数增强亮部,负数降低白点"
    )
    blacks: Optional[float] = Field(
        None, ge=-1, le=1, description="黑部层次,-1 到 1,正数抬黑位,负数压暗部"
    )
    curve: Optional[float] = Field(
        None, ge=-1, le=1, description="S 曲线强度,-1 到 1,正数增强层次,负数减弱"
    )
    split_shadow_hue: Optional[float] = Field(
        None, ge=0, le=360, description="阴影染色色相,0 到 360 度。0=红 60=黄 120=绿 180=青 240=蓝 300=洋红"
    )
    split_shadow_sat: Optional[float] = Field(
        None, ge=0, le=1, description="阴影染色强度,0 到 1。电影感常用青蓝阴影,约 0.3"
    )
    split_highlight_hue: Optional[float] = Field(
        None, ge=0, le=360, description="高光染色色相,0 到 360 度,含义同阴影色相"
    )
    split_highlight_sat: Optional[float] = Field(
        None, ge=0, le=1, description="高光染色强度,0 到 1。电影感常用暖橙高光,约 0.25"
    )
    split_balance: Optional[float] = Field(
        None, ge=0, le=1, description="阴影/高光染色的分界,0 到 1,默认 0.5,越大高光染色范围越广"
    )
    split_mid_hue: Optional[float] = Field(
        None, ge=0, le=360, description="中间调染色色相,0 到 360 度"
    )
    split_mid_sat: Optional[float] = Field(
        None, ge=0, le=1, description="中间调染色强度,0 到 1"
    )
    selective_hue_center: Optional[float] = Field(
        None, ge=0, le=360, description="局部色彩的目标色相中心,0 到 360 度"
    )
    selective_hue_width: Optional[float] = Field(
        None, ge=1, le=180, description="局部色彩的色相作用半径,1 到 180 度"
    )
    selective_hue_shift: Optional[float] = Field(
        None, ge=-180, le=180, description="目标色相旋转,-180 到 180 度"
    )
    selective_saturation: Optional[float] = Field(
        None, ge=-1, le=1, description="目标色饱和度,-1 到 1"
    )
    lift: Optional[List[RGBOffsetValue]] = Field(
        None, min_length=3, max_length=3, description="线性域 RGB 偏移,影响全部亮度,三个 -0.1 到 0.1 之间的小数"
    )
    gamma: Optional[List[RGBScaleValue]] = Field(
        None, min_length=3, max_length=3, description="中间调 RGB 幂参数,每通道 0.5 到 1.5,中性值 1;增大提亮、减小压暗,如 [0.9, 1.0, 1.0]"
    )
    gain: Optional[List[RGBScaleValue]] = Field(
        None, min_length=3, max_length=3, description="线性域 RGB 增益,影响全部亮度,三个 0.5 到 1.5 之间的小数"
    )


def build_tool_schema() -> Dict[str, Any]:
    """把 ExtractResult 转成 OpenAI 风格的 function tool 定义。

    只做两件事:内联 $defs 引用、去掉纯装饰性元数据(title/default)。
    其余键一律保留 —— 约束信息宁可多带,也不能被静默丢掉。
    这样模型可见的入参约束与 ExtractResult.model_validate 永远一致。
    """
    schema = _inline_refs(ExtractResult.model_json_schema())
    return {
        "type": "function",
        "function": {
            "name": TOOL_NAME,
            "description": TOOL_DESCRIPTION,
            "parameters": schema,
        },
    }


# 纯装饰性元数据,不属于约束;去掉可减小请求体,不影响校验语义
_DROP_KEYS = {"$defs", "$ref", "title", "default"}


def _inline_refs(node: Any) -> Any:
    defs = node.get("$defs", {}) if isinstance(node, dict) else {}
    return _resolve(node, defs, depth=0)


def _resolve(node: Any, defs: Dict[str, Any], depth: int) -> Any:
    if depth > 12:  # 防御:正常 schema 不会这么深
        return {}
    if isinstance(node, list):
        return [_resolve(x, defs, depth + 1) for x in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        name = str(node["$ref"]).rsplit("/", 1)[-1]
        target = defs.get(name)
        merged = {k: v for k, v in node.items() if k != "$ref"}
        if target is not None:
            merged = {**_resolve(target, defs, depth + 1), **merged}
        return merged
    return {
        key: _resolve(value, defs, depth + 1)
        for key, value in node.items()
        if key not in _DROP_KEYS
    }


class CorrectionProposal(BaseModel):
    """优化阶段的**增量**提议。

    范围取比 LutParams 更窄的「单轮合理区间」:单轮激进改动会被硬校验(规则 R5)拒绝,
    与其让模型白跑一轮,不如在 schema 里就收窄。

    刻意**不含 base_photo_style** —— 它决定 LUT 的输入侧(照片线走 sRGB、V-Log 走视频线),
    换它等于换整条变换链路;而且模型无法从像素可靠推断用户拍摄时用了哪个照片风格,
    猜错会让整张图颜色系统性偏掉。所以它是只读透传。
    """

    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    diagnosis: str = Field(..., description="一句话诊断:这张照片的主要问题")
    exposure: Optional[float] = Field(None, ge=-1, le=1, description="曝光增量,EV,正数提亮")
    contrast: Optional[float] = Field(None, ge=-0.5, le=0.5, description="对比度增量")
    temp: Optional[float] = Field(None, ge=-800, le=800, description="冷暖相对偏移增量,正数偏暖;以 6500K 为参考的 RGB 增益,不是拍摄光源色温")
    tint: Optional[float] = Field(None, ge=-200, le=200, description="绿/洋红偏移增量,正数偏绿、负数偏洋红")
    saturation: Optional[float] = Field(None, ge=-0.5, le=0.5, description="饱和度增量")
    vibrance: Optional[float] = Field(None, ge=-0.5, le=0.5, description="自然饱和度增量")
    highlights: Optional[float] = Field(None, ge=-1, le=1, description="高光增量,负=压高光,无法恢复已剪切细节")
    shadows: Optional[float] = Field(None, ge=-1, le=1, description="阴影增量,正=提亮暗部")
    whites: Optional[float] = Field(None, ge=-0.5, le=0.5, description="白部层次增量,正数增强亮部、负数降低白点")
    blacks: Optional[float] = Field(None, ge=-0.5, le=0.5, description="黑部层次增量,正数抬黑位、负数压暗部;无法恢复已剪切的暗部细节")
    curve: Optional[float] = Field(None, ge=-0.5, le=0.5, description="S 曲线增量,正=增强层次")
    lift: Optional[List[RGBOffsetValue]] = Field(
        None, min_length=3, max_length=3,
        description="线性域全局 RGB 偏移的逐通道增量,影响全部亮度、暗部更明显;每通道 -0.1 到 0.1,中性增量为 0"
    )
    gamma: Optional[List[RGBScaleDelta]] = Field(
        None, min_length=3, max_length=3,
        description="中间调 RGB 幂参数的逐通道增量,正数提亮、负数压暗;每通道 -0.5 到 0.5,中性增量为 0,不是中性绝对值 1"
    )
    gain: Optional[List[RGBScaleDelta]] = Field(
        None, min_length=3, max_length=3,
        description="线性域全局 RGB 增益的逐通道增量,影响全部亮度、亮部更明显;每通道 -0.5 到 0.5,中性增量为 0,不是中性绝对值 1"
    )

    def deltas(self) -> Dict[str, Any]:
        """只返回真正被设置的字段(不含 diagnosis)。"""
        data = self.model_dump(exclude_none=True)
        data.pop("diagnosis", None)
        return data


CORRECTION_TOOL_DESCRIPTION = (
    "提交针对这张照片的调色**增量**修正(不是绝对值)。"
    "只对你判断有问题的地方给出增量;判断没问题的参数一律留空。"
    "增量幅度要克制:单轮曝光不超过 ±1 EV,其余参数小幅调整即可。"
)


def build_correction_tool() -> Dict[str, Any]:
    """把 CorrectionProposal 转成 function tool 定义(与 build_tool_schema 同一套转换)。"""
    schema = _inline_refs(CorrectionProposal.model_json_schema())
    return {
        "type": "function",
        "function": {
            "name": CORRECTION_TOOL_NAME,
            "description": CORRECTION_TOOL_DESCRIPTION,
            "parameters": schema,
        },
    }
