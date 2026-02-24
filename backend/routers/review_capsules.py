"""Review Capsules 路由"""
import json
from datetime import datetime

from fastapi import APIRouter, HTTPException

from backend.database import get_db
from backend.models import (
    ReviewCapsuleIn,
    ReviewCapsuleOut,
    ReviewCapsulePatch,
    ReviewCapsuleReorderIn,
)

router = APIRouter()


@router.get("", response_model=list[ReviewCapsuleOut])
async def list_review_capsules(video_id: int | None = None, video_path: str = ""):
    """按视频读取胶囊草稿（video_id 优先，兼容 video_path）"""
    db = await get_db()

    if video_id is not None:
        cursor = await db.execute(
            """
            SELECT * FROM review_capsules
            WHERE video_id = ?
            ORDER BY z_index ASC, updated_at DESC, id DESC
            """,
            (video_id,),
        )
    elif video_path:
        cursor = await db.execute(
            """
            SELECT * FROM review_capsules
            WHERE video_path = ?
            ORDER BY z_index ASC, updated_at DESC, id DESC
            """,
            (video_path,),
        )
    else:
        cursor = await db.execute(
            """
            SELECT * FROM review_capsules
            ORDER BY updated_at DESC, id DESC
            LIMIT 200
            """
        )

    rows = await cursor.fetchall()
    return [_row_to_capsule_out(r) for r in rows]


@router.post("", response_model=ReviewCapsuleOut)
async def create_review_capsule(body: ReviewCapsuleIn):
    """创建胶囊草稿"""
    if body.end_sec <= body.start_sec:
        raise HTTPException(400, "end_sec 必须大于 start_sec")

    db = await get_db()
    tags_json = json.dumps(body.tags, ensure_ascii=False)
    now = datetime.now().isoformat(timespec='seconds')

    cursor = await db.execute(
        """
        INSERT INTO review_capsules
        (
            video_id, video_path, start_sec, end_sec,
            display_mode, compression_ratio, sample_interval_sec,
            sku_code, sku_label, rating, tags_json, notes,
            z_index, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            body.video_id,
            body.video_path,
            body.start_sec,
            body.end_sec,
            body.display_mode,
            body.compression_ratio,
            body.sample_interval_sec,
            body.sku_code,
            body.sku_label,
            body.rating,
            tags_json,
            body.notes,
            body.z_index,
            body.status,
            now,
            now,
        ),
    )
    capsule_id = cursor.lastrowid
    await db.commit()

    return await _get_capsule_or_404(capsule_id)


@router.patch("/{capsule_id}", response_model=ReviewCapsuleOut)
async def patch_review_capsule(capsule_id: int, body: ReviewCapsulePatch):
    """更新胶囊（几何或元数据）"""
    db = await get_db()
    updates: list[str] = []
    params: list[object] = []

    if body.start_sec is not None:
        updates.append("start_sec = ?")
        params.append(body.start_sec)
    if body.end_sec is not None:
        updates.append("end_sec = ?")
        params.append(body.end_sec)
    if body.display_mode is not None:
        updates.append("display_mode = ?")
        params.append(body.display_mode)
    if body.compression_ratio is not None:
        updates.append("compression_ratio = ?")
        params.append(body.compression_ratio)
    if body.sample_interval_sec is not None:
        updates.append("sample_interval_sec = ?")
        params.append(body.sample_interval_sec)
    if body.sku_code is not None:
        updates.append("sku_code = ?")
        params.append(body.sku_code)
    if body.sku_label is not None:
        updates.append("sku_label = ?")
        params.append(body.sku_label)
    if body.rating is not None:
        updates.append("rating = ?")
        params.append(body.rating)
    if body.tags is not None:
        updates.append("tags_json = ?")
        params.append(json.dumps(body.tags, ensure_ascii=False))
    if body.notes is not None:
        updates.append("notes = ?")
        params.append(body.notes)
    if body.z_index is not None:
        updates.append("z_index = ?")
        params.append(body.z_index)
    if body.status is not None:
        updates.append("status = ?")
        params.append(body.status)

    if not updates:
        raise HTTPException(400, "没有可更新字段")

    if body.start_sec is not None or body.end_sec is not None:
        existing = await _get_capsule_or_404(capsule_id)
        next_start = body.start_sec if body.start_sec is not None else float(existing.start_sec)
        next_end = body.end_sec if body.end_sec is not None else float(existing.end_sec)
        if next_end <= next_start:
            raise HTTPException(400, "end_sec 必须大于 start_sec")

    updates.append("updated_at = ?")
    params.append(datetime.now().isoformat(timespec='seconds'))
    params.append(capsule_id)

    await db.execute(
        f"UPDATE review_capsules SET {', '.join(updates)} WHERE id = ?",
        params,
    )
    await db.commit()

    return await _get_capsule_or_404(capsule_id)


@router.delete("/{capsule_id}")
async def delete_review_capsule(capsule_id: int):
    """删除胶囊草稿"""
    db = await get_db()
    cursor = await db.execute("DELETE FROM review_capsules WHERE id = ?", (capsule_id,))
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(404, "胶囊不存在")
    return {"ok": True}


@router.post("/reorder-z", response_model=list[ReviewCapsuleOut])
async def reorder_capsule_z(body: ReviewCapsuleReorderIn):
    """批量更新 z-index：{orders:[{id,z_index},...]}"""
    if not body.orders:
        raise HTTPException(400, "orders 不能为空")

    parsed = body.orders

    db = await get_db()
    now = datetime.now().isoformat(timespec='seconds')
    for item in parsed:
        await db.execute(
            "UPDATE review_capsules SET z_index = ?, updated_at = ? WHERE id = ?",
            (item.z_index, now, item.id),
        )
    await db.commit()

    ids = [item.id for item in parsed]
    placeholders = ", ".join(["?"] * len(ids))
    cursor = await db.execute(
        f"SELECT * FROM review_capsules WHERE id IN ({placeholders}) ORDER BY z_index ASC, id ASC",
        ids,
    )
    rows = await cursor.fetchall()
    return [_row_to_capsule_out(r) for r in rows]


async def _get_capsule_or_404(capsule_id: int) -> ReviewCapsuleOut:
    db = await get_db()
    cursor = await db.execute("SELECT * FROM review_capsules WHERE id = ?", (capsule_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "胶囊不存在")
    return _row_to_capsule_out(row)


def _row_to_capsule_out(row) -> ReviewCapsuleOut:
    return ReviewCapsuleOut(**dict(row))
