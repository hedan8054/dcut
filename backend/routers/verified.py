"""Verified Clips 真值路由"""
import json
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.config import DATA_DIR
from backend.database import get_db
from backend.models import VerifiedClipIn, VerifiedClipPatch
from backend.services.ffmpeg_service import export_roughcut, generate_thumbnail

router = APIRouter()
logger = logging.getLogger(__name__)


EXPORT_DIR = DATA_DIR / "exports" / "roughcuts"


@router.post("/create-and-export")
async def create_and_export(body: VerifiedClipIn):
    """保存真值片段 + ffmpeg 导出粗剪 MP4

    导出失败时回滚已创建的记录，返回 500 错误（不留脏数据）。
    """
    db = await get_db()

    # 前置校验：源视频必须存在
    if not Path(body.video_path).exists():
        raise HTTPException(400, f"源视频不存在: {body.video_path}")

    # 生成封面帧
    thumbnail = ""
    try:
        mid_time = (body.start_sec + body.end_sec) / 2
        abs_path = await generate_thumbnail(body.video_path, mid_time)
        if abs_path:
            thumbnail = str(Path(abs_path).relative_to(DATA_DIR))
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
        logger.warning("生成真值缩略图失败: path=%s err=%s", body.video_path, exc)

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

    # ffmpeg 导出粗剪（stream copy）— 失败则回滚记录
    export_name = f"sku{body.sku_code}_clip{clip_id}_t{int(body.start_sec)}_t{int(body.end_sec)}.mp4"
    export_path = str(EXPORT_DIR / export_name)
    try:
        await export_roughcut(body.video_path, body.start_sec, body.end_sec, export_path)
    except (RuntimeError, OSError) as exc:
        # 回滚：删除刚创建的脏记录
        await db.execute("DELETE FROM verified_clips WHERE id = ?", (clip_id,))
        await db.commit()
        # 清理可能生成的残缺文件
        Path(export_path).unlink(missing_ok=True)
        logger.error("粗剪导出失败，已回滚 clip_id=%d: %s", clip_id, exc)
        raise HTTPException(500, f"粗剪导出失败: {exc}") from exc

    # 导出成功 → 更新 video_path 为相对路径
    rel_path = str(Path(export_path).relative_to(DATA_DIR))
    await db.execute("UPDATE verified_clips SET video_path = ? WHERE id = ?", (rel_path, clip_id))
    await db.commit()

    cursor = await db.execute("SELECT * FROM verified_clips WHERE id = ?", (clip_id,))
    row = await cursor.fetchone()
    return dict(row)


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
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
        logger.warning("生成真值缩略图失败: path=%s err=%s", body.video_path, exc)

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


@router.post("/{clip_id}/export")
async def export_existing(clip_id: int):
    """为已有记录补导出粗剪 MP4"""
    db = await get_db()
    cursor = await db.execute("SELECT * FROM verified_clips WHERE id = ?", (clip_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "片段不存在")

    clip = dict(row)
    # 确定源视频路径：优先用原始 video_path（proxy），如果已被改为导出路径则用 raw_video_path
    source = clip["video_path"]
    if "exports/roughcuts/" in source:
        source = clip["raw_video_path"] or clip["video_path"]

    if not source or not Path(source).exists():
        raise HTTPException(400, f"源视频不存在: {source}")

    export_name = f"sku{clip['sku_code']}_clip{clip_id}_t{int(clip['start_sec'])}_t{int(clip['end_sec'])}.mp4"
    export_path = str(EXPORT_DIR / export_name)
    try:
        await export_roughcut(source, clip["start_sec"], clip["end_sec"], export_path)
        rel_path = str(Path(export_path).relative_to(DATA_DIR))
        await db.execute("UPDATE verified_clips SET video_path = ? WHERE id = ?", (rel_path, clip_id))
        await db.commit()
    except (RuntimeError, OSError) as exc:
        raise HTTPException(500, f"导出失败: {exc}") from exc

    cursor = await db.execute("SELECT * FROM verified_clips WHERE id = ?", (clip_id,))
    row = await cursor.fetchone()
    return dict(row)


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
