"""FFmpeg 抽帧/代理生成/导出"""
import asyncio
import hashlib
import json
import logging
import tempfile
from collections.abc import Callable
from pathlib import Path

from backend.config import FRAME_DIR, FRAME_SEMAPHORE_LIMIT, THUMBNAIL_DIR

logger = logging.getLogger(__name__)

# 全局并发信号量
_semaphore = asyncio.Semaphore(FRAME_SEMAPHORE_LIMIT)
_REQUEST_CHUNK = 24
_FFMPEG_ERR_MAX_CHARS = 4000
_FFMPEG_ERR_TAIL_LINES = 60
_CONCAT_RETRY_SIGNATURES = (
    "non-monotonic dts",
    "error parsing adts frame header",
    "aac_adtstoasc",
    "invalid data found when processing input",
    "error applying bitstream filters",
    "error muxing a packet",
    "separator is not found",
)
_MIN_PROXY_DURATION_RATIO = 0.95
_MAX_PROXY_AUDIO_VIDEO_GAP_SEC = 2.0


def _video_hash(video_path: str) -> str:
    """生成视频路径的短 hash（用于帧缓存文件名）"""
    return hashlib.md5(video_path.encode()).hexdigest()[:8]


def _format_ffmpeg_error(stderr_data: bytes) -> str:
    """提取 ffmpeg stderr 的关键尾部，避免只有版本头部信息"""
    text = stderr_data.decode(errors='replace')
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return "ffmpeg 未返回错误详情"
    tail = "\n".join(lines[-_FFMPEG_ERR_TAIL_LINES:])
    if len(tail) > _FFMPEG_ERR_MAX_CHARS:
        tail = tail[-_FFMPEG_ERR_MAX_CHARS:]
    return tail


def _is_concat_retryable_error(msg: str) -> bool:
    s = msg.lower()
    return any(sig in s for sig in _CONCAT_RETRY_SIGNATURES)


def _concat_risk_reason(segment_paths: list[str]) -> str | None:
    """识别已知高风险的拼接输入组合（优先走安全路径）"""
    suffixes = {
        Path(p).suffix.lower()
        for p in segment_paths
        if Path(p).suffix
    }
    if len(suffixes) > 1:
        return f"mixed_extensions({','.join(sorted(suffixes))})"
    return None


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


def purge_frame_cache(video_id: int) -> int:
    """删除指定 video_id 的所有帧缓存文件（v{video_id}_*.jpg），返回删除数量"""
    if not FRAME_DIR.exists():
        return 0
    pattern = f"v{video_id}_*.jpg"
    count = 0
    for f in FRAME_DIR.glob(pattern):
        try:
            f.unlink()
            count += 1
        except OSError as e:
            logger.warning("删除帧缓存失败: %s, err=%s", f, e)
    if count > 0:
        logger.info("已清理帧缓存: video_id=%d, deleted=%d", video_id, count)
    return count


async def _drain_stream(stream: asyncio.StreamReader) -> bytes:
    """读取整个 stream 避免 buffer 死锁"""
    chunks: list[bytes] = []
    async for chunk in stream:
        chunks.append(chunk)
    return b''.join(chunks)


async def _read_ffmpeg_progress(
    stdout: asyncio.StreamReader,
    on_progress: Callable[[int], None],
    expected_duration_sec: float,
) -> None:
    """解析 ffmpeg -progress pipe:1 输出，回调 percent(0-99)"""
    async for raw_line in stdout:
        line = raw_line.decode(errors='replace').strip()
        if line.startswith('out_time_us='):
            try:
                us = int(line.split('=', 1)[1])
                if expected_duration_sec > 0 and us > 0:
                    pct = min(99, int(us / (expected_duration_sec * 1_000_000) * 100))
                    on_progress(pct)
            except (ValueError, ZeroDivisionError):
                pass


async def _run_ffmpeg(
    cmd: list[str],
    on_progress: Callable[[int], None] | None = None,
    expected_duration: float = 0.0,
) -> None:
    """执行 ffmpeg 命令（支持 progress 输出）"""
    use_progress = on_progress is not None and expected_duration > 0
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stderr_data = b''
    try:
        if use_progress and proc.stdout and proc.stderr:
            stderr_task = asyncio.ensure_future(_drain_stream(proc.stderr))
            await _read_ffmpeg_progress(proc.stdout, on_progress, expected_duration)  # type: ignore[arg-type]
            stderr_data = await stderr_task
            await proc.wait()
        else:
            _, stderr_data = await proc.communicate()
    except asyncio.CancelledError:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
            except Exception:
                proc.kill()
        raise

    if proc.returncode != 0:
        raise RuntimeError(_format_ffmpeg_error(stderr_data))


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


async def export_roughcut(source_path: str, start_sec: float, end_sec: float, output_path: str) -> None:
    """从源视频截取指定时间段，stream copy 输出为独立 MP4"""
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        'ffmpeg', '-y',
        '-ss', str(start_sec),
        '-to', str(end_sec),
        '-i', source_path,
        '-c', 'copy',
        '-movflags', '+faststart',
        output_path,
    ]
    await _run_ffmpeg(cmd)


async def generate_proxy(
    raw_path: str,
    proxy_path: str,
    on_progress: Callable[[int], None] | None = None,
    expected_duration: float = 0.0,
) -> None:
    """生成代理文件（360px 宽，低码率）— 单文件"""
    cmd = [
        'ffmpeg', '-y',
        '-i', raw_path,
        '-vf', 'scale=360:-2',
        '-c:v', 'libx264', '-crf', '28', '-preset', 'fast',
        '-c:a', 'aac', '-b:a', '64k',
    ]
    if on_progress is not None and expected_duration > 0:
        cmd.extend(['-progress', 'pipe:1'])
    cmd.append(proxy_path)

    try:
        await _run_ffmpeg(cmd, on_progress=on_progress, expected_duration=expected_duration)
    except RuntimeError as exc:
        raise RuntimeError(f"代理生成失败: {raw_path}\n{exc}") from exc


def _write_concat_list(paths: list[str]) -> str:
    """创建 ffmpeg concat list 临时文件，返回路径"""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        for p in paths:
            escaped = p.replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")
        return f.name


def _build_concat_cmd(concat_list: str, proxy_path: str, with_progress: bool) -> list[str]:
    cmd = [
        'ffmpeg', '-y',
        '-f', 'concat', '-safe', '0',
        '-i', concat_list,
        '-vf', 'scale=360:-2',
        '-c:v', 'libx264', '-crf', '28', '-preset', 'fast',
        '-c:a', 'aac', '-b:a', '64k',
    ]
    if with_progress:
        cmd.extend(['-progress', 'pipe:1'])
    cmd.append(proxy_path)
    return cmd


async def _normalize_segment_for_safe_concat(src_path: str, out_path: str) -> None:
    """分段标准化：先统一封装/时间戳，再拼接"""
    cmd = [
        'ffmpeg', '-y',
        '-fflags', '+genpts',
        '-i', src_path,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-vf', 'scale=360:-2,format=yuv420p',
        '-c:v', 'libx264', '-crf', '28', '-preset', 'fast',
        '-c:a', 'aac', '-b:a', '64k',
        '-ar', '48000', '-ac', '2',
        '-af', 'aresample=async=1:first_pts=0',
        '-max_muxing_queue_size', '2048',
        '-movflags', '+faststart',
        out_path,
    ]
    try:
        await _run_ffmpeg(cmd)
    except RuntimeError as exc:
        raise RuntimeError(f"分段标准化失败: {src_path}\n{exc}") from exc


async def _generate_concat_proxy_safe(
    segment_paths: list[str],
    proxy_path: str,
    on_progress: Callable[[int], None] | None = None,
    expected_duration: float = 0.0,
) -> None:
    """安全拼接：先标准化分段，再 concat 转码"""
    with tempfile.TemporaryDirectory(prefix='livecuts_proxy_safe_') as tmpdir:
        tmp_root = Path(tmpdir)
        normalized_paths: list[str] = []
        total = max(1, len(segment_paths))
        for idx, src in enumerate(segment_paths):
            if on_progress is not None:
                on_progress(min(30, int(idx / total * 30)))
            norm = tmp_root / f"seg_{idx:03d}.mp4"
            await _normalize_segment_for_safe_concat(src, str(norm))
            normalized_paths.append(str(norm))

        if on_progress is not None:
            on_progress(30)

        concat_list = _write_concat_list(normalized_paths)
        try:
            progress_cb = None
            expected = 0.0
            if on_progress is not None and expected_duration > 0:
                def _stage2_progress(pct: int) -> None:
                    on_progress(min(99, 30 + int(pct * 0.69)))
                progress_cb = _stage2_progress
                expected = expected_duration
            cmd = _build_concat_cmd(concat_list, proxy_path, with_progress=progress_cb is not None)
            await _run_ffmpeg(cmd, on_progress=progress_cb, expected_duration=expected)
        finally:
            Path(concat_list).unlink(missing_ok=True)


async def _check_concat_output_health(
    proxy_path: str,
    expected_duration: float = 0.0,
) -> str | None:
    """快速路径成功后做一次产物验收，异常则返回原因字符串"""
    stats = await ffprobe_media_durations(proxy_path)
    video_dur = float(stats.get("video_duration") or 0.0)
    audio_dur = float(stats.get("audio_duration") or 0.0)
    has_audio = bool(stats.get("has_audio"))
    has_video = bool(stats.get("has_video"))

    if not has_video or video_dur <= 0:
        return "video_missing"
    if expected_duration > 0 and video_dur < expected_duration * _MIN_PROXY_DURATION_RATIO:
        return f"video_too_short(video={video_dur:.3f}, expected={expected_duration:.3f})"

    if not has_audio:
        return "audio_missing"
    if audio_dur <= 0:
        return "audio_duration_invalid"
    if expected_duration > 0 and audio_dur < expected_duration * _MIN_PROXY_DURATION_RATIO:
        return f"audio_too_short(audio={audio_dur:.3f}, expected={expected_duration:.3f})"
    if video_dur > 0 and (video_dur - audio_dur) > _MAX_PROXY_AUDIO_VIDEO_GAP_SEC:
        return f"audio_truncated(video={video_dur:.3f}, audio={audio_dur:.3f})"
    return None


async def generate_concat_proxy(
    segment_paths: list[str],
    proxy_path: str,
    on_progress: Callable[[int], None] | None = None,
    expected_duration: float = 0.0,
    force_safe: bool = False,
) -> None:
    """多分段拼接 → 单个代理文件，失败时自动切换安全路径"""
    risk_reason = _concat_risk_reason(segment_paths)
    if force_safe or risk_reason:
        if risk_reason:
            logger.warning("concat 检测到高风险输入，直接走安全路径: %s", risk_reason)
        await _generate_concat_proxy_safe(
            segment_paths,
            proxy_path,
            on_progress=on_progress,
            expected_duration=expected_duration,
        )
        return

    concat_list = _write_concat_list(segment_paths)
    try:
        cmd = _build_concat_cmd(
            concat_list,
            proxy_path,
            with_progress=(on_progress is not None and expected_duration > 0),
        )
        await _run_ffmpeg(cmd, on_progress=on_progress, expected_duration=expected_duration)
        # 快速路径“返回成功”也可能产出坏音轨，必须做产物验收
        suspicious_reason = await _check_concat_output_health(proxy_path, expected_duration)
        if suspicious_reason:
            logger.warning("concat 快速路径产物异常，切换安全路径: %s", suspicious_reason)
            Path(proxy_path).unlink(missing_ok=True)
            await _generate_concat_proxy_safe(
                segment_paths,
                proxy_path,
                on_progress=on_progress,
                expected_duration=expected_duration,
            )
    except RuntimeError as fast_err:
        if not _is_concat_retryable_error(str(fast_err)):
            raise RuntimeError(f"拼接代理生成失败\n{fast_err}") from fast_err
        logger.warning("concat 快速路径失败，切换安全路径: %s", fast_err)
        try:
            await _generate_concat_proxy_safe(
                segment_paths,
                proxy_path,
                on_progress=on_progress,
                expected_duration=expected_duration,
            )
        except RuntimeError as safe_err:
            raise RuntimeError(
                "拼接代理生成失败（快速路径+安全路径）\n"
                f"[fast]\n{fast_err}\n[safe]\n{safe_err}"
            ) from safe_err
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


def _stream_duration_from_ffprobe(stream: dict) -> float:
    """从 ffprobe stream 信息里提取时长（秒）"""
    raw = stream.get("duration")
    if raw not in (None, "", "N/A"):
        try:
            return float(raw)
        except (TypeError, ValueError):
            pass

    # 兜底：duration_ts * time_base
    raw_ts = stream.get("duration_ts")
    time_base = stream.get("time_base")
    if raw_ts in (None, "", "N/A") or not isinstance(time_base, str) or "/" not in time_base:
        return 0.0
    try:
        num_str, den_str = time_base.split("/", 1)
        num = float(num_str)
        den = float(den_str)
        ts = float(raw_ts)
        if den <= 0:
            return 0.0
        return ts * (num / den)
    except (TypeError, ValueError):
        return 0.0


async def ffprobe_media_durations(file_path: str) -> dict[str, float | bool]:
    """读取容器/视频/音频时长（秒），用于代理验收"""
    proc = await asyncio.create_subprocess_exec(
        'ffprobe',
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        file_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        logger.warning(f"ffprobe 媒体信息失败: {file_path}")
        return {
            "container_duration": 0.0,
            "video_duration": 0.0,
            "audio_duration": 0.0,
            "has_video": False,
            "has_audio": False,
        }

    try:
        info = json.loads(stdout)
    except json.JSONDecodeError:
        logger.warning(f"ffprobe 媒体信息解析失败: {file_path}")
        return {
            "container_duration": 0.0,
            "video_duration": 0.0,
            "audio_duration": 0.0,
            "has_video": False,
            "has_audio": False,
        }

    format_info = info.get("format") or {}
    streams = info.get("streams") or []
    if not isinstance(streams, list):
        streams = []

    try:
        container_duration = float(format_info.get("duration") or 0.0)
    except (TypeError, ValueError):
        container_duration = 0.0

    video_duration = 0.0
    audio_duration = 0.0
    has_video = False
    has_audio = False

    for s in streams:
        if not isinstance(s, dict):
            continue
        codec_type = s.get("codec_type")
        dur = _stream_duration_from_ffprobe(s)
        if codec_type == "video":
            has_video = True
            video_duration = max(video_duration, dur)
        elif codec_type == "audio":
            has_audio = True
            audio_duration = max(audio_duration, dur)

    if has_video and video_duration <= 0 and container_duration > 0:
        video_duration = container_duration
    if has_audio and audio_duration <= 0 and container_duration > 0:
        # 某些封装不给音轨 duration，降级用容器时长避免误判
        audio_duration = container_duration

    return {
        "container_duration": container_duration,
        "video_duration": video_duration,
        "audio_duration": audio_duration,
        "has_video": has_video,
        "has_audio": has_audio,
    }
