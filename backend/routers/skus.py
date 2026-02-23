"""SKU 商品路由"""
import asyncio
import logging
import re
import shutil
import subprocess

from fastapi import APIRouter, UploadFile, File, HTTPException, Query
from pydantic import BaseModel

from backend.config import SKU_IMAGE_DIR, DOWNLOADED_PIC_DIR, DATA_DIR
from backend.database import get_db

logger = logging.getLogger(__name__)


class BrowserBatchBody(BaseModel):
    batch_size: int = 10
    sku_codes: list[str] = []  # 指定 SKU 列表（为空则自动查全库缺图）

router = APIRouter()


@router.get("")
async def list_skus(search: str = "", status: str = "", limit: int = 200):
    """SKU 列表（含 lead 统计 + 主图）"""
    db = await get_db()

    query = """
        SELECT p.*,
            COUNT(DISTINCT l.id) AS lead_count,
            MAX(CASE WHEN l.material_month IS NOT NULL AND l.material_day IS NOT NULL
                THEN printf('%04d-%02d-%02d', l.material_year, l.material_month, l.material_day)
                ELSE NULL END) AS latest_lead_date,
            (SELECT si.file_path FROM sku_images si
             WHERE si.sku_code = p.sku_code AND si.image_type = 'main'
             ORDER BY si.sort_order LIMIT 1) AS main_image
        FROM products p
        LEFT JOIN leads l ON l.sku_code = p.sku_code
    """
    conditions = []
    params: list = []

    if search:
        conditions.append("(p.sku_code LIKE ? OR p.product_name LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%"])
    if status:
        conditions.append("p.product_status = ?")
        params.append(status)

    if conditions:
        query += " WHERE " + " AND ".join(conditions)

    query += f" GROUP BY p.sku_code ORDER BY p.updated_at DESC LIMIT {int(limit)}"

    cursor = await db.execute(query, params)
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


@router.get("/missing-images")
async def missing_images():
    """查找没有任何图片的 SKU"""
    db = await get_db()
    cursor = await db.execute("""
        SELECT p.sku_code, p.product_name
        FROM products p
        WHERE NOT EXISTS (
            SELECT 1 FROM sku_images si WHERE si.sku_code = p.sku_code
        )
        ORDER BY p.updated_at DESC
        LIMIT 50
    """)
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


@router.post("/import-downloaded-images")
async def import_downloaded_images():
    """扫描 ~/Downloads/切片/pic/ 导入油猴脚本下载的商品图"""
    if not DOWNLOADED_PIC_DIR.exists():
        raise HTTPException(400, f"目录不存在: {DOWNLOADED_PIC_DIR}")

    db = await get_db()
    SKU_IMAGE_DIR.mkdir(parents=True, exist_ok=True)

    # 文件名格式: {sku_code}_{序号}.{ext}，如 PH001_00.webp
    pattern = re.compile(r"^(.+?)_(\d+)\.(webp|jpg|jpeg|png)$", re.IGNORECASE)

    imported = 0
    skipped = 0
    unmatched: list[str] = []

    for f in sorted(DOWNLOADED_PIC_DIR.iterdir()):
        if not f.is_file():
            continue
        m = pattern.match(f.name)
        if not m:
            unmatched.append(f.name)
            continue

        sku_code = m.group(1)
        seq = int(m.group(2))
        ext = m.group(3)

        # 检查 products 表是否有这个 SKU
        cursor = await db.execute(
            "SELECT sku_code FROM products WHERE sku_code = ?", (sku_code,)
        )
        if not await cursor.fetchone():
            unmatched.append(f.name)
            continue

        # 目标文件名 & 相对路径
        dest_name = f"{sku_code}_main_{seq}.{ext}"
        dest_path = SKU_IMAGE_DIR / dest_name
        rel_path = f"sku_images/{dest_name}"

        # 检查是否已导入（按 file_path 去重）
        cursor = await db.execute(
            "SELECT id FROM sku_images WHERE file_path = ?", (rel_path,)
        )
        if await cursor.fetchone():
            skipped += 1
            continue

        # 复制文件
        shutil.copy2(str(f), str(dest_path))

        # 插入 sku_images
        await db.execute(
            "INSERT INTO sku_images (sku_code, image_type, file_path, sort_order) VALUES (?, 'main', ?, ?)",
            (sku_code, rel_path, seq),
        )

        # _00 的图同步更新 products.image_path
        if seq == 0:
            await db.execute(
                "UPDATE products SET image_path = ?, updated_at = datetime('now','localtime') "
                "WHERE sku_code = ? AND (image_path = '' OR image_path IS NULL)",
                (rel_path, sku_code),
            )

        imported += 1

    await db.commit()
    logger.info(f"导入商品图: imported={imported}, skipped={skipped}, unmatched={len(unmatched)}")
    return {"imported": imported, "skipped": skipped, "unmatched": unmatched}


@router.post("/image-downloads/browser-batch")
async def browser_batch_download(body: BrowserBatchBody):
    """批量打开浏览器标签页，触发油猴脚本下载商品图"""
    db = await get_db()

    # 指定 SKU 或自动查全库缺图
    if body.sku_codes:
        placeholders = ','.join('?' for _ in body.sku_codes)
        cursor = await db.execute(f"""
            SELECT p.sku_code, p.promo_link
            FROM products p
            WHERE p.sku_code IN ({placeholders})
              AND p.promo_link != '' AND p.promo_link IS NOT NULL
        """, body.sku_codes)
    else:
        cursor = await db.execute("""
            SELECT p.sku_code, p.promo_link
            FROM products p
            WHERE p.promo_link != '' AND p.promo_link IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM sku_images si WHERE si.sku_code = p.sku_code
              )
            ORDER BY p.updated_at DESC
            LIMIT ?
        """, (body.batch_size,))
    rows = await cursor.fetchall()
    sku_list = [dict(r) for r in rows]

    if not sku_list:
        return {"queued": 0, "sku_codes": [], "message": "没有需要下载的缺图SKU"}

    # 后台任务：用指定 Chrome Profile 逐个打开标签页，间隔 5 秒
    chrome_profile = "Profile 5"  # hedan8054@gmail.com
    async def _open_tabs():
        for i, item in enumerate(sku_list):
            try:
                if i == 0:
                    # 第一个：启动 Chrome 指定 Profile 并打开 URL
                    subprocess.Popen([
                        "open", "-na", "Google Chrome",
                        "--args", f"--profile-directory={chrome_profile}",
                        item["promo_link"],
                    ])
                else:
                    # 后续：在已打开的 Profile 中新开标签页
                    subprocess.Popen([
                        "open", "-a", "Google Chrome", item["promo_link"],
                    ])
                logger.info(f"打开浏览器: {item['sku_code']} → {item['promo_link']}")
            except Exception as e:
                logger.warning(f"打开失败: {item['sku_code']} — {e}")
            await asyncio.sleep(5)

    asyncio.create_task(_open_tabs())

    return {
        "queued": len(sku_list),
        "sku_codes": [s["sku_code"] for s in sku_list],
    }


@router.get("/image-downloads/status")
async def image_download_status():
    """下载队列状态概览（保留历史数据查询）"""
    db = await get_db()
    cursor = await db.execute("""
        SELECT status, COUNT(*) as cnt
        FROM image_downloads
        GROUP BY status
    """)
    rows = await cursor.fetchall()
    counts = {r["status"]: r["cnt"] for r in rows}
    return {"counts": counts}


@router.get("/image-downloads/by-sku/{sku_code}")
async def image_download_by_sku(sku_code: str):
    """查询某个 SKU 的下载状态"""
    db = await get_db()
    cursor = await db.execute(
        "SELECT id, status, error_msg, retry_count, updated_at FROM image_downloads WHERE sku_code = ? ORDER BY id DESC LIMIT 1",
        (sku_code,),
    )
    row = await cursor.fetchone()
    if not row:
        return None
    return dict(row)


@router.get("/{sku_code}/sessions")
async def get_sku_sessions(sku_code: str):
    """获取 SKU 的所有场次总览（按日期分组，含视频和真值信息）"""
    db = await get_db()

    # 获取所有 leads，按日期分组
    cursor = await db.execute("""
        SELECT l.id, l.material_year, l.material_month, l.material_day,
            l.session_label, l.host_label, l.time_points_json,
            l.parse_confidence, l.raw_fragment
        FROM leads l
        WHERE l.sku_code = ?
        ORDER BY l.material_year DESC, l.material_month DESC, l.material_day DESC
    """, (sku_code,))
    leads = [dict(r) for r in await cursor.fetchall()]

    # 按日期分组
    from collections import defaultdict
    groups: dict[str, dict] = {}
    for lead in leads:
        y, m, d = lead["material_year"], lead.get("material_month"), lead.get("material_day")
        if m and d:
            date_key = f"{y}-{m:02d}-{d:02d}"
        else:
            date_key = f"{y}-未知日期"

        if date_key not in groups:
            groups[date_key] = {
                "date": date_key,
                "leads": [],
                "video": None,
                "verified_count": 0,
            }
        groups[date_key]["leads"].append(lead)

    # 批量查询视频和真值
    for date_key, group in groups.items():
        if "未知" not in date_key:
            # 查视频
            cursor = await db.execute(
                "SELECT id, session_date, session_label, raw_path, proxy_path, proxy_status, duration_sec "
                "FROM video_registry WHERE session_date = ? LIMIT 1",
                (date_key,),
            )
            v = await cursor.fetchone()
            if v:
                group["video"] = dict(v)

            # 查该 SKU 在该日期对应视频的真值数
            cursor = await db.execute(
                "SELECT COUNT(*) as cnt FROM verified_clips WHERE sku_code = ? AND video_path LIKE ?",
                (sku_code, f"%{date_key}%"),
            )
            row = await cursor.fetchone()
            group["verified_count"] = row["cnt"] if row else 0

    return {
        "sku_code": sku_code,
        "sessions": list(groups.values()),
    }


@router.get("/{sku_code}")
async def get_sku(sku_code: str):
    """SKU 详情（含所有图片 + lead 统计）"""
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM products WHERE sku_code = ?", (sku_code,)
    )
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, f"SKU {sku_code} 不存在")

    result = dict(row)

    # lead 统计
    cursor = await db.execute(
        "SELECT COUNT(*) as cnt FROM leads WHERE sku_code = ?", (sku_code,)
    )
    stat = await cursor.fetchone()
    result["lead_count"] = stat["cnt"] if stat else 0

    # 所有图片
    cursor = await db.execute(
        "SELECT id, image_type, file_path, source_url, sort_order FROM sku_images WHERE sku_code = ? ORDER BY image_type, sort_order",
        (sku_code,),
    )
    images = await cursor.fetchall()
    result["images"] = [dict(img) for img in images]

    # 当前活跃 listing
    cursor = await db.execute(
        "SELECT id, shop_name, promo_link, start_date FROM listings WHERE sku_code = ? AND is_active = 1 ORDER BY start_date DESC LIMIT 1",
        (sku_code,),
    )
    listing = await cursor.fetchone()
    result["active_listing"] = dict(listing) if listing else None

    return result


@router.post("/{sku_code}/images")
async def upload_sku_image(
    sku_code: str,
    file: UploadFile = File(...),
    image_type: str = Query("main", pattern="^(main|ref|cover)$"),
):
    """上传 SKU 图片（支持 main/ref/cover 多图）"""
    db = await get_db()

    # 确认 SKU 存在
    cursor = await db.execute(
        "SELECT sku_code FROM products WHERE sku_code = ?", (sku_code,)
    )
    if not await cursor.fetchone():
        raise HTTPException(404, f"SKU {sku_code} 不存在")

    # 保存图片文件
    SKU_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    ext = file.filename.rsplit('.', 1)[-1] if file.filename and '.' in file.filename else 'jpg'

    # 获取当前该类型的最大 sort_order
    cursor = await db.execute(
        "SELECT MAX(sort_order) as max_sort FROM sku_images WHERE sku_code = ? AND image_type = ?",
        (sku_code, image_type),
    )
    max_sort_row = await cursor.fetchone()
    next_sort = (max_sort_row["max_sort"] or 0) + 1

    file_name = f"{sku_code}_{image_type}_{next_sort}.{ext}"
    file_path = SKU_IMAGE_DIR / file_name

    content = await file.read()
    file_path.write_bytes(content)

    rel_path = f"sku_images/{file_name}"

    # 写入 sku_images 表
    cursor = await db.execute(
        "INSERT INTO sku_images (sku_code, image_type, file_path, sort_order) VALUES (?, ?, ?, ?)",
        (sku_code, image_type, rel_path, next_sort),
    )
    image_id = cursor.lastrowid

    # 同步更新 products.image_path（兼容旧逻辑：取第一张 main 图）
    if image_type == "main":
        await db.execute(
            "UPDATE products SET image_path = ?, updated_at = datetime('now','localtime') WHERE sku_code = ?",
            (rel_path, sku_code),
        )

    await db.commit()

    return {"id": image_id, "image_type": image_type, "file_path": rel_path}


@router.get("/{sku_code}/images")
async def list_sku_images(sku_code: str):
    """获取 SKU 所有图片"""
    db = await get_db()
    cursor = await db.execute(
        "SELECT id, image_type, file_path, source_url, sort_order, created_at FROM sku_images WHERE sku_code = ? ORDER BY image_type, sort_order",
        (sku_code,),
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


@router.delete("/{sku_code}/images/{image_id}")
async def delete_sku_image(sku_code: str, image_id: int):
    """删除某张 SKU 图片"""
    db = await get_db()
    cursor = await db.execute(
        "SELECT file_path FROM sku_images WHERE id = ? AND sku_code = ?",
        (image_id, sku_code),
    )
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "图片不存在")

    await db.execute("DELETE FROM sku_images WHERE id = ?", (image_id,))
    await db.commit()

    # 尝试删除文件
    try:
        (DATA_DIR / row["file_path"]).unlink(missing_ok=True)
    except Exception:
        pass

    return {"ok": True}
