"""Verified Clips 真值路由"""
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.config import DATA_DIR
from backend.database import get_db
from backend.models import VerifiedClipIn, VerifiedClipPatch
from backend.services.ffmpeg_service import generate_thumbnail

router = APIRouter()


@router.post("")
async def create_verified(body: VerifiedClipIn):
    """保存真值片段"""
    db = await get_db()

    # 生成封面帧（存储相对路径，便于前端通过 /data/ 访问）
    thumbnail = ""
    try:
        mid_time = (body.start_sec + body.end_sec) / 2
        abs_path = await generate_thumbnail(body.video_path, mid_time)
        if abs_path:
            thumbnail = str(Path(abs_path).relative_to(DATA_DIR))
    except Exception:
        pass

    tags_json = json.dumps(body.tags, ensure_ascii=False)

    cursor = await db.execute("""
        INSERT INTO verified_clips
            (sku_code, lead_id, video_path, raw_video_path,
             start_sec, end_sec, rating, tags_json, thumbnail,
             lead_time_original, offset_sec, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        body.sku_code, body.lead_id, body.video_path, body.raw_video_path,
        body.start_sec, body.end_sec, body.rating, tags_json, thumbnail,
        body.lead_time_original, body.offset_sec, body.notes,
    ))
    clip_id = cursor.lastrowid
    await db.commit()

    cursor = await db.execute("SELECT * FROM verified_clips WHERE id = ?", (clip_id,))
    row = await cursor.fetchone()
    return dict(row)


@router.get("")
async def list_verified(sku_code: str = ""):
    """按 SKU 查真值列表"""
    db = await get_db()
    if sku_code:
        cursor = await db.execute(
            "SELECT * FROM verified_clips WHERE sku_code = ? ORDER BY rating DESC, created_at DESC",
            (sku_code,),
        )
    else:
        cursor = await db.execute(
            "SELECT * FROM verified_clips ORDER BY created_at DESC LIMIT 100"
        )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


@router.patch("/{clip_id}")
async def update_verified(clip_id: int, body: VerifiedClipPatch):
    """修改评分/标签/边界"""
    db = await get_db()
    updates = []
    params: list = []

    if body.start_sec is not None:
        updates.append("start_sec = ?")
        params.append(body.start_sec)
    if body.end_sec is not None:
        updates.append("end_sec = ?")
        params.append(body.end_sec)
    if body.rating is not None:
        updates.append("rating = ?")
        params.append(body.rating)
    if body.tags is not None:
        updates.append("tags_json = ?")
        params.append(json.dumps(body.tags, ensure_ascii=False))
    if body.notes is not None:
        updates.append("notes = ?")
        params.append(body.notes)

    if not updates:
        raise HTTPException(400, "没有需要更新的字段")

    params.append(clip_id)
    await db.execute(
        f"UPDATE verified_clips SET {', '.join(updates)} WHERE id = ?",
        params,
    )
    await db.commit()

    cursor = await db.execute("SELECT * FROM verified_clips WHERE id = ?", (clip_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "片段不存在")
    return dict(row)


@router.delete("/{clip_id}")
async def delete_verified(clip_id: int):
    """删除片段"""
    db = await get_db()
    await db.execute("DELETE FROM verified_clips WHERE id = ?", (clip_id,))
    await db.commit()
    return {"ok": True}
