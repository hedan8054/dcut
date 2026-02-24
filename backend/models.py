"""Pydantic 数据模型"""
from typing import Literal

from pydantic import BaseModel


# ---- XLSX 导入 ----

class SnapshotOut(BaseModel):
    id: int
    file_name: str
    file_hash: str
    row_count: int
    imported_at: str


class DiffOut(BaseModel):
    id: int
    snapshot_id: int
    diff_type: str
    sku_code: str
    detail_json: str
    created_at: str


# ---- 商品 / SKU ----

class ProductOut(BaseModel):
    sku_code: str
    product_id: str
    product_name: str
    price: float | None
    shop_name: str
    commission_rate: float | None
    promo_link: str
    launch_date: str | None
    product_status: str
    abnormal_note: str
    image_path: str
    lead_count: int = 0
    latest_lead_date: str | None = None


class ProductBrief(BaseModel):
    sku_code: str
    product_name: str
    price: float | None
    image_path: str
    lead_count: int = 0
    latest_lead_date: str | None = None


# ---- Lead 线索 ----

class LeadOut(BaseModel):
    id: str
    sku_code: str
    material_year: int
    raw_fragment: str
    normalized_fragment: str
    material_month: int | None
    material_day: int | None
    session_label: str | None
    host_label: str | None
    time_points_json: str
    parse_confidence: str
    created_at: str


class CalendarEntry(BaseModel):
    date: str
    sku_count: int


# ---- Verified Clips ----

class VerifiedClipIn(BaseModel):
    sku_code: str
    lead_id: str | None = None
    video_path: str
    raw_video_path: str = ""
    start_sec: float
    end_sec: float
    rating: int = 0
    tags: list[str] = []
    lead_time_original: str = ""
    offset_sec: float = 0.0
    notes: str = ""


class VerifiedClipOut(BaseModel):
    id: int
    sku_code: str
    lead_id: str | None
    video_path: str
    raw_video_path: str
    start_sec: float
    end_sec: float
    rating: int
    tags_json: str
    thumbnail: str
    lead_time_original: str
    offset_sec: float
    notes: str
    created_at: str


class VerifiedClipPatch(BaseModel):
    start_sec: float | None = None
    end_sec: float | None = None
    rating: int | None = None
    tags: list[str] | None = None
    notes: str | None = None


class ReviewCapsuleIn(BaseModel):
    video_id: int | None = None
    video_path: str
    start_sec: float
    end_sec: float
    display_mode: Literal['compressed'] = 'compressed'
    compression_ratio: float = 0.5
    sample_interval_sec: float = 10
    sku_code: str | None = None
    sku_label: str | None = None
    rating: int = 0
    tags: list[str] = []
    notes: str = ""
    z_index: int = 0
    status: Literal['draft', 'bound', 'final'] = 'draft'


class ReviewCapsuleOut(BaseModel):
    id: int
    video_id: int | None
    video_path: str
    start_sec: float
    end_sec: float
    display_mode: Literal['compressed']
    compression_ratio: float
    sample_interval_sec: float
    sku_code: str | None
    sku_label: str | None
    rating: int
    tags_json: str
    notes: str
    z_index: int
    status: Literal['draft', 'bound', 'final']
    created_at: str
    updated_at: str


class ReviewCapsulePatch(BaseModel):
    start_sec: float | None = None
    end_sec: float | None = None
    display_mode: Literal['compressed'] | None = None
    compression_ratio: float | None = None
    sample_interval_sec: float | None = None
    sku_code: str | None = None
    sku_label: str | None = None
    rating: int | None = None
    tags: list[str] | None = None
    notes: str | None = None
    z_index: int | None = None
    status: Literal['draft', 'bound', 'final'] | None = None


class ReviewCapsuleZOrder(BaseModel):
    id: int
    z_index: int


class ReviewCapsuleReorderIn(BaseModel):
    orders: list[ReviewCapsuleZOrder]


# ---- 发布计划 ----

class PlanOut(BaseModel):
    id: int
    plan_date: str
    status: str
    items: list["PlanItemOut"] = []


class PlanItemOut(BaseModel):
    id: int
    sku_code: str
    sort_order: int
    status: str


class PlanItemsIn(BaseModel):
    sku_codes: list[str]


class PlanItemPatch(BaseModel):
    sort_order: int | None = None
    status: str | None = None


# ---- 视频 ----

class VideoMetaOut(BaseModel):
    video_path: str
    proxy_path: str
    duration_sec: float
    width: int | None
    height: int | None
    file_size: int | None


class BatchFramesIn(BaseModel):
    path: str = ""
    video_id: int | None = None
    timestamps: list[float]
    w: int = 180
    h: int = 320


class ProxyIn(BaseModel):
    raw_path: str
    proxy_dir: str = ""


# ---- 搜索 ----

class SkuSearchResult(BaseModel):
    product: ProductOut
    leads: list[LeadOut]
    verified_clips: list[VerifiedClipOut]


class DateSearchResult(BaseModel):
    date: str
    skus: list["DateSkuEntry"]


class DateSkuEntry(BaseModel):
    sku_code: str
    product_name: str
    image_path: str
    leads: list[LeadOut]
    verified_count: int
