"""独立测试库中的导入资产持久化、账号隔离、容量与并发去重。"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from threading import Barrier

import pytest

from lut_engine import parse_cube
from storage import db


@pytest.fixture(autouse=True)
def clean_database():
    db.clear_all();db.clear_sessions();db.clear_users()
    yield
    db.clear_all();db.clear_sessions();db.clear_users()


def store(user_id, *, digest=None, signal='sRGB', name='original.cube', grid=None):
    raw=('LUT_3D_SIZE 2\n'+'\n'.join(f'{b} {r} {g}'
         for b in [0,1] for g in [0,1] for r in [0,1])+'\n').encode()
    parsed=parse_cube(raw)
    blob=parsed.data.transpose(2,1,0,3).astype('<f4',copy=False).tobytes() if grid is None else grid
    return db.create_imported_lut(user_id,name,'immutable title',parsed.size,
        digest or hashlib.sha256(raw).hexdigest(),signal,'Rec709' if signal=='VLOG' else signal,
        'input' if signal=='VLOG' else 'display',parsed.domain_min,parsed.domain_max,blob)


def test_imported_asset_round_trip_is_owned_and_binary_stays_out_of_list():
    owner=db.create_user('import-owner','test-hash')
    other=db.create_user('import-other','test-hash')
    record=store(owner)
    loaded=db.get_imported_lut(record['id'],owner)
    assert loaded['grid_blob']==record['grid_blob'] and len(loaded['grid_blob'])==96
    assert json.loads(loaded['domain_min_json'])==[0,0,0]
    assert json.loads(loaded['domain_max_json'])==[1,1,1]
    assert db.get_imported_lut(record['id'],other) is None
    assert not db.list_imported_luts(other)
    listed=db.list_imported_luts(owner)
    assert len(listed)==1 and listed[0]['id']==record['id'] and 'grid_blob' not in listed[0]


def test_deduplication_preserves_immutable_content_and_uses_owner_and_signals():
    owner=db.create_user('import-owner','test-hash')
    other=db.create_user('import-other','test-hash')
    first=store(owner)
    repeated=store(owner,name='renamed.cube')
    assert repeated['id']==first['id'] and repeated['name']=='original.cube'
    assert repeated['created_at']==first['created_at'] and repeated['grid_blob']==first['grid_blob']
    second=store(owner,signal='Rec709');foreign=store(other)
    assert len({first['id'],second['id'],foreign['id']})==3
    repeated['name']='local mutation'
    assert db.get_imported_lut(first['id'],owner)['name']=='original.cube'


def test_count_and_byte_capacity_reject_before_insertion_and_allow_existing_dedup():
    owner=db.create_user('import-owner','test-hash')
    initial=store(owner)
    for index in range(49):
        store(owner,digest=hashlib.sha256(f'asset-{index}'.encode()).hexdigest())
    assert len(db.list_imported_luts(owner))==50
    assert store(owner)['id']==initial['id']
    with pytest.raises(db.ImportCapacityError):
        store(owner,digest=hashlib.sha256(b'new-over-count').hexdigest())
    other=db.create_user('import-byte-limit','test-hash')
    class OversizedGrid:
        def __len__(self): return 100*1024*1024+1
    with pytest.raises(db.ImportCapacityError): store(other,grid=OversizedGrid())
    assert not db.list_imported_luts(other)
    assert len(db.list_imported_luts(owner))==50


def test_concurrent_identical_imports_share_the_account_lock_and_one_artifact():
    owner=db.create_user('import-concurrent','test-hash')
    start=Barrier(2)
    def import_same(index):
        start.wait(timeout=5)
        return store(owner,name=f'parallel-{index}.cube')
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(import_same,range(2)))
    assert results[0]['id']==results[1]['id']
    assert len(db.list_imported_luts(owner))==1
    assert db.get_imported_lut(results[0]['id'],owner)['grid_blob']==results[1]['grid_blob']
