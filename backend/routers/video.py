"""视频流/抽帧/登记路由"""
import asyncio
import logging
import mimetypes
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel

from backend.config import STREAM_CHUNK_SIZE, FRAME_DIR, PROXY_VIDEO_ROOT, DATA_DIR
from backend.models import BatchFramesIn
from backend.database import get_db
from backend.services.video_service import get_video_metadata
from backend.services.ffmpeg_service import extract_frame, extract_frames_batch, ffprobe_duration

logger = logging.getLogger(__name__)

router = APIRouter()
_proxy_jobs: set[int] = set()
_proxy_jobs_lock = asyncio.Lock()


def _pick_proxy_dir() -> Path:
    """优先使用配置目录，不可写时回退到项目 data/proxy"""
    candidates = [PROXY_VIDEO_ROOT / "proxy", DATA_DIR / "proxy"]
    for d in candidates:
        try:
            d.mkdir(parents=True, exist_ok=True)
            return d
        except Exception as e:
            logger.warning(f"代理目录不可用: {d}, err={e}")
    raise RuntimeError("无法创建代理目录，请检查 proxy_video_root 配置或磁盘挂载状态")


# ---- 视频登记 ----

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

    # 获取元数据
    try:
        meta = await get_video_metadata(body.raw_path)
    except Exception:
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
    except Exception:
        # UNIQUE 冲突 → 更新
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


@router.post("/registry/{video_id}/proxy")
async def generate_proxy_for_registered(video_id: int):
    """为已登记的视频生成代理文件（自动处理单文件/多段拼接）"""
    from backend.services.ffmpeg_service import generate_proxy, generate_concat_proxy

    db = await get_db()
    cursor = await db.execute("SELECT * FROM video_registry WHERE id = ?", (video_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "视频记录不存在")

    # 查分段
    cursor = await db.execute(
        "SELECT * FROM video_segments WHERE video_id = ? ORDER BY segment_index",
        (video_id,),
    )
    segments = [dict(r) for r in await cursor.fetchall()]

    await db.execute(
        "UPDATE video_registry SET proxy_status = 'generating' WHERE id = ?", (video_id,)
    )
    await db.commit()

    try:
        proxy_dir = _pick_proxy_dir()
        label = (row["session_label"] or "main").replace("/", "-").replace("\\", "-")
        proxy_name = f"{row['session_date']}_{label}.mp4"
        proxy_path = proxy_dir / proxy_name

        if len(segments) > 1:
            # 多段拼接 → concat demuxer + 转码
            seg_paths = [s["raw_path"] for s in segments]
            # 验证所有分段文件存在
            missing = [p for p in seg_paths if not Path(p).exists()]
            if missing:
                raise FileNotFoundError(f"分段文件缺失: {missing[:3]}")
            await generate_concat_proxy(seg_paths, str(proxy_path))
        elif segments:
            # 单段 → 直接转码
            raw_path = segments[0]["raw_path"]
            if not Path(raw_path).exists():
                raise FileNotFoundError(f"原始文件不存在: {raw_path}")
            await generate_proxy(raw_path, str(proxy_path))
        else:
            # 无分段记录 → 用 registry 的 raw_path（兼容旧数据）
            raw_path = row["raw_path"]
            if not Path(raw_path).exists():
                raise FileNotFoundError(f"原始文件不存在: {raw_path}")
            await generate_proxy(raw_path, str(proxy_path))

        await db.execute(
            "UPDATE video_registry SET proxy_path = ?, proxy_status = 'done' WHERE id = ?",
            (str(proxy_path), video_id),
        )
        await db.commit()
        return {"status": "done", "proxy_path": str(proxy_path)}
    except asyncio.CancelledError:
        await db.execute(
            "UPDATE video_registry SET proxy_status = 'failed' WHERE id = ?", (video_id,)
        )
        await db.commit()
        raise
    except Exception as e:
        await db.execute(
            "UPDATE video_registry SET proxy_status = 'failed' WHERE id = ?", (video_id,)
        )
        await db.commit()
        raise HTTPException(500, f"代理生成失败: {e}")


class BatchProxyIn(BaseModel):
    video_ids: list[int] = []
    all_pending: bool = False


@router.post("/proxy/batch")
async def batch_generate_proxy(body: BatchProxyIn):
    """批量生成代理（后台任务，返回排队信息）"""
    db = await get_db()

    if body.all_pending:
        # 所有没有代理的视频
        cursor = await db.execute(
            "SELECT id FROM video_registry WHERE proxy_status IN ('none', 'failed') ORDER BY session_date DESC"
        )
        video_ids = [r["id"] for r in await cursor.fetchall()]
    else:
        video_ids = body.video_ids

    # 去重，避免同一个 video_id 启动多个并发 ffmpeg 互相覆盖输出
    dedup_ids = list(dict.fromkeys(video_ids))
    if not dedup_ids:
        return {"queued": 0, "video_ids": []}

    # 跳过已完成，其他标记为排队
    queued_ids: list[int] = []
    for vid in dedup_ids:
        cursor = await db.execute("SELECT proxy_status FROM video_registry WHERE id = ?", (vid,))
        row = await cursor.fetchone()
        if not row:
            continue
        if row["proxy_status"] == "done":
            continue
        await db.execute(
            "UPDATE video_registry SET proxy_status = 'queued' WHERE id = ?", (vid,)
        )
        queued_ids.append(vid)
    await db.commit()

    if not queued_ids:
        return {"queued": 0, "video_ids": []}

    # 后台逐个生成
    asyncio.create_task(_batch_proxy_worker(queued_ids))

    return {"queued": len(queued_ids), "video_ids": queued_ids}


async def _batch_proxy_worker(video_ids: list[int]) -> None:
    """后台逐个生成代理文件"""
    for vid in video_ids:
        async with _proxy_jobs_lock:
            if vid in _proxy_jobs:
                logger.info(f"代理任务已在执行，跳过重复排队: video_id={vid}")
                continue
            _proxy_jobs.add(vid)
        try:
            # 调用单个代理生成（复用已有逻辑）
            await generate_proxy_for_registered(vid)
            logger.info(f"代理生成完成: video_id={vid}")
        except asyncio.CancelledError:
            logger.warning(f"代理任务被取消: video_id={vid}")
            try:
                db = await get_db()
                await db.execute(
                    "UPDATE video_registry SET proxy_status = 'failed' WHERE id = ?", (vid,)
                )
                await db.commit()
            except Exception:
                pass
            raise
        except Exception as e:
            logger.error(f"代理生成失败: video_id={vid}, {e}")
        finally:
            async with _proxy_jobs_lock:
                _proxy_jobs.discard(vid)
        # 每个文件之间短暂间隔，避免 IO 过载
        await asyncio.sleep(1)


@router.get("/proxy/status")
async def proxy_status():
    """查看所有视频的代理生成状态汇总"""
    db = await get_db()
    cursor = await db.execute("""
        SELECT proxy_status, COUNT(*) as cnt
        FROM video_registry
        GROUP BY proxy_status
    """)
    rows = await cursor.fetchall()
    status_map = {r["proxy_status"]: r["cnt"] for r in rows}
    return {
        "total": sum(status_map.values()),
        "none": status_map.get("none", 0),
        "queued": status_map.get("queued", 0),
        "generating": status_map.get("generating", 0),
        "done": status_map.get("done", 0),
        "failed": status_map.get("failed", 0),
    }


@router.post("/proxy/scan")
async def scan_proxy_directory():
    """扫描代理目录，自动匹配 video_registry 并更新 proxy_path

    代理文件命名规则: {session_date}_{session_label}.mp4
    例如: 2025-01-01_大号.mp4 → 匹配 session_date=2025-01-01, session_label=大号
    """
    scan_dirs = [
        PROXY_VIDEO_ROOT / "proxy",
        DATA_DIR / "proxy",
        Path("/Volumes/切片/proxy"),
    ]
    existing_dirs = [d for d in scan_dirs if d.exists()]
    if not existing_dirs:
        return {"matched": 0, "unmatched": [], "message": "代理目录不存在"}

    db = await get_db()
    matched = 0
    already = 0
    unmatched: list[str] = []

    for proxy_dir in existing_dirs:
        for f in sorted(proxy_dir.iterdir()):
            if not f.is_file() or f.suffix.lower() != ".mp4":
                continue
            if f.name.startswith("_") or f.name.startswith("."):
                continue

            stem = f.stem  # e.g. "2025-01-01_大号"
            parts = stem.split("_", 1)
            if len(parts) == 2:
                date_str, label = parts[0], parts[1]
            elif len(parts) == 1:
                date_str, label = parts[0], ""
            else:
                unmatched.append(f.name)
                continue

            # "main" 标签在数据库中是空字符串
            if label == "main":
                label = ""

            # 查找匹配的 registry 记录
            cursor = await db.execute(
                """
                SELECT id, proxy_status, duration_sec, proxy_path
                FROM video_registry
                WHERE session_date = ? AND session_label = ?
                """,
                (date_str, label),
            )
            row = await cursor.fetchone()
            if not row:
                unmatched.append(f.name)
                continue

            expected_dur = float(row["duration_sec"] or 0)
            actual_dur = await ffprobe_duration(str(f))
            # 代理时长明显偏短（常见于任务中断），不要标记为 done
            if expected_dur > 0 and actual_dur > 0 and actual_dur < expected_dur * 0.85:
                await db.execute(
                    "UPDATE video_registry SET proxy_status = 'failed', proxy_path = NULL WHERE id = ?",
                    (row["id"],),
                )
                unmatched.append(f"{f.name}(incomplete:{round(actual_dur, 1)}s/{round(expected_dur, 1)}s)")
                continue

            if row["proxy_status"] == "done" and row["proxy_path"] == str(f):
                already += 1
                continue

            # 更新数据库
            await db.execute(
                "UPDATE video_registry SET proxy_path = ?, proxy_status = 'done' WHERE id = ?",
                (str(f), row["id"]),
            )
            matched += 1

    await db.commit()
    logger.info(f"代理扫描: matched={matched}, already={already}, unmatched={len(unmatched)}")
    return {
        "matched": matched,
        "already_done": already,
        "unmatched": unmatched[:30],
    }


# ---- NAS 自动扫描 ----

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
        except Exception:
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
        except Exception as e:
            errors.append(f"{r['session_date']} {r['session_label']}: {e}")

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
        except Exception as e:
            errors.append(f"{date} {label}: {e}")

    await db.commit()
    logger.info(f"补充分段: populated={populated}, errors={len(errors)}")
    return {"populated": populated, "errors": errors[:20]}


# ---- 时间戳 → 原始分段映射 ----

@router.get("/registry/{video_id}/resolve-timestamp")
async def resolve_timestamp(video_id: int, t: float = 0):
    """将代理时间戳映射回原始分段文件 + 本地偏移

    对于跨段的区间，前端需传入 start/end 两次调用。
    返回: { segment_index, raw_path, local_sec, duration_sec }
    """
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM video_segments WHERE video_id = ? ORDER BY segment_index",
        (video_id,),
    )
    segments = [dict(r) for r in await cursor.fetchall()]

    if not segments:
        # 无分段记录 → 兼容旧数据，直接用 registry 的 raw_path
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

    # 二分查找所属分段
    for seg in segments:
        seg_end = seg["offset_sec"] + seg["duration_sec"]
        if t < seg_end or seg["segment_index"] == segments[-1]["segment_index"]:
            local_sec = t - seg["offset_sec"]
            # 确保不越界
            local_sec = max(0, min(local_sec, seg["duration_sec"]))
            return {
                "segment_index": seg["segment_index"],
                "raw_path": seg["raw_path"],
                "local_sec": round(local_sec, 3),
                "duration_sec": seg["duration_sec"],
            }

    # 不应到达这里
    last = segments[-1]
    return {
        "segment_index": last["segment_index"],
        "raw_path": last["raw_path"],
        "local_sec": round(t - last["offset_sec"], 3),
        "duration_sec": last["duration_sec"],
    }


@router.get("/registry/{video_id}/resolve-range")
async def resolve_range(video_id: int, start: float = 0, end: float = 0):
    """将代理时间区间映射为原始分段裁切指令

    返回: { cuts: [{ segment_index, raw_path, local_start, local_end }] }
    用于导出时 ffmpeg 精确裁切。跨段区间返回多个 cut。
    """
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

        # 判断区间是否与该分段重叠
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


# ---- 流式播放 ----

@router.get("/stream")
async def stream_video(request: Request, path: str = ""):
    """HTTP Range 流式播放"""
    if not path:
        raise HTTPException(400, "缺少 path 参数")

    file_path = Path(path)
    if not file_path.exists():
        raise HTTPException(404, f"文件不存在: {path}")

    media_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    if file_path.suffix.lower() == ".ts":
        media_type = "video/mp2t"
    elif file_path.suffix.lower() == ".mkv":
        media_type = "video/x-matroska"
    elif file_path.suffix.lower() == ".flv":
        media_type = "video/x-flv"

    file_size = file_path.stat().st_size
    range_header = request.headers.get("range")

    if range_header:
        range_str = range_header.replace("bytes=", "")
        parts = range_str.split("-")
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if parts[1] else min(start + STREAM_CHUNK_SIZE, file_size) - 1
        end = min(end, file_size - 1)
        length = end - start + 1

        def iter_range():
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(STREAM_CHUNK_SIZE, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(
            iter_range(),
            status_code=206,
            media_type=media_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(length),
            },
        )
    else:
        def iter_file():
            with open(file_path, "rb") as f:
                while chunk := f.read(STREAM_CHUNK_SIZE):
                    yield chunk

        return StreamingResponse(
            iter_file(),
            media_type=media_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
            },
        )


# ---- 元数据 / 抽帧 ----

@router.get("/meta")
async def video_meta(path: str = ""):
    if not path:
        raise HTTPException(400, "缺少 path 参数")
    try:
        meta = await get_video_metadata(path)
        return {"video_path": path, **meta}
    except FileNotFoundError:
        raise HTTPException(404, f"文件不存在: {path}")


@router.get("/frame")
async def single_frame(path: str = "", t: float = 0, w: int = 180, h: int = 320):
    if not path:
        raise HTTPException(400, "缺少 path 参数")
    if not Path(path).exists():
        raise HTTPException(404, f"文件不存在: {path}")
    try:
        frame_path = await extract_frame(path, t, w, h)
        return FileResponse(frame_path, media_type="image/jpeg")
    except RuntimeError as e:
        raise HTTPException(500, str(e))


def _resolve_segment_local_ts(segments: list[dict], timestamp: float) -> tuple[str, float]:
    """将代理时间戳映射到分段文件和分段内时间戳"""
    if not segments:
        raise ValueError("segments 为空")

    for i, seg in enumerate(segments):
        seg_start = float(seg.get("offset_sec", 0) or 0)
        seg_dur = float(seg.get("duration_sec", 0) or 0)
        seg_end = seg_start + seg_dur
        is_last = i == len(segments) - 1

        if (seg_dur > 0 and timestamp < seg_end) or is_last:
            local = max(0.0, timestamp - seg_start)
            if seg_dur > 0:
                local = min(local, seg_dur)
            return str(seg["raw_path"]), round(local, 3)

    last = segments[-1]
    seg_start = float(last.get("offset_sec", 0) or 0)
    return str(last["raw_path"]), round(max(0.0, timestamp - seg_start), 3)


def _frame_result_to_payload(result: dict) -> dict:
    if result.get("path"):
        rel = os.path.relpath(result["path"], FRAME_DIR.parent)
        return {"timestamp": result["timestamp"], "url": f"/data/{rel}"}
    return {"timestamp": result["timestamp"], "url": "", "error": result.get("error", "")}


@router.post("/frames")
async def batch_frames(body: BatchFramesIn):
    path = body.path

    # 优先支持按 video_id + video_segments 抽帧（多段视频场景）
    if body.video_id is not None:
        db = await get_db()
        cursor = await db.execute(
            "SELECT segment_index, raw_path, offset_sec, duration_sec "
            "FROM video_segments WHERE video_id = ? ORDER BY segment_index",
            (body.video_id,),
        )
        segments = [dict(r) for r in await cursor.fetchall()]

        if segments:
            grouped: dict[str, list[tuple[int, float, float]]] = {}
            for idx, ts_raw in enumerate(body.timestamps):
                ts = float(ts_raw)
                seg_path, local_ts = _resolve_segment_local_ts(segments, ts)
                grouped.setdefault(seg_path, []).append((idx, ts, local_ts))

            out: list[dict | None] = [None] * len(body.timestamps)
            for seg_path, items in grouped.items():
                if not Path(seg_path).exists():
                    for idx, ts, _ in items:
                        out[idx] = {"timestamp": ts, "url": "", "error": f"文件不存在: {seg_path}"}
                    continue

                local_ts_list = [it[2] for it in items]
                seg_results = await extract_frames_batch(seg_path, local_ts_list, body.w, body.h)
                for (idx, global_ts, _), r in zip(items, seg_results):
                    payload = _frame_result_to_payload({
                        "timestamp": global_ts,
                        "path": r.get("path", ""),
                        "error": r.get("error", ""),
                    })
                    out[idx] = payload

            frames = [
                item if item is not None else {"timestamp": float(body.timestamps[i]), "url": "", "error": "分段映射失败"}
                for i, item in enumerate(out)
            ]
            return {"frames": frames}

        # 兼容旧数据：无 segments 时尝试从 registry 回退 raw_path
        if not path:
            cursor = await db.execute("SELECT raw_path FROM video_registry WHERE id = ?", (body.video_id,))
            row = await cursor.fetchone()
            if row:
                path = row["raw_path"]
            else:
                raise HTTPException(404, f"视频记录不存在: {body.video_id}")

    if not path:
        raise HTTPException(400, "缺少 path 或 video_id 参数")
    if not Path(path).exists():
        raise HTTPException(404, f"文件不存在: {path}")

    results = await extract_frames_batch(path, body.timestamps, body.w, body.h)
    return {"frames": [_frame_result_to_payload(r) for r in results]}


# ---- CLIP 以图找图 ----

class ClipSearchIn(BaseModel):
    sku_image_path: str      # 商品图路径（相对或绝对）
    video_path: str          # 视频文件路径
    video_duration: float    # 视频总时长（秒）
    sample_interval: float = 30.0  # 采样间隔（秒）
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
