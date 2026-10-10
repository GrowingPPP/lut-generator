"""资产组织的纯规范化与查询边界。"""
import pytest
from api.asset_metadata import MetadataPatch
from storage.library_metadata import normalize_tags, organization_changes, query_parts, values_equal


def test_organization_normalizes_and_deduplicates_tags():
    assert normalize_tags([" City ","city","人像"]) == ["City","人像"]
    assert organization_changes({"group":" ","favorite":False}) == {"group_name":None,"favorite":False}
    assert values_equal("tags_json",None,"[]")
    assert values_equal("params_json",'{"exposure":0,"temp":100}','{"temp":100,"exposure":0.0}')


@pytest.mark.parametrize("values",[[True],[""],["a"*25],list(map(str,range(13))),"text",None,["a\x00"]])
def test_tags_reject_invalid(values):
    with pytest.raises(ValueError):
        normalize_tags(values)


@pytest.mark.parametrize("body",[{"params":{}},{"favorite":1},{"favorite":None},{"cover_id":"data:image/png;base64,x"},
                                  {"cover_id":None},{"description":None},{"name":" "},{"tags":None},{"group":"a"*49}])
def test_metadata_patch_strict(body):
    with pytest.raises(ValueError):
        MetadataPatch.model_validate(body)


def test_patch_distinguishes_omitted_and_clear_fields():
    assert MetadataPatch().model_dump(exclude_unset=True) == {}
    assert MetadataPatch.model_validate({"group":None,"tags":[]}).model_dump(exclude_unset=True) == {"tags":[],"group":None}


def test_query_values_parameterized_and_wildcards_literal():
    filters,values,order = query_parts(q="  50%_!  ",group="x' OR 1=1",favorite=False,sort="name_asc")
    assert values == ["50%_!","50%_!","%50!%!_!!%",False,"x' OR 1=1"]
    assert "OR 1=1" not in " ".join(filters)
    assert order == "name ASC,id ASC"
    with pytest.raises(ValueError):
        query_parts(sort="name; DROP TABLE luts")
