"""视频代理相关路由"""
import asyncio
import logging
import sqlite3
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import DATA_DIR, PROXY_VIDEO_ROOT
from backend.database import get_db
from backend.services.ffmpeg_service import ffprobe_duration

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
        except OSError as e:
            logger.warning(f"代理目录不可用: {d}, err={e}")
    raise RuntimeError("无法创建代理目录，请检查 proxy_video_root 配置或磁盘挂载状态")


@router.post("/registry/{video_id}/proxy")
async def generate_proxy_for_registered(video_id: int):
    """为已登记的视频生成代理文件（自动处理单文件/多段拼接）"""
    from backend.services.ffmpeg_service import generate_proxy, generate_concat_proxy

    db = await get_db()
    cursor = await db.execute("SELECT * FROM video_registry WHERE id = ?", (video_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "视频记录不存在")

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
            seg_paths = [s["raw_path"] for s in segments]
            missing = [p for p in seg_paths if not Path(p).exists()]
            if missing:
                raise FileNotFoundError(f"分段文件缺失: {missing[:3]}")
            await generate_concat_proxy(seg_paths, str(proxy_path))
        elif segments:
            raw_path = segments[0]["raw_path"]
            if not Path(raw_path).exists():
                raise FileNotFoundError(f"原始文件不存在: {raw_path}")
            await generate_proxy(raw_path, str(proxy_path))
        else:
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
    except FileNotFoundError as exc:
        await db.execute(
            "UPDATE video_registry SET proxy_status = 'failed' WHERE id = ?", (video_id,)
        )
        await db.commit()
        raise HTTPException(404, str(exc))
    except (OSError, RuntimeError, ValueError) as exc:
        await db.execute(
            "UPDATE video_registry SET proxy_status = 'failed' WHERE id = ?", (video_id,)
        )
        await db.commit()
        raise HTTPException(500, f"代理生成失败: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        await db.execute(
            "UPDATE video_registry SET proxy_status = 'failed' WHERE id = ?", (video_id,)
        )
        await db.commit()
        logger.exception("代理生成未知失败: video_id=%s", video_id)
        raise HTTPException(500, "代理生成失败，请查看服务日志") from exc


class BatchProxyIn(BaseModel):
    video_ids: list[int] = []
    all_pending: bool = False


@router.post("/proxy/batch")
async def batch_generate_proxy(body: BatchProxyIn):
    """批量生成代理（后台任务，返回排队信息）"""
    db = await get_db()

    if body.all_pending:
        cursor = await db.execute(
            "SELECT id FROM video_registry WHERE proxy_status IN ('none', 'failed') ORDER BY session_date DESC"
        )
        video_ids = [r["id"] for r in await cursor.fetchall()]
    else:
        video_ids = body.video_ids

    dedup_ids = list(dict.fromkeys(video_ids))
    if not dedup_ids:
        return {"queued": 0, "video_ids": []}

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
            except sqlite3.Error as exc:
                logger.warning(f"更新取消状态失败: video_id={vid}, err={exc}")
            raise
        except (HTTPException, OSError, RuntimeError, ValueError) as exc:
            logger.error(f"代理生成失败: video_id={vid}, {exc}")
        except Exception:  # noqa: BLE001
            logger.exception("代理生成未知失败: video_id=%s", vid)
        finally:
            async with _proxy_jobs_lock:
                _proxy_jobs.discard(vid)
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
    """扫描代理目录，自动匹配 video_registry 并更新 proxy_path"""
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

            stem = f.stem
            parts = stem.split("_", 1)
            if len(parts) == 2:
                date_str, label = parts[0], parts[1]
            elif len(parts) == 1:
                date_str, label = parts[0], ""
            else:
                unmatched.append(f.name)
                continue

            if label == "main":
                label = ""

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
