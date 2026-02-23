"""设置路由 — 存储路径管理、路径搬家、缓存清理、存储统计"""
import logging
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import (
    get_settings, save_settings, DEFAULTS, _resolve_path, BASE_DIR,
)
from backend.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter()

# ---- 路径配置的 key 列表（只有这些允许编辑） ----
PATH_KEYS = [
    "raw_video_root", "proxy_video_root", "downloaded_pic_dir",
    "frame_cache_dir", "sku_image_dir",
]
NUMERIC_KEYS = ["frame_semaphore_limit", "stream_chunk_size"]
ALL_KEYS = PATH_KEYS + NUMERIC_KEYS


# ---- 请求模型 ----

class MigratePathsBody(BaseModel):
    old_prefix: str
    new_prefix: str
    dry_run: bool = True


# ---- GET /api/settings ----

@router.get("")
async def get_all_settings():
    """返回当前配置，附带各路径是否可访问"""
    cfg = get_settings()
    result = {}
    for key in ALL_KEYS:
        val = cfg.get(key, DEFAULTS.get(key))
        entry: dict = {"value": val}
        if key in PATH_KEYS:
            resolved = _resolve_path(str(val))
            entry["resolved"] = str(resolved)
            entry["exists"] = resolved.exists()
        result[key] = entry
    return result


# ---- PATCH /api/settings ----

@router.patch("")
async def update_settings(body: dict):
    """更新部分配置项"""
    cfg = get_settings()
    updated_keys = []

    for key, val in body.items():
        if key not in ALL_KEYS:
            raise HTTPException(400, f"不允许修改的配置项: {key}")
        if key in NUMERIC_KEYS:
            try:
                val = int(val)
                if val <= 0:
                    raise ValueError
            except (ValueError, TypeError):
                raise HTTPException(400, f"{key} 必须是正整数")
        cfg[key] = val
        updated_keys.append(key)

    save_settings(cfg)
    logger.info("设置已更新: %s", updated_keys)
    return {"updated": updated_keys, "settings": cfg}


# ---- POST /api/settings/migrate-paths ----

# 需要批量替换路径的表和列
_MIGRATE_TARGETS = [
    ("video_registry", "raw_path"),
    ("video_registry", "proxy_path"),
    ("video_segments", "raw_path"),
    ("verified_clips", "video_path"),
    ("verified_clips", "raw_video_path"),
    ("video_meta", "video_path"),
    ("video_meta", "proxy_path"),
    ("frame_cache", "frame_path"),
    ("sku_images", "file_path"),
]


@router.post("/migrate-paths")
async def migrate_paths(body: MigratePathsBody):
    """路径搬家：批量替换数据库中的旧路径前缀"""
    old = body.old_prefix.rstrip("/")
    new = body.new_prefix.rstrip("/")

    if not old or not new:
        raise HTTPException(400, "旧/新前缀不能为空")
    if old == new:
        raise HTTPException(400, "旧前缀和新前缀相同")

    db = await get_db()
    report: list[dict] = []
    total_affected = 0

    for table, col in _MIGRATE_TARGETS:
        # 先检查表是否存在（防止表未建时报错）
        check = await db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
        )
        if not await check.fetchone():
            continue

        # 统计影响行数
        count_row = await db.execute(
            f"SELECT COUNT(*) FROM {table} WHERE {col} LIKE ? || '%'", (old,)
        )
        count = (await count_row.fetchone())[0]

        if count > 0 and not body.dry_run:
            await db.execute(
                f"UPDATE {table} SET {col} = REPLACE({col}, ?, ?) WHERE {col} LIKE ? || '%'",
                (old, new, old),
            )

        if count > 0:
            report.append({"table": table, "column": col, "affected": count})
            total_affected += count

    if not body.dry_run:
        await db.commit()

    return {
        "dry_run": body.dry_run,
        "old_prefix": old,
        "new_prefix": new,
        "total_affected": total_affected,
        "details": report,
    }


# ---- POST /api/settings/clear-frame-cache ----

@router.post("/clear-frame-cache")
async def clear_frame_cache():
    """清空帧缓存目录 + 清除 frame_cache 表"""
    cfg = get_settings()
    frame_dir = _resolve_path(str(cfg["frame_cache_dir"]))

    file_count = 0
    freed_bytes = 0

    if frame_dir.exists():
        for f in frame_dir.iterdir():
            if f.is_file():
                freed_bytes += f.stat().st_size
                file_count += 1
                f.unlink()

    # 清除数据库记录
    db = await get_db()
    await db.execute("DELETE FROM frame_cache")
    await db.commit()

    return {
        "deleted_files": file_count,
        "freed_mb": round(freed_bytes / 1024 / 1024, 1),
    }


# ---- GET /api/settings/storage-stats ----

def _dir_stats(path: Path) -> dict:
    """统计目录的文件数和总大小"""
    if not path.exists():
        return {"path": str(path), "exists": False, "file_count": 0, "size_mb": 0}

    total_size = 0
    file_count = 0
    for f in path.rglob("*"):
        if f.is_file():
            file_count += 1
            total_size += f.stat().st_size

    return {
        "path": str(path),
        "exists": True,
        "file_count": file_count,
        "size_mb": round(total_size / 1024 / 1024, 1),
    }


@router.get("/storage-stats")
async def storage_stats():
    """磁盘占用统计"""
    cfg = get_settings()

    # 获取各路径统计（NAS 路径可能很大，只统计顶层信息）
    raw_root = _resolve_path(str(cfg["raw_video_root"]))
    proxy_root = _resolve_path(str(cfg["proxy_video_root"]))
    frame_dir = _resolve_path(str(cfg["frame_cache_dir"]))
    sku_dir = _resolve_path(str(cfg["sku_image_dir"]))
    pic_dir = _resolve_path(str(cfg["downloaded_pic_dir"]))

    # NAS 路径只看 disk usage（不遍历，太慢）
    def _quick_disk_info(path: Path) -> dict:
        info: dict = {"path": str(path), "exists": path.exists()}
        if path.exists():
            try:
                usage = shutil.disk_usage(str(path))
                info["total_gb"] = round(usage.total / 1024**3, 1)
                info["used_gb"] = round(usage.used / 1024**3, 1)
                info["free_gb"] = round(usage.free / 1024**3, 1)
            except OSError:
                info["error"] = "无法读取磁盘信息"
        return info

    return {
        "raw_video_root": _quick_disk_info(raw_root),
        "proxy_video_root": _quick_disk_info(proxy_root),
        "frame_cache": _dir_stats(frame_dir),
        "sku_images": _dir_stats(sku_dir),
        "downloaded_pics": _dir_stats(pic_dir),
    }
