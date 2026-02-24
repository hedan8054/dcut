"""发布计划路由"""
import sqlite3
from datetime import date

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.database import get_db
from backend.models import PlanItemsIn

router = APIRouter()


class PlanCreate(BaseModel):
    plan_date: str = ""


class PlanItemPatch(BaseModel):
    sort_order: int | None = None
    status: str | None = None


@router.post("")
async def create_plan(body: PlanCreate):
    """创建计划（默认今天）"""
    plan_date = body.plan_date or date.today().isoformat()
    db = await get_db()
    try:
        cursor = await db.execute(
            "INSERT INTO plans (plan_date) VALUES (?)", (plan_date,)
        )
        plan_id = cursor.lastrowid
        await db.commit()
    except sqlite3.IntegrityError:
        # 已存在，取现有的
        cursor = await db.execute(
            "SELECT id FROM plans WHERE plan_date = ?", (plan_date,)
        )
        row = await cursor.fetchone()
        if row:
            plan_id = row["id"]
        else:
            raise HTTPException(500, "创建计划失败")

    return await _get_plan_detail(plan_id)


@router.get("")
async def get_plans(date: str = "", enriched: bool = False):
    """获取计划列表（可按日期过滤，enriched=true 返回带商品详情的版本）"""
    db = await get_db()
    if date:
        cursor = await db.execute(
            "SELECT id, plan_date, status, created_at FROM plans WHERE plan_date = ?", (date,)
        )
    else:
        cursor = await db.execute(
            "SELECT id, plan_date, status, created_at FROM plans ORDER BY plan_date DESC LIMIT 30"
        )
    rows = await cursor.fetchall()
    results = []
    for r in rows:
        if enriched:
            plan = await _get_enriched_plan_detail(r["id"])
        else:
            plan = await _get_plan_detail(r["id"])
        results.append(plan)
    return results


@router.get("/today")
async def get_today_plan():
    """获取今日计划（含商品详情、线索数、真值数）"""
    today = date.today().isoformat()
    db = await get_db()

    cursor = await db.execute(
        "SELECT id FROM plans WHERE plan_date = ?", (today,)
    )
    plan = await cursor.fetchone()
    if not plan:
        return None

    return await _get_enriched_plan_detail(plan["id"])


@router.post("/{plan_id}/items")
async def add_plan_items(plan_id: int, body: PlanItemsIn):
    """批量添加 SKU 到计划"""
    db = await get_db()

    # 确认计划存在
    cursor = await db.execute("SELECT id FROM plans WHERE id = ?", (plan_id,))
    if not await cursor.fetchone():
        raise HTTPException(404, "计划不存在")

    # 获取当前最大排序号
    cursor = await db.execute(
        "SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM plan_items WHERE plan_id = ?",
        (plan_id,),
    )
    row = await cursor.fetchone()
    next_sort = (row["max_sort"] if row else -1) + 1

    for i, sku_code in enumerate(body.sku_codes):
        try:
            await db.execute(
                "INSERT INTO plan_items (plan_id, sku_code, sort_order) VALUES (?, ?, ?)",
                (plan_id, sku_code, next_sort + i),
            )
        except sqlite3.IntegrityError:
            pass  # UNIQUE 冲突跳过

    await db.commit()
    return await _get_plan_detail(plan_id)


@router.patch("/{plan_id}/items/{item_id}")
async def update_plan_item(plan_id: int, item_id: int, body: PlanItemPatch):
    """更新排序/状态"""
    db = await get_db()
    updates = []
    params: list = []

    if body.sort_order is not None:
        updates.append("sort_order = ?")
        params.append(body.sort_order)
    if body.status is not None:
        updates.append("status = ?")
        params.append(body.status)

    if not updates:
        raise HTTPException(400, "没有需要更新的字段")

    params.extend([item_id, plan_id])
    await db.execute(
        f"UPDATE plan_items SET {', '.join(updates)} WHERE id = ? AND plan_id = ?",
        params,
    )
    await db.commit()
    return await _get_plan_detail(plan_id)


@router.delete("/{plan_id}/items/{item_id}")
async def delete_plan_item(plan_id: int, item_id: int):
    """移除计划项"""
    db = await get_db()
    await db.execute(
        "DELETE FROM plan_items WHERE id = ? AND plan_id = ?", (item_id, plan_id)
    )
    await db.commit()
    return await _get_plan_detail(plan_id)


async def _get_plan_detail(plan_id: int) -> dict:
    """获取计划完整信息（含 items）"""
    db = await get_db()
    cursor = await db.execute(
        "SELECT id, plan_date, status, created_at FROM plans WHERE id = ?", (plan_id,)
    )
    plan = await cursor.fetchone()
    if not plan:
        raise HTTPException(404, "计划不存在")

    cursor = await db.execute(
        "SELECT id, sku_code, sort_order, status FROM plan_items WHERE plan_id = ? ORDER BY sort_order",
        (plan_id,),
    )
    items = await cursor.fetchall()

    return {
        **dict(plan),
        "items": [dict(item) for item in items],
    }


async def _get_enriched_plan_detail(plan_id: int) -> dict:
    """获取计划完整信息（含商品详情、线索数、已审数）"""
    db = await get_db()
    cursor = await db.execute(
        "SELECT id, plan_date, status, created_at FROM plans WHERE id = ?", (plan_id,)
    )
    plan = await cursor.fetchone()
    if not plan:
        raise HTTPException(404, "计划不存在")

    cursor = await db.execute("""
        SELECT pi.id, pi.sku_code, pi.sort_order, pi.status,
            p.product_name, p.image_path, p.price, p.shop_name, p.promo_link,
            (SELECT COUNT(*) FROM leads l WHERE l.sku_code = pi.sku_code) AS lead_count,
            (SELECT COUNT(*) FROM verified_clips vc WHERE vc.sku_code = pi.sku_code) AS verified_count
        FROM plan_items pi
        LEFT JOIN products p ON p.sku_code = pi.sku_code
        WHERE pi.plan_id = ?
        ORDER BY pi.sort_order
    """, (plan_id,))
    items = await cursor.fetchall()

    return {
        **dict(plan),
        "items": [dict(item) for item in items],
    }
