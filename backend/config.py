"""应用配置 — 从 data/settings.json 加载，缺失时用默认值"""
import json
from pathlib import Path

# 项目根目录
BASE_DIR = Path(__file__).resolve().parent.parent

# 端口
PORT = 8421

# 数据目录（固定，不可配置）
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "livecuts.db"
SNAPSHOT_DIR = DATA_DIR / "snapshots"
THUMBNAIL_DIR = DATA_DIR / "thumbnails"

# ---- settings.json 路径 ----
SETTINGS_PATH = DATA_DIR / "settings.json"

# ---- 默认值 ----
DEFAULTS: dict[str, str | int] = {
    "raw_video_root": "/Volumes/切片/衣甜",
    "proxy_video_root": "/Volumes/My Passport/proxy",
    "downloaded_pic_dir": str(Path.home() / "Downloads/切片/pic"),
    "frame_cache_dir": "data/frames",
    "sku_image_dir": "data/sku_images",
    "frame_semaphore_limit": 4,
    "stream_chunk_size": 2 * 1024 * 1024,  # 2MB
}


def _load_settings() -> dict:
    """从 settings.json 读取，缺失 key 用默认值补全"""
    if SETTINGS_PATH.exists():
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            saved = json.load(f)
    else:
        saved = {}
    # 用默认值补全缺失的 key
    merged = {**DEFAULTS, **saved}
    return merged


def save_settings(data: dict) -> None:
    """写入 settings.json"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_settings() -> dict:
    """获取当前生效的完整配置"""
    return _load_settings()


def _resolve_path(val: str) -> Path:
    """将配置中的路径字符串解析为 Path，支持相对路径（基于 BASE_DIR）"""
    p = Path(val)
    if p.is_absolute():
        return p
    return BASE_DIR / p


# ---- 对外暴露的配置变量（兼容现有代码） ----
_cfg = _load_settings()

RAW_VIDEO_ROOT = _resolve_path(str(_cfg["raw_video_root"]))
PROXY_VIDEO_ROOT = _resolve_path(str(_cfg["proxy_video_root"]))
DOWNLOADED_PIC_DIR = _resolve_path(str(_cfg["downloaded_pic_dir"]))
FRAME_DIR = _resolve_path(str(_cfg["frame_cache_dir"]))
SKU_IMAGE_DIR = _resolve_path(str(_cfg["sku_image_dir"]))
FRAME_SEMAPHORE_LIMIT: int = int(_cfg["frame_semaphore_limit"])
STREAM_CHUNK_SIZE: int = int(_cfg["stream_chunk_size"])
