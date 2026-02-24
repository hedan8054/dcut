"""CLIP 以图找图路由"""
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class ClipSearchIn(BaseModel):
    sku_image_path: str
    video_path: str
    video_duration: float
    sample_interval: float = 30.0
    top_k: int = 10


@router.post("/clip-search")
async def clip_search(body: ClipSearchIn):
    """以商品图搜索视频中的相似帧"""
    from backend.services.clip_service import find_similar_frames

    if not Path(body.video_path).exists():
        raise HTTPException(404, f"视频不存在: {body.video_path}")

    results = await find_similar_frames(
        sku_image_path=body.sku_image_path,
        video_path=body.video_path,
        video_duration=body.video_duration,
        sample_interval=body.sample_interval,
        top_k=body.top_k,
    )
    return {"results": results}
