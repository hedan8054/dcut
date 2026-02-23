"""Lead 线索路由"""
from fastapi import APIRouter

from backend.database import get_db

router = APIRouter()


@router.get("")
async def list_leads(sku_code: str = "", year: int = 0, month: int = 0, day: int = 0):
    """Lead 列表（支持多条件过滤）"""
    db = await get_db()

    query = "SELECT * FROM leads WHERE 1=1"
    params: list = []

    if sku_code:
        query += " AND sku_code = ?"
        params.append(sku_code)
    if year:
        query += " AND material_year = ?"
        params.append(year)
    if month:
        query += " AND material_month = ?"
        params.append(month)
    if day:
        query += " AND material_day = ?"
        params.append(day)

    query += " ORDER BY material_year DESC, material_month DESC, material_day DESC"

    cursor = await db.execute(query, params)
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


@router.get("/by-date/{date}")
async def leads_by_date(date: str):
    """某天所有 SKU 的 lead

    date 格式: YYYY-MM-DD
    """
    parts = date.split('-')
    if len(parts) != 3:
        return []

    year, month, day = int(parts[0]), int(parts[1]), int(parts[2])

    db = await get_db()
    cursor = await db.execute(
        """SELECT l.*, p.product_name, p.image_path
           FROM leads l
           JOIN products p ON p.sku_code = l.sku_code
           WHERE l.material_year = ? AND l.material_month = ? AND l.material_day = ?
           ORDER BY l.sku_code""",
        (year, month, day),
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


@router.get("/calendar")
async def leads_calendar():
    """日历聚合 - 每天有多少 SKU 有线索"""
    db = await get_db()
    cursor = await db.execute("""
        SELECT
            printf('%04d-%02d-%02d', material_year, material_month, material_day) AS date,
            COUNT(DISTINCT sku_code) AS sku_count
        FROM leads
        WHERE material_month IS NOT NULL AND material_day IS NOT NULL
        GROUP BY material_year, material_month, material_day
        ORDER BY date DESC
    """)
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]
