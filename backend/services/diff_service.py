"""导入变更差异计算

对比新解析数据与数据库现有数据，生成 4 类 diff:
- new_sku: 新增 SKU
- new_lead: 新增线索
- status_change: 状态/异常信息变更
- listing_change: 链接/上架日期变更
"""
import json
import aiosqlite

from backend.services.xlsx_parser import ParsedRow


async def compute_diffs(
    db: aiosqlite.Connection,
    parsed_rows: list[ParsedRow],
    snapshot_id: int,
) -> list[dict]:
    """计算并存储 diff，返回 diff 列表"""
    diffs: list[dict] = []

    for row in parsed_rows:
        sku = row.product.sku_code

        # 检查 SKU 是否已存在
        cursor = await db.execute(
            "SELECT sku_code, product_status, abnormal_note, promo_link, launch_date FROM products WHERE sku_code = ?",
            (sku,),
        )
        existing = await cursor.fetchone()

        if not existing:
            # 新增 SKU
            diffs.append({
                "snapshot_id": snapshot_id,
                "diff_type": "new_sku",
                "sku_code": sku,
                "detail_json": json.dumps({
                    "product_name": row.product.product_name,
                    "price": row.product.price,
                    "shop_name": row.product.shop_name,
                }, ensure_ascii=False),
            })
        else:
            # 状态变更
            old_status = existing["product_status"] or ""
            old_abnormal = existing["abnormal_note"] or ""
            new_status = row.product.product_status
            new_abnormal = row.product.abnormal_note
            if old_status != new_status or old_abnormal != new_abnormal:
                diffs.append({
                    "snapshot_id": snapshot_id,
                    "diff_type": "status_change",
                    "sku_code": sku,
                    "detail_json": json.dumps({
                        "old_status": old_status, "new_status": new_status,
                        "old_abnormal": old_abnormal, "new_abnormal": new_abnormal,
                    }, ensure_ascii=False),
                })

            # 链接/上架变更
            old_link = existing["promo_link"] or ""
            old_launch = existing["launch_date"] or ""
            new_link = row.product.promo_link
            new_launch = row.product.launch_date or ""
            if old_link != new_link or old_launch != new_launch:
                diffs.append({
                    "snapshot_id": snapshot_id,
                    "diff_type": "listing_change",
                    "sku_code": sku,
                    "detail_json": json.dumps({
                        "old_link": old_link, "new_link": new_link,
                        "old_launch": old_launch, "new_launch": new_launch,
                    }, ensure_ascii=False),
                })

        # 检查新增 lead
        for frag in row.fragments:
            cursor = await db.execute(
                "SELECT id FROM leads WHERE sku_code = ? AND material_year = ? AND normalized_fragment_hash = ?",
                (sku, frag.material_year, frag.normalized_fragment_hash),
            )
            if not await cursor.fetchone():
                date_str = ""
                if frag.material_month and frag.material_day:
                    date_str = f"{frag.material_month}月{frag.material_day}日"
                diffs.append({
                    "snapshot_id": snapshot_id,
                    "diff_type": "new_lead",
                    "sku_code": sku,
                    "detail_json": json.dumps({
                        "date": date_str,
                        "time_points": frag.time_points,
                        "confidence": frag.parse_confidence,
                        "raw_fragment": frag.raw_fragment,
                    }, ensure_ascii=False),
                })

    # 批量写入 diffs
    for d in diffs:
        await db.execute(
            "INSERT INTO import_diffs (snapshot_id, diff_type, sku_code, detail_json) VALUES (?, ?, ?, ?)",
            (d["snapshot_id"], d["diff_type"], d["sku_code"], d["detail_json"]),
        )

    return diffs
