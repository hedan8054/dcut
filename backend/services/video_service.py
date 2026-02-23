"""视频元数据服务 (ffprobe)"""
import asyncio
import json
from pathlib import Path


async def get_video_metadata(video_path: str) -> dict:
    """通过 ffprobe 获取视频元数据"""
    path = Path(video_path)
    if not path.exists():
        raise FileNotFoundError(f"视频文件不存在: {video_path}")

    proc = await asyncio.create_subprocess_exec(
        'ffprobe',
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    data = json.loads(stdout)

    fmt = data.get('format', {})
    duration = float(fmt.get('duration', 0))
    file_size = int(fmt.get('size', 0))

    # 找视频流获取分辨率
    width, height = 0, 0
    for stream in data.get('streams', []):
        if stream.get('codec_type') == 'video':
            width = stream.get('width', 0)
            height = stream.get('height', 0)
            break

    return {
        'duration_sec': duration,
        'width': width,
        'height': height,
        'file_size': file_size,
    }
