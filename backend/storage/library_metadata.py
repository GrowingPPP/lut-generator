"""资产库组织信息的规范化与查询选项。"""
import json

COVERS = ("engine", "amber", "teal", "mono", "dusk")
SORTS = {
    "created_desc": "created_at DESC,id DESC",
    "created_asc": "created_at ASC,id ASC",
    "updated_desc": "updated_at DESC,id DESC",
    "updated_asc": "updated_at ASC,id ASC",
    "name_asc": "name ASC,id ASC",
    "name_desc": "name DESC,id DESC",
}
ORGANIZATION_COLUMNS = {"tags_json", "group_name", "favorite", "cover_id"}
CONTENT_COLUMNS = {"params_json", "kind", "recipe_json", "input_contract_json", "source_json", "workspace_id"}


def normalized_text(value, maximum, *, optional=False):
    if value is None and optional:
        return None
    if not isinstance(value, str):
        raise ValueError("名称必须是文本")
    value = value.strip()
    if not value:
        if optional:
            return None
        raise ValueError("名称不能为空")
    if len(value) > maximum or any(ord(character) < 32 for character in value):
        raise ValueError(f"名称最多 {maximum} 个字符,不能含控制字符")
    return value


def normalize_tags(values):
    if not isinstance(values, list):
        raise ValueError("标签必须是文本数组")
    tags, seen = [], set()
    for value in values:
        tag = normalized_text(value,24)
        key = tag.casefold()
        if key not in seen:
            tags.append(tag)
            seen.add(key)
    if len(tags) > 12:
        raise ValueError("最多 12 个标签")
    return tags


def organization_changes(values):
    result = {}
    if "tags" in values:
        result["tags_json"] = json.dumps(normalize_tags(values["tags"]),ensure_ascii=False)
    if "group" in values:
        result["group_name"] = normalized_text(values["group"],48,optional=True)
    if "favorite" in values:
        if type(values["favorite"]) is not bool:
            raise ValueError("收藏必须是布尔值")
        result["favorite"] = values["favorite"]
    if "cover_id" in values:
        if values["cover_id"] not in COVERS:
            raise ValueError("封面只能使用内置选项")
        result["cover_id"] = values["cover_id"]
    return result


def values_equal(column, left, right):
    if column == "tags_json":
        return json.loads(left or "[]") == json.loads(right or "[]")
    if column.endswith("_json"):
        return json.loads(left) == json.loads(right) if left is not None and right is not None else left == right
    return left == right


def query_parts(*,q=None,kind=None,input_style=None,favorite=None,group=None,sort="created_desc"):
    if sort not in SORTS:
        raise ValueError("排序方式无效")
    filters, values = [], []
    if q and q.strip():
        search = q.strip().lower()
        pattern = "%" + search.replace("!","!!").replace("%","!%").replace("_","!_") + "%"
        filters.append("(LOCATE(%s,LOWER(name))>0 OR LOCATE(%s,LOWER(description))>0 "
                       "OR JSON_SEARCH(LOWER(COALESCE(tags_json,'[]')),'one',%s,'!','$[*]') IS NOT NULL)")
        values.extend((search,search,pattern))
    if kind is not None:
        if kind not in ("full_snapshot","portable_style"):
            raise ValueError("资产种类无效")
        filters.append("kind=%s")
        values.append(kind)
    if input_style is not None:
        if input_style not in ("STD","NAT","VIVD","VLOG"):
            raise ValueError("输入基准无效")
        filters.append("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(params_json,'$.base_photo_style')),'STD')=%s")
        values.append(input_style)
    if favorite is not None:
        if type(favorite) is not bool:
            raise ValueError("收藏筛选无效")
        filters.append("favorite=%s")
        values.append(favorite)
    if group is not None:
        if group == "":
            filters.append("group_name IS NULL")
        else:
            filters.append("group_name=%s")
            values.append(normalized_text(group,48))
    return filters,values,SORTS[sort]
