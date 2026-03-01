"""Tile 批抽帧引擎 — 单 ffmpeg 进程输出整个时间范围的帧序列

替代 extract_frames_batch 的逐帧子进程模型：
  旧: 120 帧 → 120 个 ffmpeg → 6-12s
  新: 120 帧 → 1 个 ffmpeg  → 1-2s
"""
import asyncio
import json
import logging
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from backend.config import FRAME_DIR

logger = logging.getLogger(__name__)

# 全局 Tile 并发信号量（限制同时运行的 ffmpeg 进程数）
_TILE_SEMAPHORE = asyncio.Semaphore(3)


@dataclass
class SegmentInfo:
    """视频段信息（用于跨段抽帧）"""
    raw_path: str
    offset_sec: float
    duration_sec: float


@dataclass
class TileSpec:
    """一个 Tile 的规格定义"""
    video_id: int
    video_path: str
    start_sec: float
    end_sec: float
    interval: float  # 帧间隔（秒）
    width: int = 90
    height: int = 160
    proxy_version: int = 1

    @property
    def duration(self) -> float:
        return max(0, self.end_sec - self.start_sec)

    @property
    def expected_frame_count(self) -> int:
        if self.interval <= 0:
            return 0
        return max(1, int(self.duration / self.interval) + 1)

    @property
    def cache_key(self) -> str:
        """缓存目录名：v{id}/L_{start}_{end}_{interval}_{w}x{h}_pv{ver}"""
        return (
            f"v{self.video_id}/"
            f"t_{self.start_sec:.1f}_{self.end_sec:.1f}"
            f"_{self.interval:.1f}_{self.width}x{self.height}"
            f"_pv{self.proxy_version}"
        )


@dataclass
class TileResult:
    """Tile 抽取结果"""
    spec: TileSpec
    frames: list[dict] = field(default_factory=list)  # [{timestamp, path, url}]
    complete: bool = False
    error: str = ""
    elapsed_ms: float = 0


def _tile_dir(spec: TileSpec) -> Path:
    """Tile 缓存目录"""
    return FRAME_DIR / "tiles" / spec.cache_key


def _tile_manifest_path(spec: TileSpec) -> Path:
    return _tile_dir(spec) / "manifest.json"


def tile_cache_check(spec: TileSpec) -> TileResult | None:
    """检查 Tile 缓存是否完整命中，返回 TileResult 或 None"""
    manifest_path = _tile_manifest_path(spec)
    if not manifest_path.exists():
        return None

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None

    if not manifest.get("complete"):
        return None

    tile_dir = _tile_dir(spec)
    frames = []
    for entry in manifest.get("frames", []):
        ts = entry["timestamp"]
        fname = entry["filename"]
        fpath = tile_dir / fname
        if not fpath.exists():
            return None  # 帧文件丢失，缓存无效
        rel = os.path.relpath(str(fpath), str(FRAME_DIR.parent))
        frames.append({"timestamp": ts, "path": str(fpath), "url": f"/data/{rel}"})

    return TileResult(spec=spec, frames=frames, complete=True)


async def _extract_scout_frame(spec: TileSpec) -> dict | None:
    """先行帧保底通道 — 不走 _TILE_SEMAPHORE，单帧快速提取

    用 ffmpeg -frames:v 1 只解码一帧，目标延迟 < 200ms。
    产物存入 Tile 缓存目录外的 scout 临时路径。
    """
    import math
    # 对齐到前端 generateTimestamps 的网格
    first_ts = math.ceil(spec.start_sec / spec.interval) * spec.interval
    first_ts = round(first_ts, 1)
    if first_ts > spec.end_sec:
        return None

    scout_dir = FRAME_DIR / "tiles" / "scouts"
    scout_dir.mkdir(parents=True, exist_ok=True)
    output_path = scout_dir / f"v{spec.video_id}_{first_ts:.1f}_{spec.width}x{spec.height}_pv{spec.proxy_version}.jpg"

    cmd = [
        'ffmpeg', '-y',
        '-ss', f'{first_ts:.3f}',
        '-i', spec.video_path,
        '-frames:v', '1',
        '-vf', f'scale={spec.width}:{spec.height}:force_original_aspect_ratio=decrease',
        '-q:v', '5',
        str(output_path),
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, _ = await proc.communicate()
        if proc.returncode != 0 or not output_path.exists() or output_path.stat().st_size == 0:
            return None
    except Exception:
        return None

    rel = os.path.relpath(str(output_path), str(FRAME_DIR.parent))
    return {"timestamp": first_ts, "path": str(output_path), "url": f"/data/{rel}"}


async def extract_tile(
    spec: TileSpec,
    on_frame_ready: asyncio.Queue | None = None,
) -> TileResult:
    """抽取一个 Tile：单 ffmpeg 进程批量输出帧

    Args:
        spec: Tile 规格
        on_frame_ready: 可选队列，每个帧落盘后立即推入 (用于 SSE 流式推送)
            当提供此参数时，先行帧保底通道自动启用：
            在 Tile 主提取（受信号量限制）之前，用独立 ffmpeg 快速抽取第一帧。
    """
    t0 = time.monotonic()

    # 缓存命中？
    cached = tile_cache_check(spec)
    if cached:
        cached.elapsed_ms = (time.monotonic() - t0) * 1000
        if on_frame_ready:
            for f in cached.frames:
                await on_frame_ready.put(f)
            await on_frame_ready.put(None)  # 完成信号
        return cached

    # --- 先行帧保底通道（不走信号量，与 Tile 主提取并行） ---
    scout_sent: set[float] = set()
    scout_task: asyncio.Task | None = None
    if on_frame_ready:
        async def _scout_and_push():
            scout = await _extract_scout_frame(spec)
            if scout:
                scout_sent.add(scout["timestamp"])
                await on_frame_ready.put(scout)
                logger.debug("Scout 先行帧已推送: ts=%.1f, elapsed=%.0fms",
                             scout["timestamp"], (time.monotonic() - t0) * 1000)

        scout_task = asyncio.create_task(_scout_and_push())

    # 准备输出目录（临时 → 原子 rename）
    tile_dir = _tile_dir(spec)
    tmp_dir = tile_dir.parent / f".tmp_{tile_dir.name}_{os.getpid()}"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    try:
        # 流式帧监听：创建中继队列，让 _do_extract 内部的 _monitor_frames 实时推帧
        relay_q: asyncio.Queue | None = None
        relay_task: asyncio.Task | None = None

        if on_frame_ready:
            relay_q = asyncio.Queue()
            # 全局 ts 去重集合 — 确保同一 timestamp 最多推 1 次
            relay_sent: set[float] = set()

            async def _relay_frames():
                """从 _do_extract 的 monitor+补漏 队列中转发帧到 on_frame_ready，全局 ts 去重"""
                while True:
                    item = await relay_q.get()
                    if item is None:
                        break  # _do_extract 完成
                    ts = item["timestamp"]
                    if ts in scout_sent or ts in relay_sent:
                        continue
                    relay_sent.add(ts)
                    await on_frame_ready.put(item)

            relay_task = asyncio.create_task(_relay_frames())

        result = await _do_extract(spec, tmp_dir, on_frame_ready=relay_q)

        # 等待中继任务完成（_do_extract 内部已推送 None 信号）
        if relay_task:
            await relay_task

        # 等待 scout 完成（如果还在跑）
        if scout_task:
            await scout_task

        # 原子发布：tmp → final
        if tile_dir.exists():
            import shutil
            shutil.rmtree(tile_dir, ignore_errors=True)
        tmp_dir.rename(tile_dir)

        # 更新路径为最终路径
        final_frames = []
        for f in result.frames:
            fname = Path(f["path"]).name
            final_path = tile_dir / fname
            rel = os.path.relpath(str(final_path), str(FRAME_DIR.parent))
            final_frames.append({
                "timestamp": f["timestamp"],
                "path": str(final_path),
                "url": f"/data/{rel}",
            })
        result.frames = final_frames
        result.complete = True
        result.elapsed_ms = (time.monotonic() - t0) * 1000

        # 写 manifest
        _write_manifest(spec, result)

        # 完成信号 — relay_task 已在 _do_extract 期间流式推过所有帧，
        # 不再二次全量推 final_frames，避免"长静默后批量喷发"体感回退
        if on_frame_ready:
            await on_frame_ready.put(None)  # 完成信号

        return result

    except Exception as e:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)
        # 确保 scout 也完成
        if scout_task and not scout_task.done():
            scout_task.cancel()
            try:
                await scout_task
            except asyncio.CancelledError:
                pass
        elapsed = (time.monotonic() - t0) * 1000
        logger.error("Tile 抽取失败: %s, err=%s, elapsed=%.0fms", spec.cache_key, e, elapsed)
        if on_frame_ready:
            await on_frame_ready.put(None)
        return TileResult(spec=spec, error=str(e), elapsed_ms=elapsed)


async def _do_extract(
    spec: TileSpec,
    output_dir: Path,
    on_frame_ready: asyncio.Queue | None,
) -> TileResult:
    """执行 ffmpeg 抽帧，支持流式帧监听"""
    if spec.duration <= 0 or spec.interval <= 0:
        return TileResult(spec=spec, error="无效的时间范围或间隔")

    if not Path(spec.video_path).exists():
        return TileResult(spec=spec, error=f"视频文件不存在: {spec.video_path}")

    # 构建 ffmpeg 命令
    # fps=1/interval 表示每 interval 秒输出一帧
    fps_val = 1.0 / spec.interval
    output_pattern = str(output_dir / "frame_%06d.jpg")

    cmd = [
        'ffmpeg', '-y',
        '-ss', f'{spec.start_sec:.3f}',
        '-t', f'{spec.duration:.3f}',
        '-i', spec.video_path,
        '-vf', f'fps={fps_val:.6f},scale={spec.width}:{spec.height}:force_original_aspect_ratio=decrease',
        '-q:v', '5',
        '-vsync', 'vfr',
        output_pattern,
    ]

    async with _TILE_SEMAPHORE:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # 流式监听：在 ffmpeg 运行期间检测新帧文件
        frames: list[dict] = []
        if on_frame_ready:
            monitor_task = asyncio.create_task(
                _monitor_frames(spec, output_dir, on_frame_ready, frames)
            )
        else:
            monitor_task = None

        _, stderr = await proc.communicate()

        # 停止监听
        if monitor_task:
            monitor_task.cancel()
            try:
                await monitor_task
            except asyncio.CancelledError:
                pass

    if proc.returncode != 0:
        err_text = stderr.decode(errors="replace")[-2000:]
        raise RuntimeError(f"ffmpeg 失败 (rc={proc.returncode}): {err_text}")

    # 收集所有输出帧（ffmpeg 完成后的完整扫描）
    all_frames = _collect_frames(spec, output_dir)

    # 推送最后的帧（monitor 可能没来得及推送的）
    if on_frame_ready:
        already_pushed = {f["timestamp"] for f in frames}
        for f in all_frames:
            if f["timestamp"] not in already_pushed:
                await on_frame_ready.put(f)
        await on_frame_ready.put(None)  # 完成信号

    return TileResult(spec=spec, frames=all_frames)


async def _monitor_frames(
    spec: TileSpec,
    output_dir: Path,
    queue: asyncio.Queue,
    pushed: list[dict],
) -> None:
    """后台监听输出目录，每检测到新帧立即推送到队列"""
    seen: set[str] = set()
    poll_interval = 0.02  # 20ms 轮询

    while True:
        try:
            for fpath in sorted(output_dir.glob("frame_*.jpg")):
                if fpath.name not in seen and fpath.stat().st_size > 0:
                    seen.add(fpath.name)
                    # 从文件名推算时间戳
                    idx = int(fpath.stem.split("_")[1]) - 1  # frame_000001 → idx 0
                    ts = round(spec.start_sec + idx * spec.interval, 1)
                    rel = os.path.relpath(str(fpath), str(FRAME_DIR.parent))
                    frame_info = {
                        "timestamp": ts,
                        "path": str(fpath),
                        "url": f"/data/{rel}",
                    }
                    pushed.append(frame_info)
                    await queue.put(frame_info)
        except (OSError, ValueError):
            pass  # 目录可能还在创建中

        await asyncio.sleep(poll_interval)


def _collect_frames(spec: TileSpec, output_dir: Path) -> list[dict]:
    """扫描输出目录，收集所有帧文件"""
    frames = []
    for fpath in sorted(output_dir.glob("frame_*.jpg")):
        if fpath.stat().st_size == 0:
            continue
        try:
            idx = int(fpath.stem.split("_")[1]) - 1
        except (IndexError, ValueError):
            continue
        ts = round(spec.start_sec + idx * spec.interval, 1)
        frames.append({
            "timestamp": ts,
            "path": str(fpath),
            "url": "",  # 临时路径，发布后更新
        })
    return frames


def _write_manifest(spec: TileSpec, result: TileResult) -> None:
    """写入 manifest.json"""
    tile_dir = _tile_dir(spec)
    manifest = {
        "video_id": spec.video_id,
        "start_sec": spec.start_sec,
        "end_sec": spec.end_sec,
        "interval": spec.interval,
        "width": spec.width,
        "height": spec.height,
        "proxy_version": spec.proxy_version,
        "complete": result.complete,
        "frame_count": len(result.frames),
        "frames": [
            {"timestamp": f["timestamp"], "filename": Path(f["path"]).name}
            for f in result.frames
        ],
        "created_at": time.time(),
    }
    manifest_path = tile_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")


async def extract_tile_segmented(
    spec: TileSpec,
    segments: list[SegmentInfo],
    on_frame_ready: asyncio.Queue | None = None,
) -> TileResult:
    """跨段 Tile 抽帧 — 按全局时间区间拆分到各 segment 本地时间并合并

    当 proxy 不可用且视频有多个 raw segments 时使用。
    spec.video_path 不直接用于 ffmpeg（每段使用各自的 raw_path）。
    """
    import math
    t0 = time.monotonic()

    # 缓存检查（使用全局 cache key）
    cached = tile_cache_check(spec)
    if cached:
        cached.elapsed_ms = (time.monotonic() - t0) * 1000
        if on_frame_ready:
            for f in cached.frames:
                await on_frame_ready.put(f)
            await on_frame_ready.put(None)
        return cached

    # --- 先行帧保底通道（跨段版） ---
    scout_sent: set[float] = set()
    scout_task: asyncio.Task | None = None
    if on_frame_ready:
        async def _scout_segmented():
            first_ts = math.ceil(spec.start_sec / spec.interval) * spec.interval
            first_ts = round(first_ts, 1)
            if first_ts > spec.end_sec:
                return
            for seg in segments:
                seg_end = seg.offset_sec + seg.duration_sec
                if seg.offset_sec <= first_ts < seg_end:
                    local_ts = first_ts - seg.offset_sec
                    scout_spec = TileSpec(
                        video_id=spec.video_id,
                        video_path=seg.raw_path,
                        start_sec=local_ts,
                        end_sec=local_ts + 1,
                        interval=spec.interval,
                        width=spec.width,
                        height=spec.height,
                        proxy_version=spec.proxy_version,
                    )
                    scout = await _extract_scout_frame(scout_spec)
                    if scout:
                        scout["timestamp"] = first_ts  # 映射回全局时间
                        scout_sent.add(first_ts)
                        await on_frame_ready.put(scout)
                    break

        scout_task = asyncio.create_task(_scout_segmented())

    # 准备输出目录
    tile_dir = _tile_dir(spec)
    tmp_dir = tile_dir.parent / f".tmp_{tile_dir.name}_{os.getpid()}"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    try:
        all_frames: list[dict] = []

        for seg in segments:
            seg_global_end = seg.offset_sec + seg.duration_sec

            # 计算与请求范围的重叠区间
            overlap_start = max(spec.start_sec, seg.offset_sec)
            overlap_end = min(spec.end_sec, seg_global_end)
            if overlap_start >= overlap_end:
                continue

            # 对齐到 interval 网格（避免跨段时间戳不对齐）
            first_grid = math.ceil(overlap_start / spec.interval) * spec.interval
            if first_grid >= overlap_end:
                continue

            # 本地时间（相对于该段起点）
            local_start = first_grid - seg.offset_sec
            local_end = overlap_end - seg.offset_sec

            seg_spec = TileSpec(
                video_id=spec.video_id,
                video_path=seg.raw_path,
                start_sec=local_start,
                end_sec=local_end,
                interval=spec.interval,
                width=spec.width,
                height=spec.height,
                proxy_version=spec.proxy_version,
            )

            seg_tmp = tmp_dir / f"seg_{seg.offset_sec:.0f}"
            seg_tmp.mkdir(parents=True, exist_ok=True)

            result = await _do_extract(seg_spec, seg_tmp, on_frame_ready=None)

            # 重映射时间戳：local → global
            for idx, f in enumerate(result.frames):
                global_ts = round(first_grid + idx * spec.interval, 1)
                f["timestamp"] = global_ts
                all_frames.append(f)

        # 等待 scout
        if scout_task:
            await scout_task

        # 按全局时间排序
        all_frames.sort(key=lambda f: f["timestamp"])

        # 移动帧文件到 tmp_dir 根目录（统一命名）
        final_frames = []
        for i, f in enumerate(all_frames):
            src = Path(f["path"])
            dst = tmp_dir / f"frame_{i + 1:06d}.jpg"
            if src.parent != tmp_dir:
                import shutil as _sh
                _sh.move(str(src), str(dst))
            else:
                src.rename(dst)
            final_frames.append({"timestamp": f["timestamp"], "path": str(dst), "url": ""})

        # 清理段子目录
        for d in list(tmp_dir.iterdir()):
            if d.is_dir():
                import shutil
                shutil.rmtree(d, ignore_errors=True)

        # 原子发布
        if tile_dir.exists():
            import shutil
            shutil.rmtree(tile_dir, ignore_errors=True)
        tmp_dir.rename(tile_dir)

        # 更新路径
        published = []
        for f in final_frames:
            fname = Path(f["path"]).name
            fpath = tile_dir / fname
            rel = os.path.relpath(str(fpath), str(FRAME_DIR.parent))
            published.append({
                "timestamp": f["timestamp"],
                "path": str(fpath),
                "url": f"/data/{rel}",
            })

        result = TileResult(
            spec=spec, frames=published, complete=True,
            elapsed_ms=(time.monotonic() - t0) * 1000,
        )
        _write_manifest(spec, result)

        # 推送帧到 SSE
        if on_frame_ready:
            for f in published:
                if f["timestamp"] not in scout_sent:
                    await on_frame_ready.put(f)
            await on_frame_ready.put(None)

        return result

    except Exception as e:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)
        if scout_task and not scout_task.done():
            scout_task.cancel()
            try:
                await scout_task
            except asyncio.CancelledError:
                pass
        elapsed = (time.monotonic() - t0) * 1000
        logger.error("Tile 跨段抽取失败: %s, err=%s, elapsed=%.0fms", spec.cache_key, e, elapsed)
        if on_frame_ready:
            await on_frame_ready.put(None)
        return TileResult(spec=spec, error=str(e), elapsed_ms=elapsed)


def purge_tile_cache(video_id: int, keep_version: int | None = None) -> int:
    """清理指定 video_id 的旧版本 Tile 缓存

    Args:
        video_id: 视频 ID
        keep_version: 保留此版本，删除其他版本。None 表示全删。
    Returns:
        删除的目录数
    """
    import shutil
    tiles_root = FRAME_DIR / "tiles" / f"v{video_id}"
    if not tiles_root.exists():
        return 0

    count = 0
    for d in tiles_root.iterdir():
        if not d.is_dir():
            continue
        if keep_version is not None and f"_pv{keep_version}" in d.name:
            continue
        shutil.rmtree(d, ignore_errors=True)
        count += 1

    if count > 0:
        logger.info("清理 Tile 缓存: video_id=%d, deleted=%d dirs", video_id, count)
    return count
