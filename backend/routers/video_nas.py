"""NAS 视频扫描 + 批量登记路由"""
import asyncio
import logging
import sqlite3
from pathlib import Path

from fastapi import APIRouter

from backend.database import get_db
from backend.services.video_service import get_video_metadata

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/scan")
async def scan_nas_videos():
    """扫描 NAS 目录，返回所有可登记的视频（不写入数据库）"""
    from backend.services.video_scanner import scan_video_directory

    results = await asyncio.to_thread(scan_video_directory)

    # 查已登记的，标记状态
    db = await get_db()
    cursor = await db.execute("SELECT session_date, session_label FROM video_registry")
    registered = {(r["session_date"], r["session_label"]) for r in await cursor.fetchall()}

    for r in results:
        r["registered"] = (r["session_date"], r["session_label"]) in registered
        segs = r["segments"]
        r["file_count"] = len(segs)
        r["main_file"] = segs[0]["path"] if segs else ""
        r["main_size_mb"] = round(segs[0]["size"] / 1024 / 1024, 1) if segs else 0
        r["total_size_mb"] = round(sum(s["size"] for s in segs) / 1024 / 1024, 1)
        # 不传完整文件列表给前端
        del r["segments"]

    return {
        "total": len(results),
        "registered": sum(1 for r in results if r["registered"]),
        "unregistered": sum(1 for r in results if not r["registered"]),
        "sessions": results,
    }


@router.post("/scan/register-all")
async def register_all_scanned():
    """一键登记所有未登记的视频 + 写入分段信息（扫描 NAS → 批量写入数据库）"""
    from backend.services.video_scanner import scan_video_directory
    from backend.services.ffmpeg_service import ffprobe_duration

    results = await asyncio.to_thread(scan_video_directory)
    db = await get_db()

    # 查已登记的
    cursor = await db.execute("SELECT session_date, session_label FROM video_registry")
    registered = {(r["session_date"], r["session_label"]) for r in await cursor.fetchall()}

    new_count = 0
    segments_count = 0
    skipped = 0
    errors: list[str] = []

    for r in results:
        key = (r["session_date"], r["session_label"])
        if key in registered:
            skipped += 1
            continue

        segs = r["segments"]
        if not segs:
            continue

        # 主文件 = 第一个分段（按播放顺序）
        main_seg = segs[0]
        raw_path = main_seg["path"]
        total_size = sum(s["size"] for s in segs)

        # 获取主文件元数据（分辨率等）
        try:
            meta = await get_video_metadata(raw_path)
        except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
            logger.warning("扫描登记读取元数据失败，回退默认值: path=%s err=%s", raw_path, exc)
            meta = {"duration_sec": 0, "width": 0, "height": 0, "file_size": total_size}

        notes = ""
        if len(segs) > 1:
            notes = f"共 {len(segs)} 个分段文件"

        try:
            # 写入 video_registry
            await db.execute("""
                INSERT INTO video_registry (session_date, session_label, raw_path,
                    duration_sec, width, height, file_size, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                r["session_date"], r["session_label"], raw_path,
                0,  # duration 后面由 ffprobe 逐段累加
                meta.get("width", 0), meta.get("height", 0), total_size, notes,
            ))

            # 获取刚插入的 video_id
            cursor = await db.execute(
                "SELECT id FROM video_registry WHERE session_date = ? AND session_label = ?",
                (r["session_date"], r["session_label"]),
            )
            row = await cursor.fetchone()
            video_id = row["id"]

            # 逐段 ffprobe 测时长，写入 video_segments
            cumulative_offset = 0.0
            for seg in segs:
                seg_path = seg["path"]
                if Path(seg_path).exists():
                    dur = await ffprobe_duration(seg_path)
                else:
                    dur = 0.0

                await db.execute("""
                    INSERT INTO video_segments (video_id, segment_index, raw_path,
                        offset_sec, duration_sec, file_size)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    video_id, seg["segment_index"], seg_path,
                    cumulative_offset, dur, seg["size"],
                ))
                cumulative_offset += dur
                segments_count += 1

            # 更新 registry 的总时长
            await db.execute(
                "UPDATE video_registry SET duration_sec = ? WHERE id = ?",
                (cumulative_offset, video_id),
            )

            new_count += 1
        except (sqlite3.Error, OSError, RuntimeError, ValueError) as exc:
            errors.append(f"{r['session_date']} {r['session_label']}: {exc}")
            logger.warning(
                "批量登记单条失败: date=%s label=%s err=%s",
                r["session_date"],
                r["session_label"],
                exc,
            )

    await db.commit()
    logger.info(
        f"批量登记: new={new_count}, segments={segments_count}, "
        f"skipped={skipped}, errors={len(errors)}"
    )
    return {
        "registered": new_count,
        "segments": segments_count,
        "skipped": skipped,
        "errors": errors[:20],
    }


@router.post("/scan/populate-segments")
async def populate_segments_for_existing():
    """为已登记但没有分段记录的视频补充 video_segments（用于已有数据迁移）"""
    from backend.services.video_scanner import scan_video_directory
    from backend.services.ffmpeg_service import ffprobe_duration

    results = await asyncio.to_thread(scan_video_directory)
    db = await get_db()

    # 查已登记的 → 检查哪些没有 segments
    cursor = await db.execute("SELECT id, session_date, session_label FROM video_registry")
    registry = {(r["session_date"], r["session_label"]): r["id"] for r in await cursor.fetchall()}

    cursor = await db.execute("SELECT DISTINCT video_id FROM video_segments")
    has_segments = {r["video_id"] for r in await cursor.fetchall()}

    # 构建 NAS 扫描结果索引
    scan_index = {(r["session_date"], r["session_label"]): r for r in results}

    populated = 0
    errors: list[str] = []

    for (date, label), video_id in registry.items():
        if video_id in has_segments:
            continue

        scan_result = scan_index.get((date, label))
        if not scan_result:
            continue

        segs = scan_result["segments"]
        if not segs:
            continue

        try:
            cumulative_offset = 0.0
            for seg in segs:
                seg_path = seg["path"]
                if Path(seg_path).exists():
                    dur = await ffprobe_duration(seg_path)
                else:
                    dur = 0.0

                await db.execute("""
                    INSERT OR IGNORE INTO video_segments (video_id, segment_index, raw_path,
                        offset_sec, duration_sec, file_size)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    video_id, seg["segment_index"], seg_path,
                    cumulative_offset, dur, seg["size"],
                ))
                cumulative_offset += dur

            # 更新总时长和主文件路径
            await db.execute(
                "UPDATE video_registry SET duration_sec = ?, raw_path = ? WHERE id = ?",
                (cumulative_offset, segs[0]["path"], video_id),
            )
            populated += 1
        except (sqlite3.Error, OSError, RuntimeError, ValueError) as exc:
            errors.append(f"{date} {label}: {exc}")
            logger.warning("补充分段失败: date=%s label=%s err=%s", date, label, exc)

    await db.commit()
    logger.info(f"补充分段: populated={populated}, errors={len(errors)}")
    return {"populated": populated, "errors": errors[:20]}
