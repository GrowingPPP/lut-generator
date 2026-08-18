"""LUT 生成会话图:描述 → 确认 → (多轮调整) → 生成。"""
from typing import Callable, TypedDict

from langgraph.graph import StateGraph, START, END

from lut_engine import generate_lut, lut_to_cube, lut_params_from_dict
from .schemas import STYLE_FIELDS


class AgentState(TypedDict, total=False):
    message: str
    params: dict
    route: str
    reply: str
    cube_text: str
    done: bool


def _has_style(params: dict) -> bool:
    return any(k in params for k in STYLE_FIELDS)


def _summarize(params: dict) -> str:
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


def build_graph(extract_fn: Callable[[str], dict]):
    def parse(state: AgentState) -> dict:
        extracted = extract_fn(state.get("message", "")) or {}
        intent = extracted.pop("intent", "describe")
        params = {**state.get("params", {}), **extracted}
        if intent == "confirm":
            route = "generate" if _has_style(params) else "clarify"
        else:
            route = "confirm" if _has_style(params) else "clarify"
        return {"params": params, "route": route}

    def route(state: AgentState) -> str:
        return state["route"]

    def clarify(state: AgentState) -> dict:
        reply = "先说说想要什么效果吧,比如色调(暖/冷)、对比强弱、饱和度、有没有胶片感。"
        return {"reply": reply, "done": False}

    def confirm(state: AgentState) -> dict:
        summary = _summarize(state["params"])
        reply = f"我理解为:{summary}。确认生成吗?回复「确认」,或继续说要调整的地方。"
        return {"reply": reply, "done": False}

    def generate(state: AgentState) -> dict:
        engine = lut_params_from_dict(state["params"])
        base = engine.base_photo_style
        lut = generate_lut(engine, size=33)
        cube_text = lut_to_cube(lut, title="generated", photo_style=base)
        reply = "已生成 LUT,右侧预览可查看,可继续调整或保存。"
        return {"cube_text": cube_text, "reply": reply, "done": True}

    graph = StateGraph(AgentState)
    graph.add_node("parse", parse)
    graph.add_node("clarify", clarify)
    graph.add_node("confirm", confirm)
    graph.add_node("generate", generate)
    graph.add_edge(START, "parse")
    graph.add_conditional_edges(
        "parse", route, {"generate": "generate", "confirm": "confirm", "clarify": "clarify"}
    )
    graph.add_edge("confirm", END)
    graph.add_edge("clarify", END)
    graph.add_edge("generate", END)
    return graph.compile()


def run_agent(extract_fn: Callable[[str], dict], message: str, params: dict | None = None) -> dict:
    graph = build_graph(extract_fn)
    initial: AgentState = {
        "message": message,
        "params": params or {},
        "route": "",
        "reply": "",
        "cube_text": "",
        "done": False,
    }
    return graph.invoke(initial)
