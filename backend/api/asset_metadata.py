"""资产库组织字段;不接受参数或任意图片内容。"""
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator
from storage.library_metadata import normalize_tags, normalized_text

CoverId = Literal["engine","amber","teal","mono","dusk"]


class OrganizationFields(BaseModel):
    tags: list[str] = Field(default_factory=list)
    group: Optional[str] = None
    favorite: StrictBool = False
    cover_id: CoverId = "engine"

    @field_validator("tags",mode="before")
    @classmethod
    def tags_valid(cls,value):
        return normalize_tags(value)

    @field_validator("group",mode="before")
    @classmethod
    def group_valid(cls,value):
        return normalized_text(value,48,optional=True)


class MetadataPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision_id: Optional[int] = Field(None,ge=1)
    name: Optional[str] = Field(None,max_length=255)
    description: Optional[str] = Field(None,max_length=4000)
    tags: Optional[list[str]] = None
    group: Optional[str] = None
    favorite: Optional[StrictBool] = None
    cover_id: Optional[CoverId] = None

    @field_validator("name",mode="before")
    @classmethod
    def name_valid(cls,value):
        return normalized_text(value,255)

    @field_validator("description","favorite","cover_id",mode="before")
    @classmethod
    def not_null(cls,value):
        if value is None:
            raise ValueError("字段不能为 null")
        return value

    @field_validator("tags",mode="before")
    @classmethod
    def tags_valid(cls,value):
        return normalize_tags(value)

    @field_validator("group",mode="before")
    @classmethod
    def group_valid(cls,value):
        return normalized_text(value,48,optional=True)
