"""LUT 生成会话流程:描述 → 确认 → (多轮调整) → 生成。

原先用 LangGraph 的 StateGraph 表达,但那只是一个 4 节点、3 条出边的分支,
没有持久化/中断/并行/流式等图能力在用;换成显式流程后逻辑更短、调用栈更好读。
节点本身仍是纯函数(dict → dict),所以单独测试和以后需要时再接回图框架都不难。
"""
from typing import Callable, TypedDict

from lut_engine import generate_lut, lut_to_cube, lut_params_from_dict
from .schemas import STYLE_FIELDS

CLARIFY_REPLY = "先说说想要什么效果吧,比如色调(暖/冷)、对比强弱、饱和度、有没有胶片感。"


class AgentState(TypedDict, total=False):
    message: str
    params: dict
    route: str
    reply: str
    cube_text: str
    done: bool


def has_style(params: dict) -> bool:
    """任一风格参数非空,即认为用户表达了风格诉求。"""
    return any(k in params for k in STYLE_FIELDS)


def summarize(params: dict) -> str:
    labels = {
        "base_photo_style": "基准",
        "temp": "色温", "tint": "色调", "exposure": "曝光",
        "contrast": "对比度", "saturation": "饱和度", "hue": "色相",
        "vibrance": "自然饱和", "lift": "暗部", "gamma": "中间调", "gain": "亮部",
    }
    units = {"temp": "K", "exposure": "EV", "hue": "°"}
    parts = []
    for k, v in params.items():
        label = labels.get(k, k)
        if isinstance(v, list):
            parts.append(f"{label} {v}")
        elif isinstance(v, (int, float)):
            unit = units.get(k, "")
            parts.append(f"{label} {v:g}{unit}")
        else:
            parts.append(f"{label} {v}")
    return "、".join(parts)


def route_of(intent: str, params: dict) -> str:
    """决定这次走哪条分支:generate / confirm / clarify。"""
    if intent == "confirm":
        # 还没表达过风格就喊确认 → 反问,否则会生成一个恒等 LUT
        return "generate" if has_style(params) else "clarify"
    return "confirm" if has_style(params) else "clarify"


def clarify_node(state: AgentState) -> dict:
    return {"reply": CLARIFY_REPLY, "done": False}


def confirm_node(state: AgentState) -> dict:
    reply = f"我理解为:{summarize(state['params'])}。确认生成吗?回复「确认」,或继续说要调整的地方。"
    return {"reply": reply, "done": False}


def generate_node(state: AgentState) -> dict:
    engine = lut_params_from_dict(state["params"])
    base = engine.base_photo_style
    lut = generate_lut(engine, size=33)
    cube_text = lut_to_cube(lut, title="generated", photo_style=base)
    reply = "已生成 LUT,右侧预览可查看,可继续调整或保存。"
    return {"cube_text": cube_text, "reply": reply, "done": True}


_NODES: dict[str, Callable[[AgentState], dict]] = {
    "clarify": clarify_node,
    "confirm": confirm_node,
    "generate": generate_node,
}


def run_agent(extract_fn: Callable[[str], dict], message: str, params: dict | None = None) -> dict:
    """跑一轮:提取意图与参数 → 路由 → 执行对应节点。

    extract_fn 负责「消息 → 结构化参数」,由调用方注入(真实 LLM 或测试桩)。
    返回值含 reply / done / params / route / cube_text,与重构前保持一致。
    """
    initial: AgentState = {
        "message": message,
        "params": params or {},
        "route": "",
        "reply": "",
        "cube_text": "",
        "done": False,
    }
    extracted = extract_fn(message) or {}
    intent = extracted.pop("intent", "describe")
    # 本轮提取的参数叠加在已有参数之上,未提及的字段保持不动
    merged = {**initial["params"], **extracted}
    route = route_of(intent, merged)
    state: AgentState = {**initial, "params": merged, "route": route}
    state.update(_NODES[route](state))
    return state
