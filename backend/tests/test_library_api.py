"""资产检索、账号组织信息与调色修订隔离。"""
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event
import pytest
from fastapi.testclient import TestClient
from api.auth import create_token
from api.main import app
from lut_engine.recipe import input_contract
from storage import db

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean():
    db.clear_all()
    db.clear_sessions()
    db.clear_users()
    yield
    db.clear_all()
    db.clear_sessions()
    db.clear_users()


@pytest.fixture()
def headers():
    user_id = db.create_user("library-owner","unused-hash")
    return {"Authorization":f"Bearer {create_token(user_id,0)}"}


def create(headers,**body):
    response = client.post("/api/luts",headers=headers,json={"name":"日常","params":{},**body})
    assert response.status_code == 200,response.text
    return response.json()


def revisions(headers,asset):
    return client.get(f"/api/luts/{asset['id']}/revisions",headers=headers).json()


def test_create_and_metadata_persist_without_grading_revision(headers):
    asset = create(headers,name=" Street ",description="阴天街拍",tags=[" City ","city","人像"],group="旅行",favorite=True,cover_id="amber")
    assert asset["name"] == "Street" and asset["tags"] == ["City","人像"]
    assert asset["updated_at"] == asset["created_at"]
    response = client.patch(f"/api/luts/{asset['id']}/metadata",headers=headers,json={
        "description":"暖光人像","tags":["室内"],"group":None,"favorite":False,"cover_id":"teal","revision_id":asset["revision_id"]})
    assert response.status_code == 200,response.text
    updated = response.json()
    assert updated["revision_id"] == asset["revision_id"]
    assert updated["params"] == asset["params"] and updated["updated_at"] > asset["updated_at"]
    assert updated["group"] is None and updated["favorite"] is False
    assert len(revisions(headers,asset)) == 1
    assert client.get(f"/api/luts/{asset['id']}",headers=headers).json() == updated
    original = revisions(headers,asset)[0]
    assert original["description"] == "阴天街拍" and original["cover_id"] == "amber"
    noop = client.patch(f"/api/luts/{asset['id']}/metadata",headers=headers,json={"tags":["室内"],"favorite":False}).json()
    assert noop["updated_at"] == updated["updated_at"]


def test_legacy_put_rename_and_null_params_do_not_create_revision(headers):
    asset = create(headers,params={"exposure":.5},source={"value":1},tags=["电影感"])
    updated = client.put(f"/api/luts/{asset['id']}",headers=headers,json={"name":"新名称","params":None,"group":"人像"}).json()
    assert updated["revision_id"] == asset["revision_id"]
    assert updated["params"] == asset["params"] and updated["source"] == asset["source"]
    assert updated["tags"] == ["电影感"] and updated["group"] == "人像"
    assert len(revisions(headers,asset)) == 1


def test_actual_grading_change_adds_revision_and_preserves_organization(headers):
    asset = create(headers,tags=["夜景"],group="街拍",favorite=True,cover_id="dusk")
    updated = client.put(f"/api/luts/{asset['id']}",headers=headers,json={"params":{"exposure":.4}}).json()
    assert updated["revision_id"] != asset["revision_id"] and updated["updated_at"] > asset["updated_at"]
    for key in ("tags","group","favorite","cover_id"):
        assert updated[key] == asset[key]
    assert len(revisions(headers,asset)) == 2
    noop = client.put(f"/api/luts/{asset['id']}",headers=headers,json={"params":updated["params"]}).json()
    assert noop["revision_id"] == updated["revision_id"] and noop["updated_at"] == updated["updated_at"]


def test_metadata_cas_rejects_stale_grading_revision(headers):
    asset = create(headers)
    current = client.put(f"/api/luts/{asset['id']}",headers=headers,json={"params":{"temp":200}}).json()
    rejected = client.patch(f"/api/luts/{asset['id']}/metadata",headers=headers,json={"tags":["stale"],"revision_id":asset["revision_id"]})
    assert rejected.status_code == 409 and rejected.json()["detail"]["code"] == "revision_conflict"
    assert client.get(f"/api/luts/{asset['id']}",headers=headers).json()["tags"] == []
    assert len(revisions(headers,current)) == 2


@pytest.mark.parametrize("body",[{"params":{}},{"source":{}},{"favorite":"true"},{"favorite":None},{"tags":None},
                                  {"tags":["x"*25]},{"tags":list(map(str,range(13)))},{"group":"x"*49},
                                  {"cover_id":"data:image/png;base64,x"},{"cover_data":"abc"},{"name":" "}])
def test_metadata_rejects_content_or_invalid_organization(headers,body):
    asset = create(headers)
    response = client.patch(f"/api/luts/{asset['id']}/metadata",headers=headers,json=body)
    assert response.status_code == 422,response.text
    assert len(revisions(headers,asset)) == 1


def test_search_facets_account_summary_and_literal_wildcards(headers):
    ordinary = create(headers,name="Night Walk",description="阴天街拍",tags=["City","50%_!"],group="旅行",favorite=True,params={"base_photo_style":"NAT"})
    other = create(headers,name="Warm Light",description="室内人像",tags=["人像"],cover_id="amber")
    style = create(headers,name="style",kind="portable_style",recipe={"format_version":1,"kind":"portable_style","input_contract":input_contract({"base_photo_style":"VLOG"}),"operations":{"temp":{"mode":"add","value":200}}})
    for query in ("night","阴天","cItY","50%_!","50%"):
        response = client.get("/api/luts",headers=headers,params={"q":query})
        assert response.status_code == 200,response.text
        assert [row["id"] for row in response.json()] == [ordinary["id"]]
    assert client.get("/api/luts",headers=headers,params={"q":"%' OR 1=1"}).json() == []
    assert [x["id"] for x in client.get("/api/luts",headers=headers,params={"kind":"full_snapshot","input":"NAT","favorite":"true","group":"旅行"}).json()] == [ordinary["id"]]
    assert [x["id"] for x in client.get("/api/luts",headers=headers,params={"kind":"portable_style","input":"VLOG"}).json()] == [style["id"]]
    assert len(client.get("/api/luts",headers=headers,params={"favorite":"false","group":""}).json()) == 2
    assert client.get("/api/luts/summary",headers=headers).json() == {"total":3,"groups":["旅行"]}
    other_id = db.create_user("other-library","unused-hash")
    other_headers = {"Authorization":f"Bearer {create_token(other_id,0)}"}
    assert client.get("/api/luts/summary",headers=other_headers).json() == {"total":0,"groups":[]}
    assert client.patch(f"/api/luts/{other['id']}/metadata",headers=other_headers,json={"favorite":True}).status_code == 404
    assert client.get("/api/luts",headers=headers,params={"group":"  "}).status_code == 422


def test_all_sorts_and_legacy_defaults(headers):
    first = create(headers,name="Bravo")
    second = create(headers,name="Alpha")
    user_id = db.get_user_by_username("library-owner")["id"]
    legacy_id = db.create_lut(user_id,"Charlie","","{}")
    with db._connect() as conn:
        with conn.cursor() as cur:
            for ident,created,updated in [(first["id"],"2026-01-01","2026-03-03"),(second["id"],"2026-01-02","2026-03-01"),(legacy_id,"2026-01-03","2026-03-02")]:
                cur.execute("UPDATE luts SET created_at=%s,updated_at=%s WHERE id=%s",(created,updated,ident))
            cur.execute("UPDATE luts SET tags_json=NULL,updated_at='' WHERE id=%s",(legacy_id,))
        conn.commit()
    db.init_db()
    expected = {"created_asc":[first["id"],second["id"],legacy_id],"created_desc":[legacy_id,second["id"],first["id"]],
                "updated_asc":[legacy_id,second["id"],first["id"]],"updated_desc":[first["id"],second["id"],legacy_id],
                "name_asc":[second["id"],first["id"],legacy_id],"name_desc":[legacy_id,first["id"],second["id"]]}
    for sort,ids in expected.items():
        response = client.get("/api/luts",headers=headers,params={"sort":sort})
        assert [row["id"] for row in response.json()] == ids
    old = client.get(f"/api/luts/{legacy_id}",headers=headers).json()
    assert old["tags"] == [] and old["group"] is None and old["favorite"] is False and old["cover_id"] == "engine"
    assert old["updated_at"] == old["created_at"]
    nochange = client.patch(f"/api/luts/{legacy_id}/metadata",headers=headers,json={"tags":[]}).json()
    assert nochange["updated_at"] == old["updated_at"]
    assert client.get("/api/luts",headers=headers,params={"sort":"name;DELETE"}).status_code == 422


def test_concurrent_metadata_and_grade_merge_omitted_fields(headers,monkeypatch):
    from api import main as M
    asset = create(headers,tags=["before"],group="旧组")
    grading_ready,allow_grade,metadata_ready = Event(),Event(),Event()
    original_content,original_update = M._asset_content,db.update_lut
    def content(body,existing=None):
        if body.params is not None and body.params.exposure == .7:
            grading_ready.set()
            assert allow_grade.wait(10)
        return original_content(body,existing)
    def update(*args,**kwargs):
        if kwargs.get("favorite") is True:
            metadata_ready.set()
        return original_update(*args,**kwargs)
    monkeypatch.setattr(M,"_asset_content",content)
    monkeypatch.setattr(db,"update_lut",update)
    route = f"/api/luts/{asset['id']}"
    with ThreadPoolExecutor(max_workers=3) as executor:
        grading = executor.submit(client.put,route,headers=headers,json={"params":{"exposure":.7},"source":{"value":2}})
        try:
            assert grading_ready.wait(10)
            favorite = executor.submit(client.patch,route+"/metadata",headers=headers,json={"favorite":True})
            tags = executor.submit(client.patch,route+"/metadata",headers=headers,json={"tags":["after"],"group":"新组"})
            assert metadata_ready.wait(10)
            allow_grade.set()
            for result in (grading,favorite,tags):
                response = result.result(timeout=10)
                assert response.status_code == 200,response.text
        finally:
            allow_grade.set()
    final = client.get(route,headers=headers).json()
    assert final["params"]["exposure"] == .7 and final["source"] == {"value":2}
    assert final["tags"] == ["after"] and final["group"] == "新组" and final["favorite"] is True
    assert len(revisions(headers,asset)) == 2
