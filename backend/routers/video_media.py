"""视频流式播放 + 元数据 + 抽帧路由"""
import logging
import mimetypes
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse, FileResponse

from backend.config import STREAM_CHUNK_SIZE, FRAME_DIR
from backend.models import BatchFramesIn
from backend.database import get_db
from backend.services.video_service import get_video_metadata
from backend.services.ffmpeg_service import extract_frame, extract_frames_batch

logger = logging.getLogger(__name__)

router = APIRouter()


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

    if body.video_id is not None:
        db = await get_db()

        # 有 proxy 就优先从 proxy 抽帧（单文件，时间戳直接对应，速度快）
        cursor = await db.execute(
            "SELECT proxy_path, proxy_status, raw_path FROM video_registry WHERE id = ?",
            (body.video_id,),
        )
        reg = await cursor.fetchone()
        if not reg:
            raise HTTPException(404, f"视频记录不存在: {body.video_id}")

        proxy = reg["proxy_path"]
        if proxy and reg["proxy_status"] == "done" and Path(proxy).exists():
            # proxy 是拼接后的单文件，时间戳直接可用，无需段映射
            results = await extract_frames_batch(proxy, body.timestamps, body.w, body.h, video_id=body.video_id)
            return {"frames": [_frame_result_to_payload(r) for r in results]}

        # 无可用 proxy → 回退到 raw segments 抽帧
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
                seg_results = await extract_frames_batch(seg_path, local_ts_list, body.w, body.h, video_id=body.video_id)
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

        # 兼容旧数据：无 segments 也无 proxy → 用 registry 的 raw_path
        if not path:
            path = reg["raw_path"]

    if not path:
        raise HTTPException(400, "缺少 path 或 video_id 参数")
    if not Path(path).exists():
        raise HTTPException(404, f"文件不存在: {path}")

    results = await extract_frames_batch(path, body.timestamps, body.w, body.h, video_id=body.video_id)
    return {"frames": [_frame_result_to_payload(r) for r in results]}
