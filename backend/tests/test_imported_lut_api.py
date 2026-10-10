"""独立 HTTP 应用与内存 adapter 验证导入契约,不调用数据库。"""
import hashlib
import json
from uuid import uuid4

import numpy as np
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api import auth
from api import imported_luts as I
from lut_engine import parse_cube, sample_imported_lut


def cube():
    return ('TITLE "我的 LUT"\nLUT_3D_SIZE 2\n'+'\n'.join(
        f'{b} {r} {g}' for b in [0,1] for g in [0,1] for r in [0,1])+'\n').encode()


@pytest.fixture
def harness(monkeypatch):
    records={};account={'id':17}
    def create(user_id,name,title,size,digest,input_encoding,output_encoding,mode,low,high,grid_blob):
        for record in records.values():
            if (record['user_id'],record['digest'],record['input_encoding'],record['output_encoding'])==(user_id,digest,input_encoding,output_encoding): return record
        identifier=str(uuid4())
        record={'id':identifier,'user_id':user_id,'name':name,'title':title,'size':size,'digest':digest,
                'input_encoding':input_encoding,'output_encoding':output_encoding,'mode':mode,
                'domain_min_json':json.dumps(low),'domain_max_json':json.dumps(high),
                'grid_blob':grid_blob,'byte_size':len(grid_blob),'created_at':'2026-10-10T00:00:00+00:00'}
        records[identifier]=record
        return record
    monkeypatch.setattr(I.db,'create_imported_lut',create)
    monkeypatch.setattr(I.db,'get_imported_lut',lambda identifier,user:records.get(identifier) if records.get(identifier,{}).get('user_id')==user else None)
    monkeypatch.setattr(I.db,'list_imported_luts',lambda user:[record for record in records.values() if record['user_id']==user])
    monkeypatch.setattr(I.db,'_connect',lambda:pytest.fail('纯接口测试不能连接数据库'))
    app=FastAPI();app.include_router(I.router);app.dependency_overrides[auth.get_current_user]=lambda:account
    with TestClient(app) as client: yield client,records,account


def upload(client,*,input_encoding='sRGB',output_encoding='sRGB',confirmed=True,data=None,filename='style.cube',extra=None):
    contract={'input_encoding':input_encoding,'output_encoding':output_encoding,'confirmed':confirmed,**(extra or {})}
    return client.post('/api/imported-luts',files={'file':(filename,cube() if data is None else data,'application/octet-stream')},data={'contract':json.dumps(contract)})


@pytest.mark.parametrize('signal_pair',[('sRGB','sRGB'),('Rec709','Rec709'),('VLOG','Rec709')])
def test_import_exact_signal_contract_and_binary_grid_round_trip(harness,signal_pair):
    client,records,_=harness
    response=upload(client,input_encoding=signal_pair[0],output_encoding=signal_pair[1])
    assert response.status_code==200
    metadata=response.json();identifier=metadata['id']
    assert metadata['input_encoding']==signal_pair[0] and metadata['output_encoding']==signal_pair[1]
    assert metadata['mode']==('input' if signal_pair[0]=='VLOG' else 'display')
    assert metadata['digest']==hashlib.sha256(cube()).hexdigest()
    assert 'grid_blob' not in metadata and 'data' not in metadata and 'user_id' not in metadata
    assert client.get('/api/imported-luts').json()==[metadata]
    assert client.get(f'/api/imported-luts/{identifier}').json()==metadata
    binary=client.get(f'/api/imported-luts/{identifier}/data')
    assert binary.status_code==200 and binary.content==records[identifier]['grid_blob']
    assert binary.headers['cache-control']=='private, no-store'
    assert len(binary.content)==2**3*3*4
    adapter=I.resolver_for_user(17)(identifier)
    assert np.allclose(sample_imported_lut(adapter,np.array([[.2,.4,.8]])),[[.8,.2,.4]],atol=1e-12)


def test_import_deduplication_immutability_and_account_isolation(harness):
    client,records,account=harness
    first=upload(client).json()
    assert upload(client,filename='renamed.cube').json()['id']==first['id']
    assert len(records)==1
    identifier=first['id']
    assert client.patch(f'/api/imported-luts/{identifier}',json={'name':'change'}).status_code==405
    assert client.delete(f'/api/imported-luts/{identifier}').status_code==405
    account['id']=18
    assert client.get('/api/imported-luts').json()==[]
    assert client.get(f'/api/imported-luts/{identifier}').status_code==404
    assert client.get(f'/api/imported-luts/{identifier}/data').status_code==404
    with pytest.raises(HTTPException) as error: I.resolver_for_user(18)(identifier)
    assert error.value.status_code==404
    second=upload(client).json()
    assert second['id']!=identifier


@pytest.mark.parametrize('kwargs',[
    {'confirmed':False},{'confirmed':'true'},{'input_encoding':'HDR'},{'output_encoding':'VLOG'},
    {'input_encoding':'sRGB','output_encoding':'Rec709'}, {'input_encoding':'VLOG','output_encoding':'sRGB'},
    {'extra':{'guess_signal':True}}, {'filename':'image.png'}, {'data':b'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n'},
    {'data':b'LUT_3D_SIZE 2\nNaN 0 0\n'}, {'data':b'\xff\x00'},
])
def test_invalid_import_is_rejected_without_storage(harness,kwargs):
    client,records,_=harness
    assert upload(client,**kwargs).status_code==422
    assert records=={}


def test_import_raw_byte_limit_and_storage_capacity_have_explicit_responses(harness,monkeypatch):
    client,records,_=harness
    assert upload(client,data=b'x'*(I.MAX_CUBE_BYTES+1)).status_code==413
    assert records=={}
    def full(*args): raise I.db.ImportCapacityError('导入空间已满')
    monkeypatch.setattr(I.db,'create_imported_lut',full)
    assert upload(client).status_code==409


@pytest.mark.parametrize('corruption',[
    lambda record:record.update(grid_blob=b'bad'),
    lambda record:record.update(grid_blob=np.full(24,np.nan,dtype='<f4').tobytes()),
    lambda record:record.update(domain_min_json='[0,1,0]'),
    lambda record:record.update(input_encoding='HDR'),
])
def test_corrupt_persisted_grid_is_not_rendered(harness,corruption):
    client,records,_=harness
    identifier=upload(client).json()['id'];corruption(records[identifier])
    with pytest.raises(HTTPException) as error: I.resolver_for_user(17)(identifier)
    assert error.value.status_code==422
