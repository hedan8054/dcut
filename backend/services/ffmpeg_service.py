"""FFmpeg 抽帧/代理生成/导出"""
import asyncio
import hashlib
import json
import logging
import tempfile
from pathlib import Path

from backend.config import FRAME_DIR, FRAME_SEMAPHORE_LIMIT, THUMBNAIL_DIR

logger = logging.getLogger(__name__)

# 全局并发信号量
_semaphore = asyncio.Semaphore(FRAME_SEMAPHORE_LIMIT)
_REQUEST_CHUNK = 24


def _video_hash(video_path: str) -> str:
    """生成视频路径的短 hash（用于帧缓存文件名）"""
    return hashlib.md5(video_path.encode()).hexdigest()[:8]


async def extract_frame(
    video_path: str,
    timestamp_sec: float,
    width: int = 180,
    height: int = 320,
    video_id: int | None = None,
) -> str:
    """抽取单帧，返回帧图片路径（有缓存则直接返回）
    video_id 存在时用 video_id 做 cache key，保证 raw/proxy 共享缓存"""
    FRAME_DIR.mkdir(parents=True, exist_ok=True)
    vh = f"v{video_id}" if video_id is not None else _video_hash(video_path)
    frame_name = f"{vh}_{timestamp_sec:.1f}_{width}x{height}.jpg"
    frame_path = FRAME_DIR / frame_name

    if frame_path.exists():
        return str(frame_path)

    async with _semaphore:
        # 双重检查
        if frame_path.exists():
            return str(frame_path)

        proc = await asyncio.create_subprocess_exec(
            'ffmpeg', '-y',
            '-ss', str(timestamp_sec),
            '-i', video_path,
            '-vframes', '1',
            '-vf', f'scale={width}:{height}:force_original_aspect_ratio=decrease',
            '-q:v', '5',
            str(frame_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()

    if frame_path.exists():
        return str(frame_path)
    raise RuntimeError(f"抽帧失败: {video_path} @ {timestamp_sec}s")


async def extract_frames_batch(
    video_path: str,
    timestamps: list[float],
    width: int = 180,
    height: int = 320,
    video_id: int | None = None,
) -> list[dict]:
    """批量抽帧，返回 [{timestamp, path}]
    video_id 透传给 extract_frame，保证 raw/proxy 共享缓存"""
    if not timestamps:
        return []

    requested = [float(t) for t in timestamps]
    # 缓存文件名使用 0.1s 精度
    rounded = [round(t, 1) for t in requested]
    unique_ts = list(dict.fromkeys(rounded))

    cache: dict[float, str | Exception] = {}
    for i in range(0, len(unique_ts), _REQUEST_CHUNK):
        chunk = unique_ts[i:i + _REQUEST_CHUNK]
        paths = await asyncio.gather(
            *(extract_frame(video_path, t, width, height, video_id) for t in chunk),
            return_exceptions=True,
        )
        for t, p in zip(chunk, paths):
            cache[t] = p

    results = []
    for req_t, key_t in zip(requested, rounded):
        p = cache[key_t]
        if isinstance(p, Exception):
            results.append({"timestamp": req_t, "path": "", "error": str(p)})
        else:
            results.append({"timestamp": req_t, "path": p})
    return results


async def generate_thumbnail(
    video_path: str,
    timestamp_sec: float,
    output_path: str | None = None,
) -> str:
    """生成封面帧"""
    THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)
    if not output_path:
        vh = _video_hash(video_path)
        output_path = str(THUMBNAIL_DIR / f"thumb_{vh}_{timestamp_sec:.1f}.jpg")

    proc = await asyncio.create_subprocess_exec(
        'ffmpeg', '-y',
        '-ss', str(timestamp_sec),
        '-i', video_path,
        '-vframes', '1',
        '-vf', 'scale=180:320:force_original_aspect_ratio=decrease',
        str(output_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    await proc.communicate()
    return output_path


async def generate_proxy(raw_path: str, proxy_path: str) -> None:
    """生成代理文件（360px 宽，低码率）— 单文件"""
    proc = await asyncio.create_subprocess_exec(
        'ffmpeg', '-y',
        '-i', raw_path,
        '-vf', 'scale=360:-2',
        '-c:v', 'libx264', '-crf', '28', '-preset', 'fast',
        '-c:a', 'aac', '-b:a', '64k',
        proxy_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await proc.communicate()
    except asyncio.CancelledError:
        # 开发模式 reload 时，取消任务前主动终止 ffmpeg，避免孤儿进程持续吃 CPU
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
            except Exception:
                proc.kill()
        raise
    if proc.returncode != 0:
        raise RuntimeError(f"代理生成失败: {raw_path}\n{stderr.decode(errors='replace')[:500]}")


async def generate_concat_proxy(segment_paths: list[str], proxy_path: str) -> None:
    """多分段拼接 → 单个代理文件（ffmpeg concat demuxer + 转码）"""
    # 创建临时 concat 文件列表
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        concat_list = f.name
        for p in segment_paths:
            # ffmpeg concat 要求用单引号转义路径中的特殊字符
            escaped = p.replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")

    try:
        proc = await asyncio.create_subprocess_exec(
            'ffmpeg', '-y',
            '-f', 'concat', '-safe', '0',
            '-i', concat_list,
            '-vf', 'scale=360:-2',
            '-c:v', 'libx264', '-crf', '28', '-preset', 'fast',
            '-c:a', 'aac', '-b:a', '64k',
            proxy_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await proc.communicate()
        except asyncio.CancelledError:
            if proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=3)
                except Exception:
                    proc.kill()
            raise
        if proc.returncode != 0:
            raise RuntimeError(f"拼接代理生成失败\n{stderr.decode(errors='replace')[:500]}")
    finally:
        Path(concat_list).unlink(missing_ok=True)


async def ffprobe_duration(file_path: str) -> float:
    """用 ffprobe 精确测量视频时长（秒），误差 ≤1 帧"""
    proc = await asyncio.create_subprocess_exec(
        'ffprobe',
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        file_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        logger.warning(f"ffprobe 失败: {file_path}")
        return 0.0

    try:
        info = json.loads(stdout)
        return float(info["format"]["duration"])
    except (json.JSONDecodeError, KeyError, ValueError):
        logger.warning(f"ffprobe 解析失败: {file_path}")
        return 0.0
