"""账号内不可变 SDR LUT 引用；文件内容不进入参数、消息或工作区快照。"""
import hashlib
import json
from typing import Literal
import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from api import auth
from lut_engine import CubeError, ImportedLut, MAX_CUBE_BYTES, parse_cube, validate_external_id
from storage import db

router = APIRouter(prefix="/api/imported-luts")


class ImportContract(BaseModel):
    model_config = ConfigDict(extra="forbid",strict=True)
    input_encoding: Literal["sRGB","Rec709","VLOG"]
    output_encoding: Literal["sRGB","Rec709"]
    confirmed: bool

    @field_validator("confirmed")
    @classmethod
    def manual_confirmation(cls,value):
        if value is not True:
            raise ValueError("请手动确认 LUT 的输入和输出编码")
        return value

    @model_validator(mode="after")
    def supported_pair(self):
        if (self.input_encoding,self.output_encoding) not in (("sRGB","sRGB"),("Rec709","Rec709"),("VLOG","Rec709")):
            raise ValueError("只支持同编码显示风格,或 V-Log/V-Gamut→Rec709 输入转换")
        return self


def _out(record):
    return {key:record[key] for key in ("id","name","title","size","digest","input_encoding","output_encoding","mode","byte_size","created_at")} | {
        "domain_min":json.loads(record["domain_min_json"]),"domain_max":json.loads(record["domain_max_json"])}


def _owned(identifier,user_id):
    try:
        identifier = validate_external_id(identifier)
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc
    record = db.get_imported_lut(identifier,user_id)
    if not record:
        raise HTTPException(404,"外部 LUT 引用不可用,请重新导入或选择当前账号的 LUT")
    return record


def resolver_for_user(user_id):
    """返回纯调用接口；数据库与所有权检查保留在 API adapter 中。"""
    cache = {}
    def resolve(identifier):
        identifier = validate_external_id(identifier)
        if identifier not in cache:
            record = _owned(identifier,user_id)
            size = record["size"]
            try:
                values = np.frombuffer(record["grid_blob"],dtype="<f4")
                if values.size != size**3*3:
                    raise ValueError("wrong_grid_size")
                data = values.reshape(size,size,size,3).transpose(2,1,0,3)
                data.setflags(write=False)
                cache[identifier] = ImportedLut(size,data,tuple(json.loads(record["domain_min_json"])),
                    tuple(json.loads(record["domain_max_json"])),record["title"],record["input_encoding"],record["output_encoding"])
            except (ValueError,TypeError,KeyError) as exc:
                raise HTTPException(422,"外部 LUT 存储内容已失效") from exc
        return cache[identifier]
    return resolve


@router.post("")
def import_lut(file: UploadFile=File(...),contract: str=Form(...,max_length=1024),
               user: dict=Depends(auth.get_current_user)):
    try:
        declared = ImportContract.model_validate(json.loads(contract))
    except (ValueError,TypeError) as exc:
        raise HTTPException(422,"请明确确认支持的输入和输出编码") from exc
    filename = file.filename or "外部LUT.cube"
    if not filename.lower().endswith(".cube"):
        raise HTTPException(422,"请选择 .cube 文件")
    raw = file.file.read(MAX_CUBE_BYTES+1)
    try:
        parsed = parse_cube(raw)
    except CubeError as exc:
        raise HTTPException(413 if exc.code=="too_large" else 422,{"code":exc.code,"message":str(exc)}) from exc
    name = filename.replace("\\","/").split("/")[-1][:255]
    mode = "input" if declared.input_encoding=="VLOG" else "display"
    try:
        record = db.create_imported_lut(user["id"],name,parsed.title,parsed.size,hashlib.sha256(raw).hexdigest(),
            declared.input_encoding,declared.output_encoding,mode,parsed.domain_min,parsed.domain_max,
            parsed.data.transpose(2,1,0,3).astype("<f4",copy=False).tobytes())
    except db.ImportCapacityError as exc:
        raise HTTPException(409,str(exc)) from exc
    return _out(record)


@router.get("")
def list_imports(user: dict=Depends(auth.get_current_user)):
    return [_out(record) for record in db.list_imported_luts(user["id"])]


@router.get("/{identifier}")
def get_import(identifier: str,user: dict=Depends(auth.get_current_user)):
    return _out(_owned(identifier,user["id"]))


@router.get("/{identifier}/data")
def get_import_data(identifier: str,user: dict=Depends(auth.get_current_user)):
    return Response(_owned(identifier,user["id"])["grid_blob"],media_type="application/octet-stream",
                    headers={"Cache-Control":"private, no-store"})
