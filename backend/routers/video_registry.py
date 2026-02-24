"""视频登记 + 分段 + 时间戳映射路由"""
import asyncio
import logging
import sqlite3
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.database import get_db
from backend.services.video_service import get_video_metadata

logger = logging.getLogger(__name__)

router = APIRouter()


class VideoRegisterIn(BaseModel):
    session_date: str
    session_label: str = ""
    raw_path: str
    notes: str = ""


@router.post("/register")
async def register_video(body: VideoRegisterIn):
    """登记视频文件：绑定日期 → raw_path"""
    raw = Path(body.raw_path)
    if not raw.exists():
        raise HTTPException(404, f"文件不存在: {body.raw_path}")

    try:
        meta = await get_video_metadata(body.raw_path)
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
        logger.warning("读取视频元数据失败，回退默认值: path=%s err=%s", body.raw_path, exc)
        meta = {"duration_sec": 0, "width": 0, "height": 0, "file_size": 0}

    db = await get_db()
    try:
        await db.execute("""
            INSERT INTO video_registry (session_date, session_label, raw_path, duration_sec, width, height, file_size, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            body.session_date, body.session_label, body.raw_path,
            meta["duration_sec"], meta["width"], meta["height"], meta.get("file_size", 0),
            body.notes,
        ))
    except sqlite3.IntegrityError:
        await db.execute("""
            UPDATE video_registry SET raw_path = ?, duration_sec = ?, width = ?, height = ?, file_size = ?, notes = ?
            WHERE session_date = ? AND session_label = ?
        """, (
            body.raw_path, meta["duration_sec"], meta["width"], meta["height"], meta.get("file_size", 0),
            body.notes, body.session_date, body.session_label,
        ))

    await db.commit()

    cursor = await db.execute(
        "SELECT * FROM video_registry WHERE session_date = ? AND session_label = ?",
        (body.session_date, body.session_label),
    )
    row = await cursor.fetchone()
    return dict(row)


@router.get("/registry")
async def list_registered_videos(date: str = ""):
    """列出已登记的视频"""
    db = await get_db()
    if date:
        cursor = await db.execute(
            "SELECT * FROM video_registry WHERE session_date = ? ORDER BY session_label",
            (date,),
        )
    else:
        cursor = await db.execute(
            "SELECT * FROM video_registry ORDER BY session_date DESC, session_label LIMIT 50"
        )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


@router.get("/registry/by-date/{date}")
async def get_video_by_date(date: str):
    """根据日期获取视频（自动匹配 lead 用）"""
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM video_registry WHERE session_date = ? ORDER BY session_label LIMIT 1",
        (date,),
    )
    row = await cursor.fetchone()
    if not row:
        return None
    return dict(row)


@router.get("/registry/{video_id}")
async def get_registry_video(video_id: int):
    """按 ID 查询单个视频记录（用于前端轮询代理状态）"""
    db = await get_db()
    cursor = await db.execute("SELECT * FROM video_registry WHERE id = ?", (video_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, f"视频记录不存在: {video_id}")
    return dict(row)


@router.get("/registry/{video_id}/segments")
async def get_video_segments(video_id: int):
    """获取视频的所有分段信息"""
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM video_segments WHERE video_id = ? ORDER BY segment_index",
        (video_id,),
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


# ---- 时间戳 → 原始分段映射 ----

@router.get("/registry/{video_id}/resolve-timestamp")
async def resolve_timestamp(video_id: int, t: float = 0):
    """将代理时间戳映射回原始分段文件 + 本地偏移"""
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM video_segments WHERE video_id = ? ORDER BY segment_index",
        (video_id,),
    )
    segments = [dict(r) for r in await cursor.fetchall()]

    if not segments:
        cursor = await db.execute("SELECT * FROM video_registry WHERE id = ?", (video_id,))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, "视频记录不存在")
        return {
            "segment_index": 0,
            "raw_path": row["raw_path"],
            "local_sec": t,
            "duration_sec": row["duration_sec"],
        }

    for seg in segments:
        seg_end = seg["offset_sec"] + seg["duration_sec"]
        if t < seg_end or seg["segment_index"] == segments[-1]["segment_index"]:
            local_sec = t - seg["offset_sec"]
            local_sec = max(0, min(local_sec, seg["duration_sec"]))
            return {
                "segment_index": seg["segment_index"],
                "raw_path": seg["raw_path"],
                "local_sec": round(local_sec, 3),
                "duration_sec": seg["duration_sec"],
            }

    last = segments[-1]
    return {
        "segment_index": last["segment_index"],
        "raw_path": last["raw_path"],
        "local_sec": round(t - last["offset_sec"], 3),
        "duration_sec": last["duration_sec"],
    }


@router.get("/registry/{video_id}/resolve-range")
async def resolve_range(video_id: int, start: float = 0, end: float = 0):
    """将代理时间区间映射为原始分段裁切指令"""
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM video_segments WHERE video_id = ? ORDER BY segment_index",
        (video_id,),
    )
    segments = [dict(r) for r in await cursor.fetchall()]

    if not segments:
        cursor = await db.execute("SELECT * FROM video_registry WHERE id = ?", (video_id,))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, "视频记录不存在")
        return {"cuts": [{
            "segment_index": 0,
            "raw_path": row["raw_path"],
            "local_start": round(start, 3),
            "local_end": round(end, 3),
        }]}

    cuts = []
    for seg in segments:
        seg_start = seg["offset_sec"]
        seg_end = seg_start + seg["duration_sec"]

        if end <= seg_start:
            break
        if start >= seg_end:
            continue

        local_start = max(0, start - seg_start)
        local_end = min(seg["duration_sec"], end - seg_start)

        cuts.append({
            "segment_index": seg["segment_index"],
            "raw_path": seg["raw_path"],
            "local_start": round(local_start, 3),
            "local_end": round(local_end, 3),
        })

    return {"cuts": cuts}
