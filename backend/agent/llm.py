"""可插拔 LLM 抽象。默认接 DeepSeek 官方 API,key 从环境变量或项目根 .apikey 读取。"""
import os
from pathlib import Path

from langchain_openai import ChatOpenAI

from .schemas import ExtractResult

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def _load_api_key():
    """优先级:CHROMA_LLM_API_KEY > 项目根 .apikey > OPENAI_API_KEY。"""
    key = os.environ.get("CHROMA_LLM_API_KEY")
    if key:
        return key
    apikey_file = _PROJECT_ROOT / ".apikey"
    if apikey_file.exists():
        content = apikey_file.read_text().strip()
        if content:
            return content
    return os.environ.get("OPENAI_API_KEY")


def get_llm():
    """构建 LLM。默认 DeepSeek 官方 API,可用环境变量覆盖:

      CHROMA_LLM_MODEL      模型名(默认 deepseek-chat)
      CHROMA_LLM_API_KEY    API key(缺省读 .apikey / OPENAI_API_KEY)
      CHROMA_LLM_BASE_URL   base_url(默认 https://api.deepseek.com)
    """
    model = os.environ.get("CHROMA_LLM_MODEL", DEFAULT_MODEL)
    api_key = _load_api_key()
    base_url = os.environ.get("CHROMA_LLM_BASE_URL", DEFAULT_BASE_URL)
    return ChatOpenAI(model=model, api_key=api_key, base_url=base_url)


def extract_result(llm, message: str, params: dict | None = None, history: list | None = None) -> dict:
    """分析用户消息:判断意图 + 提取调色参数。返回非空字段的 dict(含 intent)。

    params 为当前参数(供相对调整参考),history 为最近几轮对话。
    """
    structured = llm.with_structured_output(ExtractResult, method="function_calling")
    parts = [
        "你是 LUT 生成助手。分析用户消息:\n"
        "1. 判断意图:若用户是在确认/同意生成(如「确认」「可以」「就这样」「生成吧」「好」「行」),"
        "intent=confirm;否则用户在描述或调整风格,intent=describe。\n"
        "2. 若 intent=describe,提取用户提到的调色参数;用户未提及的参数留空。"
        "若用户用相对描述(如「再暖一点」「更暗」),基于当前参数在合理幅度内调整,"
        "不要覆盖用户未提及的其他参数。"
    ]
    if params:
        parts.append(f"\n当前参数:{params}")
    if history:
        parts.append(f"\n对话历史:{history}")
    parts.append("\n只输出结构化结果,不要解释。\n" f"用户消息:{message}")
    prompt = "".join(parts)
    result = structured.invoke(prompt)
    return result.model_dump(exclude_none=True)
