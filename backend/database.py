"""SQLite 数据库连接管理 (aiosqlite, WAL 模式)"""
import aiosqlite
from backend.config import DB_PATH, DATA_DIR

db: aiosqlite.Connection | None = None


async def get_db() -> aiosqlite.Connection:
    """获取全局数据库连接"""
    assert db is not None, "数据库未初始化，请先调用 init_db()"
    return db


async def init_db() -> None:
    """初始化数据库连接并建表"""
    global db
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db = await aiosqlite.connect(str(DB_PATH))
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    await _create_tables(db)
    await db.commit()


async def close_db() -> None:
    """关闭数据库连接"""
    global db
    if db:
        await db.close()
        db = None


async def _create_tables(conn: aiosqlite.Connection) -> None:
    """建表（幂等）"""
    await conn.executescript("""
        CREATE TABLE IF NOT EXISTS xlsx_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_name TEXT NOT NULL,
            file_hash TEXT NOT NULL UNIQUE,
            file_path TEXT NOT NULL,
            row_count INTEGER DEFAULT 0,
            imported_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS products (
            sku_code TEXT NOT NULL,
            product_id TEXT DEFAULT '',
            product_name TEXT DEFAULT '',
            price REAL,
            shop_name TEXT DEFAULT '',
            commission_rate REAL,
            promo_link TEXT DEFAULT '',
            launch_date TEXT,
            product_status TEXT DEFAULT '',
            abnormal_note TEXT DEFAULT '',
            image_path TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            PRIMARY KEY (sku_code)
        );

        CREATE TABLE IF NOT EXISTS leads (
            id TEXT PRIMARY KEY,
            sku_code TEXT NOT NULL REFERENCES products(sku_code),
            snapshot_id INTEGER REFERENCES xlsx_snapshots(id),
            material_year INTEGER NOT NULL,
            raw_fragment TEXT NOT NULL,
            normalized_fragment TEXT NOT NULL,
            normalized_fragment_hash TEXT NOT NULL,
            material_month INTEGER,
            material_day INTEGER,
            session_label TEXT,
            host_label TEXT,
            time_points_json TEXT DEFAULT '[]',
            parse_confidence TEXT DEFAULT 'LOW',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(sku_code, material_year, normalized_fragment_hash)
        );

        CREATE INDEX IF NOT EXISTS idx_leads_sku ON leads(sku_code);
        CREATE INDEX IF NOT EXISTS idx_leads_date ON leads(material_year, material_month, material_day);

        CREATE TABLE IF NOT EXISTS import_diffs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id INTEGER REFERENCES xlsx_snapshots(id),
            diff_type TEXT NOT NULL,
            sku_code TEXT NOT NULL,
            detail_json TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS verified_clips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sku_code TEXT NOT NULL,
            lead_id TEXT REFERENCES leads(id),
            video_path TEXT NOT NULL,
            raw_video_path TEXT DEFAULT '',
            start_sec REAL NOT NULL,
            end_sec REAL NOT NULL,
            rating INTEGER DEFAULT 0 CHECK(rating BETWEEN 0 AND 5),
            tags_json TEXT DEFAULT '[]',
            thumbnail TEXT DEFAULT '',
            lead_time_original TEXT DEFAULT '',
            offset_sec REAL DEFAULT 0,
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            CHECK(end_sec > start_sec)
        );

        CREATE INDEX IF NOT EXISTS idx_verified_sku ON verified_clips(sku_code);

        CREATE TABLE IF NOT EXISTS plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_date TEXT NOT NULL UNIQUE,
            status TEXT DEFAULT 'draft',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS plan_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER REFERENCES plans(id) ON DELETE CASCADE,
            sku_code TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(plan_id, sku_code)
        );

        CREATE TABLE IF NOT EXISTS video_meta (
            video_path TEXT PRIMARY KEY,
            proxy_path TEXT DEFAULT '',
            duration_sec REAL NOT NULL,
            width INTEGER,
            height INTEGER,
            file_size INTEGER,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS frame_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_path TEXT NOT NULL,
            timestamp_sec REAL NOT NULL,
            frame_path TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(video_path, timestamp_sec)
        );

        -- 视频登记表: 日期/场次 → raw/proxy 路径
        CREATE TABLE IF NOT EXISTS video_registry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_date TEXT NOT NULL,
            session_label TEXT DEFAULT '',
            raw_path TEXT NOT NULL,
            proxy_path TEXT DEFAULT '',
            duration_sec REAL DEFAULT 0,
            width INTEGER DEFAULT 0,
            height INTEGER DEFAULT 0,
            file_size INTEGER DEFAULT 0,
            proxy_status TEXT DEFAULT 'none',
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(session_date, session_label)
        );

        CREATE INDEX IF NOT EXISTS idx_video_registry_date ON video_registry(session_date);

        -- SKU 图片表: 支持多图 (main/ref/cover)
        CREATE TABLE IF NOT EXISTS sku_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sku_code TEXT NOT NULL,
            image_type TEXT NOT NULL DEFAULT 'main',
            file_path TEXT NOT NULL,
            source_url TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE INDEX IF NOT EXISTS idx_sku_images_sku ON sku_images(sku_code);

        -- Listing 历史: 同 SKU 换店铺/换链接
        CREATE TABLE IF NOT EXISTS listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sku_code TEXT NOT NULL,
            shop_name TEXT DEFAULT '',
            promo_link TEXT DEFAULT '',
            product_id TEXT DEFAULT '',
            is_active INTEGER DEFAULT 1,
            start_date TEXT DEFAULT (datetime('now','localtime')),
            end_date TEXT,
            snapshot_id INTEGER REFERENCES xlsx_snapshots(id),
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE INDEX IF NOT EXISTS idx_listings_sku ON listings(sku_code);

        -- 商品图下载队列
        CREATE TABLE IF NOT EXISTS image_downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sku_code TEXT NOT NULL,
            source_url TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            error_msg TEXT DEFAULT '',
            retry_count INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE INDEX IF NOT EXISTS idx_image_downloads_status ON image_downloads(status);

        -- 视频分段表: 一个 session 可能有多个原始文件片段
        CREATE TABLE IF NOT EXISTS video_segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_id INTEGER NOT NULL REFERENCES video_registry(id) ON DELETE CASCADE,
            segment_index INTEGER NOT NULL DEFAULT 0,
            raw_path TEXT NOT NULL,
            offset_sec REAL DEFAULT 0,
            duration_sec REAL DEFAULT 0,
            file_size INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(video_id, segment_index)
        );

        CREATE INDEX IF NOT EXISTS idx_video_segments_video ON video_segments(video_id);
    """)
