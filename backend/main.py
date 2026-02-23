"""FastAPI 应用入口"""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.config import DATA_DIR
from backend.database import init_db, close_db
from backend.routers import import_router, skus, leads, verified, plans, video, search, settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield
    await close_db()


app = FastAPI(title="LiveCuts v1.2", lifespan=lifespan)

# CORS: 允许前端 dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges"],
)

# 挂载路由
app.include_router(import_router.router, prefix="/api/import", tags=["import"])
app.include_router(skus.router, prefix="/api/skus", tags=["skus"])
app.include_router(leads.router, prefix="/api/leads", tags=["leads"])
app.include_router(verified.router, prefix="/api/verified", tags=["verified"])
app.include_router(plans.router, prefix="/api/plans", tags=["plans"])
app.include_router(video.router, prefix="/api/video", tags=["video"])
app.include_router(search.router, prefix="/api/search", tags=["search"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])


# 静态文件：SKU 图片、帧缓存等
DATA_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/data", StaticFiles(directory=str(DATA_DIR)), name="data")


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.2"}
