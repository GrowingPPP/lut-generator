"""严格 SDR 三维 cube 解析、域映射与三线性采样。"""
from dataclasses import dataclass
from math import isfinite
import re
import numpy as np

MAX_CUBE_BYTES = 32 * 1024 * 1024
_NUMBER = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$",re.ASCII)
_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


class CubeError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class ImportedLut:
    size: int
    data: np.ndarray
    domain_min: tuple = (0.0, 0.0, 0.0)
    domain_max: tuple = (1.0, 1.0, 1.0)
    title: str = ""
    input_encoding: str = "sRGB"
    output_encoding: str = "sRGB"

    def __post_init__(self):
        if type(self.size) is not int or not 2 <= self.size <= 65 or not isinstance(self.data,np.ndarray) or self.data.shape != (self.size,self.size,self.size,3):
            raise CubeError("invalid_artifact","外部 LUT 网格格式不正确")
        if not np.isfinite(self.data).all() or np.any(self.data < 0) or np.any(self.data > 1):
            raise CubeError("invalid_artifact","外部 LUT 网格需为 0–1 的有限数字")
        if not isinstance(self.domain_min,(list,tuple)) or not isinstance(self.domain_max,(list,tuple)) or len(self.domain_min)!=3 or len(self.domain_max)!=3 or any(
                isinstance(low,bool) or isinstance(high,bool) or not isinstance(low,(int,float)) or not isinstance(high,(int,float))
                or not isfinite(low) or not isfinite(high) or not 0 <= low < high <= 1
                for low,high in zip(self.domain_min,self.domain_max)):
            raise CubeError("invalid_artifact","外部 LUT DOMAIN 不正确")
        if (self.input_encoding,self.output_encoding) not in {("sRGB","sRGB"),("Rec709","Rec709"),("VLOG","Rec709")}:
            raise CubeError("invalid_artifact","外部 LUT 信号声明不支持")


def validate_external_id(value):
    if value is None:
        return None
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        raise ValueError("外部 LUT 引用必须是账号内的 UUID")
    return value.lower()


def validate_external_options(lut_id, strength, mode):
    lut_id = validate_external_id(lut_id)
    if isinstance(strength, bool) or not isinstance(strength, (int, float)) or not isfinite(strength) or not 0 <= strength <= 1:
        raise ValueError("外部 LUT 强度必须是 0–1 的有限数字")
    if mode not in ("display", "input"):
        raise ValueError("外部 LUT 模式必须为 display 或 input")
    if lut_id is None and (strength != 0 or mode != "display"):
        raise ValueError("没有外部 LUT 时必须使用 display 模式和零强度")
    if mode == "input" and strength != 1:
        raise ValueError("输入转换 LUT 固定强度为 1")
    return lut_id, float(strength), mode


def _numbers(tokens):
    if len(tokens) != 3 or any(not _NUMBER.fullmatch(token) for token in tokens):
        raise CubeError("invalid_number", "cube 的每行需包含三个有限数字")
    result = tuple(float(token) for token in tokens)
    if not all(isfinite(value) for value in result):
        raise CubeError("invalid_number", "cube 不允许 NaN 或 Infinity")
    return result


def parse_cube(content):
    if isinstance(content, bytes):
        if len(content) > MAX_CUBE_BYTES:
            raise CubeError("too_large", "cube 文件需小于 32MB")
        try:
            content = content.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise CubeError("invalid_encoding", "cube 需为 UTF-8 文本") from exc
    if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_CUBE_BYTES:
        raise CubeError("too_large", "cube 文件需小于 32MB")
    seen, table = set(), []
    size, title = None, ""
    low, high = (0., 0., 0.), (1., 1., 1.)
    for raw in re.split(r"\r\n|\r|\n", content.removeprefix("\ufeff")):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        words = line.split()
        keyword = words[0]
        if keyword in ("TITLE", "LUT_3D_SIZE", "DOMAIN_MIN", "DOMAIN_MAX"):
            if table or keyword in seen:
                raise CubeError("invalid_header", "cube 头信息不能重复或出现在数据之后")
            seen.add(keyword)
            if keyword == "TITLE":
                value = line[5:].strip()
                if len(value) < 2 or value[0] != '"' or value[-1] != '"' or re.search(r'["\x00-\x1f]',value[1:-1]) or len(value[1:-1]) > 255:
                    raise CubeError("invalid_title", "TITLE 需为最多 255 字符的引号文本")
                title = value[1:-1]
            elif keyword == "LUT_3D_SIZE":
                if len(words) != 2 or not words[1].isascii() or not words[1].isdigit() or not 2 <= int(words[1]) <= 65:
                    raise CubeError("invalid_size", "仅支持 2–65 点三维 cube")
                size = int(words[1])
            elif keyword == "DOMAIN_MIN":
                low = _numbers(words[1:])
            else:
                high = _numbers(words[1:])
        else:
            if not _NUMBER.fullmatch(keyword):
                raise CubeError("unsupported_format", "仅支持纯三维 cube,不支持 1D、混合、HDR 或其他头格式")
            if size is None:
                raise CubeError("missing_size", "数据之前必须声明 LUT_3D_SIZE")
            values = _numbers(words)
            if any(value < 0 or value > 1 for value in values):
                raise CubeError("unsupported_range", "本轮仅支持输出范围为 0–1 的 SDR LUT")
            table.append(values)
            if len(table) > size ** 3:
                raise CubeError("wrong_row_count", "cube 数据行数超过声明点数")
    if size is None or len(table) != size ** 3:
        raise CubeError("wrong_row_count", "cube 数据行数必须恰好为 N³")
    if any(not 0 <= lo < hi <= 1 for lo, hi in zip(low, high)):
        raise CubeError("unsupported_domain", "SDR DOMAIN 需位于 0–1 且每通道最小值小于最大值")
    data = np.asarray(table, dtype=np.float32).reshape(size, size, size, 3).transpose(2, 1, 0, 3).copy()
    return ImportedLut(size, data, low, high, title)


def sample_imported_lut(lut, rgb):
    if not isinstance(lut, ImportedLut) or lut.data.shape != (lut.size, lut.size, lut.size, 3):
        raise CubeError("invalid_artifact", "外部 LUT 数据格式不正确")
    values = np.clip((np.asarray(rgb)-np.asarray(lut.domain_min)) /
                     (np.asarray(lut.domain_max)-np.asarray(lut.domain_min)), 0.0, 1.0) * (lut.size-1)
    index = np.floor(values).astype(np.int32)
    fraction = values-index
    upper = np.minimum(index+1, lut.size-1)
    out = np.zeros_like(values, dtype=np.float64)
    for dr in (0, 1):
        for dg in (0, 1):
            for db in (0, 1):
                weight = np.prod(np.where([dr,dg,db],fraction,1-fraction), axis=-1)
                pos = np.where([dr,dg,db],upper,index)
                out += lut.data[pos[...,0],pos[...,1],pos[...,2]] * weight[...,None]
    return np.clip(out, 0.0, 1.0)
