"""检索路由"""
from fastapi import APIRouter, HTTPException

from backend.database import get_db

router = APIRouter()


@router.get("/by-sku/{sku_code}")
async def search_by_sku(sku_code: str):
    """按 SKU 检索: 商品信息 + leads + verified clips"""
    db = await get_db()

    # 商品信息
    cursor = await db.execute("SELECT * FROM products WHERE sku_code = ?", (sku_code,))
    product = await cursor.fetchone()
    if not product:
        raise HTTPException(404, f"SKU {sku_code} 不存在")

    # leads
    cursor = await db.execute(
        "SELECT * FROM leads WHERE sku_code = ? ORDER BY material_year DESC, material_month DESC, material_day DESC",
        (sku_code,),
    )
    leads = await cursor.fetchall()

    # verified clips
    cursor = await db.execute(
        "SELECT * FROM verified_clips WHERE sku_code = ? ORDER BY rating DESC, created_at DESC",
        (sku_code,),
    )
    clips = await cursor.fetchall()

    # lead 统计
    product_dict = dict(product)
    product_dict["lead_count"] = len(leads)

    return {
        "product": product_dict,
        "leads": [dict(l) for l in leads],
        "verified_clips": [dict(c) for c in clips],
    }


@router.get("/by-date/{date}")
async def search_by_date(date: str):
    """按日期检索: 当天所有 SKU + lead + verified 统计"""
    parts = date.split('-')
    if len(parts) != 3:
        raise HTTPException(400, "日期格式错误，应为 YYYY-MM-DD")

    year, month, day = int(parts[0]), int(parts[1]), int(parts[2])

    db = await get_db()

    # 当天的 leads（按 SKU 分组）
    cursor = await db.execute("""
        SELECT l.*, p.product_name, p.image_path
        FROM leads l
        JOIN products p ON p.sku_code = l.sku_code
        WHERE l.material_year = ? AND l.material_month = ? AND l.material_day = ?
        ORDER BY l.sku_code
    """, (year, month, day))
    rows = await cursor.fetchall()

    # 按 SKU 聚合
    sku_map: dict[str, dict] = {}
    for row in rows:
        r = dict(row)
        code = r["sku_code"]
        if code not in sku_map:
            sku_map[code] = {
                "sku_code": code,
                "product_name": r.get("product_name", ""),
                "image_path": r.get("image_path", ""),
                "leads": [],
                "verified_count": 0,
            }
        # 去掉 product_name 和 image_path 避免重复
        lead_data = {k: v for k, v in r.items() if k not in ("product_name", "image_path")}
        sku_map[code]["leads"].append(lead_data)

    # 查 verified 统计
    for code in sku_map:
        cursor = await db.execute(
            "SELECT COUNT(*) as cnt FROM verified_clips WHERE sku_code = ?", (code,)
        )
        stat = await cursor.fetchone()
        sku_map[code]["verified_count"] = stat["cnt"] if stat else 0

    return {
        "date": date,
        "skus": list(sku_map.values()),
    }
