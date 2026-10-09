"""可插拔 LLM 抽象。模型/URL/key 从环境变量或项目根 .env 读取,详见 .env.example。

参数提取走 tool calling(而不是「要求模型输出 JSON 再正则解析」):工具入参由服务端按
JSON Schema 约束,模型返回的是结构化 tool_call,不需要从自由文本里抠 JSON。schema 直接
由 agent.schemas.ExtractResult 生成,模型可见的约束与 pydantic 校验共用一份定义,不会漂移。
"""
import json
import os
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
from pydantic import ValidationError

from .schemas import TOOL_NAME, ExtractResult, build_tool_schema

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-flash"

# 预算说明:DeepSeek 的 thinking mode **默认开启**(reasoning_effort 默认 high),
# 思考阶段与最终输出共享 max_tokens;两个模型都会返回 reasoning_content,且
# usage.completion_tokens_details.reasoning_tokens 能占满整个预算 —— 给太小会拿到
# 空 content + finish_reason='length'。
#
# 实测(deepseek-flash,本项目的抽取 prompt,max_tokens=2000):
#   简单描述    completion≈130 / reasoning≈70   / 1.5s
#   多参数描述  completion≈280 / reasoning≈165  / 1.6s
#   长段口语    completion≈420 / reasoning≈260  / 2.3s
# 抽取任务思考开销很小,2000 余量充足(需要复杂推理的问题才会吃光预算)。
# 关掉思考可省约一半延迟与 token:extra_body={"thinking": {"type": "disabled"}},
# 本项目不默认关闭,以保留抽取质量。
DEFAULT_MAX_TOKENS = 2000

# 超时与重试:必须显式设置。openai SDK 默认 read timeout 是 **600 秒**、
# max_retries=2,最坏情况一次抽取会阻塞约 30 分钟(官方文档也把 30 分钟列为
# 非流式请求的响应时间上限)——对用户界面里的请求是不可接受的。
# 实测本项目抽取耗时 1~2.3s,30s 余量充足。
# 重试只给 1 次:避免「超时 × 重试」相乘后把请求拖得更久。
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_MAX_RETRIES = 1

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

load_dotenv(_PROJECT_ROOT / ".env")


def _load_api_key():
    """优先级:CHROMA_LLM_API_KEY(环境变量/.env) > OPENAI_API_KEY。"""
    key = os.environ.get("CHROMA_LLM_API_KEY")
    if key:
        return key
    return os.environ.get("OPENAI_API_KEY")


def _timeout_seconds() -> float:
    raw = os.environ.get("CHROMA_LLM_TIMEOUT", "").strip()
    if not raw:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_TIMEOUT_SECONDS


def get_llm() -> OpenAI:
    """构建 LLM 客户端。模型/URL/key 从环境变量或项目根 .env 读取:

      CHROMA_LLM_MODEL      模型名(默认 deepseek-flash)
      CHROMA_LLM_API_KEY    API key(缺省读 OPENAI_API_KEY)
      CHROMA_LLM_BASE_URL   base_url(默认 https://api.deepseek.com)
      CHROMA_LLM_MAX_TOKENS 单次最大 token(默认 2000)
      CHROMA_LLM_TIMEOUT    单次请求超时秒数(默认 30)
    """
    return OpenAI(
        api_key=_load_api_key(),
        base_url=os.environ.get("CHROMA_LLM_BASE_URL", DEFAULT_BASE_URL),
        timeout=_timeout_seconds(),
        max_retries=DEFAULT_MAX_RETRIES,
    )


def _model_name() -> str:
    return os.environ.get("CHROMA_LLM_MODEL", DEFAULT_MODEL)


def _max_tokens() -> int:
    raw = os.environ.get("CHROMA_LLM_MAX_TOKENS", "").strip()
    if not raw:
        return DEFAULT_MAX_TOKENS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_TOKENS
    return value if value > 0 else DEFAULT_MAX_TOKENS


# ---- prompts ----

SYSTEM_PROMPT = (
    "你是 LUT 生成助手,负责把用户的自然语言翻译成调色参数。\n"
    "规则:\n"
    "1. 用户确认/同意生成(如「确认」「可以」「就这样」「生成吧」「好」「行」)时 "
    'intent=confirm;否则用户在描述或调整风格,intent=describe。\n'
    "2. intent=describe 时只提取用户提到的调色参数,返回调整后的绝对目标值,不是增量;"
    "未提及的字段一律不要填。\n"
    "3. 相对描述(如「再暖一点」「更暗」)基于当前参数在合理幅度内调整,"
    "不要覆盖未提及的参数。\n"
    "4. lift/gamma/gain 必须是三个数字组成的数组。\n"
    "5. 只能使用 submit_lut_params 的 schema 中已有字段及合法范围;"
    "不要输出 LUT 不支持的调整,例如清晰度、降噪、锐化、颗粒、暗角或空间局部蒙版。\n"
    "6. 只通过 submit_lut_params 工具返回结果,不要输出解释文字。"
)


class BudgetExhaustedError(RuntimeError):
    """thinking 阶段耗尽 max_tokens,模型没来得及产出 tool_call。"""


def _user_prompt(message: str, params: dict | None, history: list | None) -> str:
    parts = []
    if params:
        parts.append(f"当前参数:{params}")
    if history:
        parts.append(f"对话历史:{history}")
    parts.append(f"用户消息:{message}")
    return "\n".join(parts)


def extract_result(
    client: OpenAI,
    message: str,
    params: dict | None = None,
    history: list | None = None,
) -> dict:
    """分析用户消息:判断意图 + 提取调色参数。返回非空字段的 dict(含 intent)。

    返回空 dict 表示本次没能拿到有效结果(模型未调用工具,或工具入参校验失败),
    由调用方按「无参数」处理 —— 注意这会走 clarify 分支,用户需重发一次。

    params 为当前参数,history 为最近几轮对话。
    """
    resp = client.chat.completions.create(
        model=_model_name(),
        max_tokens=_max_tokens(),
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": _user_prompt(message, params, history)},
        ],
        # 注意:不要传 tool_choice。服务端对 "required"/指定函数一律 400:
        #   "Thinking mode does not support this tool_choice"
        # 这句文案与具体模型无关(两个模型都这么报),是路由层写死的;
        # "auto" 或省略都可以。是否调用工具由模型自行决定(单一工具 + 明确描述,实测稳定调用)。
        tools=[build_tool_schema()],
    )
    choice = resp.choices[0] if resp.choices else None
    if choice is None:
        # 正常不会发生;服务端行为异常时不要让它变成 IndexError 冒到 API 层
        return {}
    tool_calls = getattr(choice.message, "tool_calls", None)
    if not tool_calls:
        # 预算被 thinking 吃光时 content 为空且 finish_reason='length',这里显式暴露出来,
        # 避免和「用户确实没提参数」混为一谈而静默降级。
        finish = getattr(choice, "finish_reason", None)
        if finish == "length":
            raise BudgetExhaustedError(
                "模型在思考阶段用尽 token 预算,未能返回结果。"
                f"请调大 CHROMA_LLM_MAX_TOKENS(当前 {_max_tokens()})后重试。"
            )
        return {}

    try:
        if tool_calls[0].function.name != TOOL_NAME:
            return {}
        raw = json.loads(tool_calls[0].function.arguments)
    except (json.JSONDecodeError, TypeError, AttributeError, IndexError):
        return {}
    if not isinstance(raw, dict):
        return {}
    try:
        return ExtractResult.model_validate(raw).model_dump(exclude_none=True)
    except ValidationError:
        return {}
