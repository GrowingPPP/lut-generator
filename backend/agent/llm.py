"""可插拔 LLM 抽象。模型/URL/key 从环境变量或项目根 .env 读取,详见 .env.example。"""
import json
import os
import re
from pathlib import Path

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from pydantic import ValidationError

from .schemas import ExtractResult

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-pro"

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

load_dotenv(_PROJECT_ROOT / ".env")


def _load_api_key():
    """优先级:CHROMA_LLM_API_KEY(环境变量/.env) > OPENAI_API_KEY。"""
    key = os.environ.get("CHROMA_LLM_API_KEY")
    if key:
        return key
    return os.environ.get("OPENAI_API_KEY")


def get_llm():
    """构建 LLM。模型/URL/key 从环境变量或项目根 .env 读取:

      CHROMA_LLM_MODEL      模型名(默认 deepseek-v4-pro)
      CHROMA_LLM_API_KEY    API key(缺省读 OPENAI_API_KEY)
      CHROMA_LLM_BASE_URL   base_url(默认 https://api.deepseek.com)
    """
    model = os.environ.get("CHROMA_LLM_MODEL", DEFAULT_MODEL)
    api_key = _load_api_key()
    base_url = os.environ.get("CHROMA_LLM_BASE_URL", DEFAULT_BASE_URL)
    return ChatOpenAI(model=model, api_key=api_key, base_url=base_url)


def _parse_json(text: str) -> dict:
    """从 LLM 输出中提取首个 JSON 对象,容忍 markdown 代码块与前后文字。"""
    if not text:
        return {}
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end <= start:
            return {}
        text = text[start : end + 1]
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def extract_result(llm, message: str, params: dict | None = None, history: list | None = None) -> dict:
    """分析用户消息:判断意图 + 提取调色参数。返回非空字段的 dict(含 intent)。

    deepseek-v4-pro 为 thinking 模型,不支持 function_calling,故用 JSON 输出 + 手动解析,
    再用 ExtractResult 校验。params 为当前参数,history 为最近几轮对话。
    """
    parts = [
        "你是 LUT 生成助手。分析用户消息,只输出一个 JSON 对象。\n"
        "参数说明(数值字段必须落在下列范围):\n"
        '- intent: "confirm"(确认/同意生成) 或 "describe"(描述/调整风格)\n'
        "- base_photo_style: 基准照片风格,仅 STD/NAT/VIVD/VLOG\n"
        "- temp: 色温偏移(Kelvin),-3000 到 3000,正数偏暖。如「暖一点」约 +300 到 +500\n"
        "- tint: 色调偏移,-500 到 500,正数偏绿、负数偏洋红\n"
        "- exposure: 曝光(EV),-3 到 3,正数提亮\n"
        "- contrast: 对比度,-1 到 1,如「对比低一点」约 -0.15\n"
        "- saturation: 饱和度,-1 到 1,如「饱和低一点」约 -0.1\n"
        "- hue: 色相旋转(度),-180 到 180\n"
        "- vibrance: 自然饱和,-1 到 1\n"
        "- tone_map: V-Log 高光映射强度,0 到 1\n"
        "- lift: 暗部 RGB 偏移,三个 -0.1 到 0.1 的小数\n"
        "- gamma: 中间调 RGB 幂,三个 0.5 到 1.5 的小数\n"
        "- gain: 亮部 RGB 增益,三个 0.5 到 1.5 的小数\n"
        "规则:\n"
        "1. 用户确认/同意生成(如「确认」「可以」「就这样」「生成吧」「好」「行」)时 "
        'intent=confirm;否则用户在描述或调整风格,intent=describe。\n'
        "2. intent=describe 时提取用户提到的调色参数;未提及的字段不要输出。\n"
        "3. 相对描述(如「再暖一点」「更暗」)基于当前参数在合理幅度内调整,"
        "不要覆盖未提及的参数。\n"
        "4. lift/gamma/gain 必须是三个数字组成的数组。"
    ]
    if params:
        parts.append(f"\n当前参数:{params}")
    if history:
        parts.append(f"\n对话历史:{history}")
    parts.append("\n只输出 JSON 对象,不要解释。\n用户消息:" + message)
    prompt = "".join(parts)

    resp = llm.invoke(prompt)
    text = resp.content if isinstance(resp.content, str) else str(resp.content)
    data = _parse_json(text)
    try:
        return ExtractResult.model_validate(data).model_dump(exclude_none=True)
    except ValidationError:
        return {"intent": "describe"}
