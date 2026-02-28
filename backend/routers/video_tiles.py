"""Tile 批抽帧 API — 替代逐帧 /api/video/frames 的新抽帧链路

提供两种模式：
1. POST /tiles       — 同步请求，等待 Tile 完成后返回全部帧
2. POST /tiles/async — 异步请求，立即返回 task_id
3. POST /tiles/stream — SSE 流式推送，逐帧通知就绪
4. GET  /tiles/stats  — 调度器状态
"""
import asyncio
import json
import logging
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.database import get_db
from backend.models import TileRequestIn
from backend.services.tile_extractor import (
    SegmentInfo,
    TileSpec,
    tile_cache_check,
)
from backend.services.tile_scheduler import (
    Priority,
    ensure_scheduler_started,
    get_scheduler,
)
from backend.services.p2_spike_metrics import (
    TileEvent,
    get_observer,
    is_spike_enabled,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _spike_observe(event_type: str, video_id: int, cache_key: str,
                   priority: int = 1, elapsed_ms: float = 0.0, error: str = "") -> None:
    """P2 spike 影子观测 — 路由层补充（覆盖 segmented/cached 路径）"""
    try:
        if not is_spike_enabled():
            return
        import time
        get_observer().record(TileEvent(
            timestamp=time.monotonic(),
            event_type=event_type,
            task_id="router",
            video_id=video_id,
            cache_key=cache_key,
            priority=priority,
            elapsed_ms=elapsed_ms,
            error=error,
        ))
    except Exception:
        pass


@dataclass
class VideoInfo:
    """视频路径解析结果"""
    video_path: str  # proxy/raw 单文件路径（跨段时为首段路径，仅用于 cache key）
    proxy_version: int
    segments: list[SegmentInfo] | None = None  # 非 None 表示需要跨段抽帧


async def _resolve_video_info(video_id: int) -> VideoInfo:
    """从 DB 解析视频路径，支持 proxy / 单文件 / 多段回退"""
    db = await get_db()
    cursor = await db.execute(
        "SELECT proxy_path, proxy_status, raw_path, "
        "COALESCE(proxy_version, 1) as proxy_version "
        "FROM video_registry WHERE id = ?",
        (video_id,),
    )
    reg = await cursor.fetchone()
    if not reg:
        raise HTTPException(404, f"视频记录不存在: {video_id}")

    pv = int(reg["proxy_version"])

    # 1. 优先使用 proxy（已拼接的单文件）
    proxy = reg["proxy_path"]
    if proxy and reg["proxy_status"] == "done" and Path(proxy).exists():
        return VideoInfo(video_path=proxy, proxy_version=pv)

    # 2. 查 video_segments（跨段场景）
    seg_cursor = await db.execute(
        "SELECT raw_path, offset_sec, duration_sec "
        "FROM video_segments WHERE video_id = ? ORDER BY segment_index",
        (video_id,),
    )
    seg_rows = await seg_cursor.fetchall()

    if seg_rows and len(seg_rows) > 1:
        # 多段视频 — 检查文件是否可访问
        segments = []
        for row in seg_rows:
            rp = row["raw_path"]
            if Path(rp).exists():
                segments.append(SegmentInfo(
                    raw_path=rp,
                    offset_sec=float(row["offset_sec"]),
                    duration_sec=float(row["duration_sec"]),
                ))
        if segments:
            return VideoInfo(
                video_path=segments[0].raw_path,  # cache key 用首段路径
                proxy_version=pv,
                segments=segments,
            )

    # 3. 单段或无段 — 回退到 raw_path
    if seg_rows and len(seg_rows) == 1:
        rp = seg_rows[0]["raw_path"]
        if Path(rp).exists():
            return VideoInfo(video_path=rp, proxy_version=pv)

    raw = reg["raw_path"]
    if raw and Path(raw).exists():
        return VideoInfo(video_path=raw, proxy_version=pv)

    raise HTTPException(404, f"视频文件不可用: {video_id}")


def _build_spec(body: TileRequestIn, info: VideoInfo) -> TileSpec:
    return TileSpec(
        video_id=body.video_id,
        video_path=info.video_path,
        start_sec=body.start_sec,
        end_sec=body.end_sec,
        interval=body.interval,
        width=body.w,
        height=body.h,
        proxy_version=info.proxy_version,
    )


@router.post("/tiles")
async def request_tile(body: TileRequestIn):
    """同步 Tile 请求 — 等待完成后返回所有帧

    适用于非交互场景或已缓存的请求。
    """
    info = await _resolve_video_info(body.video_id)
    spec = _build_spec(body, info)

    # 先检查缓存
    cached = tile_cache_check(spec)
    if cached:
        _spike_observe("cache_hit", spec.video_id, spec.cache_key, body.priority)
        return {
            "task_id": "cache_hit",
            "status": "complete",
            "frames": cached.frames,
            "frame_count": len(cached.frames),
            "elapsed_ms": cached.elapsed_ms,
        }

    # 统一走调度器（单文件 + 跨段）
    scheduler = await ensure_scheduler_started()
    priority = Priority(min(body.priority, 2))
    task = await scheduler.submit(spec, priority, segments=info.segments)

    try:
        result = await asyncio.wait_for(task.future, timeout=30.0)
    except asyncio.TimeoutError:
        raise HTTPException(504, "Tile 抽取超时 (30s)")

    if result.error:
        raise HTTPException(500, f"Tile 抽取失败: {result.error}")

    return {
        "task_id": task.task_id,
        "status": "complete",
        "frames": result.frames,
        "frame_count": len(result.frames),
        "elapsed_ms": result.elapsed_ms,
    }


@router.post("/tiles/async")
async def request_tile_async(body: TileRequestIn):
    """异步 Tile 请求 — 立即返回 task_id，通过 SSE 获取进度"""
    info = await _resolve_video_info(body.video_id)
    spec = _build_spec(body, info)

    scheduler = await ensure_scheduler_started()
    priority = Priority(min(body.priority, 2))
    task = await scheduler.submit(spec, priority, segments=info.segments)

    return {
        "task_id": task.task_id,
        "status": "queued",
        "spec": {
            "video_id": spec.video_id,
            "start_sec": spec.start_sec,
            "end_sec": spec.end_sec,
            "interval": spec.interval,
            "expected_frames": spec.expected_frame_count,
        },
    }


@router.post("/tiles/stream")
async def request_tile_stream(body: TileRequestIn):
    """SSE 流式 Tile 请求 — 每帧就绪立即推送

    响应格式: text/event-stream
    事件类型:
      - frame: 单帧就绪 {timestamp, url}
      - complete: 全部完成 {frame_count, elapsed_ms}
      - error: 失败 {message}
    """
    info = await _resolve_video_info(body.video_id)
    spec = _build_spec(body, info)

    # 统一走调度器（含缓存命中），逐帧写入 frame_queue
    frame_queue: asyncio.Queue = asyncio.Queue()
    scheduler = await ensure_scheduler_started()
    priority = Priority(min(body.priority, 2))
    await scheduler.submit(
        spec,
        priority,
        on_frame_ready=frame_queue,
        segments=info.segments,
    )

    async def sse_generator():
        """SSE 事件生成器"""
        frame_count = 0
        t0 = asyncio.get_event_loop().time()

        try:
            while True:
                try:
                    item = await asyncio.wait_for(frame_queue.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    yield f"event: error\ndata: {json.dumps({'message': 'timeout'})}\n\n"
                    break

                if item is None:
                    elapsed = (asyncio.get_event_loop().time() - t0) * 1000
                    yield f"event: complete\ndata: {json.dumps({'frame_count': frame_count, 'elapsed_ms': round(elapsed, 1)})}\n\n"
                    break

                frame_count += 1
                yield f"event: frame\ndata: {json.dumps(item)}\n\n"

        except asyncio.CancelledError:
            raise
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

    return StreamingResponse(sse_generator(), media_type="text/event-stream")


class _WarmIn(BaseModel):
    video_id: int
    # 可选：调用方给出全局时间点（秒）用于定向 seek 预热
    tier_hints: list[float] | None = None


# 已预热的文件路径缓存（进程级，避免重复 I/O）
_warmed_paths: set[str] = set()


@router.post("/tiles/warm")
async def warm_video_files(body: _WarmIn):
    """NAS 文件预热 — 提前暖 SMB 缓存以消除冷启动首帧尖峰

    调用时机: 前端进入视频审核页面选中场次时立即调用（Codex 方案A）。
    策略（两阶段）:
      1) ffprobe 暖元数据（moov atom + stream info）
      2) 多点 null-decode 探针暖文件中段的 seek 字节范围
         （在 10%/25%/50%/75% 时长处各跑一个 ffmpeg -frames:v 1 -f null -）
    后续 ffmpeg 打开同一文件时直接命中 OS VFS 缓存，无 SMB 往返延迟。
    """
    info = await _resolve_video_info(body.video_id)

    paths: list[str] = []
    if info.segments:
        paths = [seg.raw_path for seg in info.segments]
    elif info.video_path:
        paths = [info.video_path]

    cold = [p for p in paths if p not in _warmed_paths]
    if not cold:
        return {"status": "warm", "video_id": body.video_id, "files_warmed": 0}

    # path -> 定向预热位置（局部秒）
    hint_map: dict[str, list[float]] = {}
    if body.tier_hints:
        if info.segments:
            for sec in body.tier_hints:
                for seg in info.segments:
                    seg_end = seg.offset_sec + seg.duration_sec
                    if seg.offset_sec <= sec < seg_end:
                        local = sec - seg.offset_sec
                        # 单点 + 邻域（±45s）提高 keyframe 附近 warm 命中率
                        hint_map.setdefault(seg.raw_path, []).extend([local - 45, local, local + 45])
                        break
        elif info.video_path:
            local_hints: list[float] = []
            for sec in body.tier_hints:
                local_hints.extend([float(sec) - 45, float(sec), float(sec) + 45])
            hint_map[info.video_path] = local_hints

    async def _probe_seek(path: str, pos: float):
        """快速单帧 decode+scale — 暖目标位置的 SMB 字节缓存"""
        try:
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg", "-y", "-ss", f"{pos:.1f}", "-i", path,
                "-frames:v", "1", "-vf", "scale=180:320",
                "-f", "image2pipe", "-vcodec", "mjpeg", "-",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.wait(), timeout=8.0)
        except Exception:
            pass

    async def _warm_one(path: str, local_hints: list[float] | None = None):
        """两阶段预热: ffprobe 暖元数据 → 多点探针暖 seek 字节范围"""
        try:
            # 阶段 1: ffprobe 暖元数据（moov + stream info）
            proc = await asyncio.create_subprocess_exec(
                "ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_format", "-show_streams", path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10.0)

            # 阶段 2: 解析时长，多点探针预热 seek 位置
            duration = 0.0
            try:
                ffprobe_info = json.loads(stdout)
                duration = float(ffprobe_info.get("format", {}).get("duration", 0))
            except (json.JSONDecodeError, ValueError, TypeError):
                pass

            probes: list[float] = []
            if duration > 120:
                # 基础覆盖点：补充 5% 以提升中前段 cold seek 命中率
                probes.extend([duration * p for p in (0.05, 0.10, 0.25, 0.50, 0.75)])

            # 合并调用方给的定向 hint（例如 gate 的 600/2000/3000）
            if local_hints:
                probes.extend([float(p) for p in local_hints if p >= 0])

            # 去重并裁剪范围，避免无效探针
            if duration > 0 and probes:
                uniq: list[float] = []
                seen = set()
                for p in probes:
                    q = round(max(0.0, min(p, max(0.0, duration - 0.1))), 1)
                    if q not in seen:
                        seen.add(q)
                        uniq.append(q)
                probes = uniq

            if probes:
                await asyncio.gather(
                    *[_probe_seek(path, pos) for pos in probes],
                    return_exceptions=True,
                )

            _warmed_paths.add(path)
        except Exception:
            pass

    await asyncio.gather(
        *[_warm_one(p, hint_map.get(p)) for p in cold],
        return_exceptions=True,
    )
    return {"status": "warm", "video_id": body.video_id, "files_warmed": len(cold)}


@router.get("/tiles/stats")
async def tile_stats():
    """调度器状态"""
    scheduler = get_scheduler()
    return scheduler.get_stats()
