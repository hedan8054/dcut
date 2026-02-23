# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

```bash
# Start both backend + frontend (kills old processes first)
./run.sh

# Backend only (port 8421)
python3 -m uvicorn backend.main:app --port 8421 --reload

# Frontend only (port 5181, proxies /api and /data to 8421)
cd frontend && npx vite --port 5181

# Install backend deps (macOS system Python needs --break-system-packages)
pip3 install -r backend/requirements.txt --break-system-packages

# Install frontend deps
cd frontend && npm install

# TypeScript check
cd frontend && npx tsc -b

# Health check
curl http://localhost:8421/api/health

# API docs (auto-generated)
open http://localhost:8421/docs
```

## System Overview

LiveCuts v1.2 is a livestream clip management system for TikTok women's fashion (抖音女装直播切片管理). It manages the workflow of importing product catalogs, finding product appearances in livestream recordings, and marking verified clip segments.

**Data pipeline:** XLSX import → Products + Leads → Plans → Video Review → Verified Clips

## Architecture

```
Browser (:5181) → Vite proxy → FastAPI (:8421) → aiosqlite (data/livecuts.db WAL)
                                    ↓
                        ffmpeg (frame extraction, proxy generation)
                                    ↓
                    NAS raw video (/Volumes/切片/衣甜)
                    Proxy video (/Volumes/My Passport/proxy)
```

**Backend:** FastAPI + aiosqlite. 8 routers under `/api/`. Static files served at `/data/`.

**Frontend:** React 19 + Vite 7 + Tailwind 4 + shadcn/ui (new-york style). Zustand for cross-page state. Path alias `@/` → `src/`.

**Database:** SQLite with WAL mode. 14 tables. Schema initialized in `backend/database.py`.

## Video System (Critical Architecture)

### Three-Layer Video Storage

1. **Raw files** on NAS (`/Volumes/切片/衣甜/YYYY/场次标签/月份/M.DD/*.ts`) — original 1080x1920 vertical recordings, ~11GB each, 4 hours
2. **Proxy files** on local disk (`/Volumes/My Passport/proxy/YYYY-MM-DD_label.mp4`) — transcoded 360px width, libx264 CRF28, single concatenated file per session
3. **Frame cache** at `data/frames/` — extracted JPEG frames, cached by hash+timestamp+size

### Video Registry + Segments

A **session** (one recording date + label like "大号") maps to `video_registry`. Each session may have **multiple raw .ts files** stored as `video_segments` with cumulative `offset_sec`. Proxy generation concatenates all segments into one .mp4.

**Timestamp mapping** is essential: proxy timestamps must be resolved back to the correct raw segment + local offset for clip export. See `GET /api/video/registry/{id}/resolve-timestamp` and `resolve-range`.

### Proxy Generation Flow

```
NAS scan → video_registry + video_segments (with offset_sec per segment)
         → ffmpeg concat + transcode → proxy .mp4
         → proxy_status: none → queued → generating → done/failed
```

### Path Resolution

- `video_registry.raw_path` / `video_segments.raw_path`: absolute NAS paths
- `video_registry.proxy_path`: absolute local path
- `sku_images.file_path`: relative to DATA_DIR (accessed via `/data/`)
- `frame_cache.frame_path`: relative to frame_cache_dir
- Config paths in `data/settings.json`, defaults in `backend/config.py`
- `POST /api/settings/migrate-paths` for batch path prefix replacement

## Key Database Tables

| Table | Primary Key | Purpose |
|-------|------------|---------|
| `products` | `sku_code` | Product catalog (from XLSX) |
| `leads` | `id` (UUID) | Time-location hints parsed from XLSX material columns |
| `video_registry` | `id` | Session-level video registration (date + label → raw/proxy paths) |
| `video_segments` | `id` | Per-file segments within a session (with offset_sec) |
| `verified_clips` | `id` | User-confirmed clip boundaries (start_sec, end_sec, rating, tags) |
| `plans` / `plan_items` | `id` | Daily review plans (which SKUs to review today) |
| `sku_images` | `id` | Multi-image per SKU (main/ref/cover types) |
| `listings` | `id` | Shop/link history tracking (handles SKU re-listing) |
| `xlsx_snapshots` | `id` | Import history with file hash dedup |
| `import_diffs` | `id` | 4 types: new_sku, new_lead, status_change, listing_change |

**Key relationships:** leads.sku_code → products.sku_code, video_segments.video_id → video_registry.id (cascade delete), plan_items.plan_id → plans.id, verified_clips.lead_id → leads.id

## XLSX Import Pipeline

`backend/services/xlsx_parser.py` parses the product catalog XLSX:

1. Maps Chinese column headers via `COLUMN_MAP` (e.g. `商品id`, `商品售价`, `款号`)
2. Material columns `2024素材时间`, `2025素材时间`, `2026素材时间` contain free-text date/time fragments
3. Each fragment is normalized (fullwidth→halfwidth, separators unified) and parsed for: date (`M月D日`), time points (`HH:MM`), session labels (`大号`/`小号`), host labels (`施老板`)
4. Confidence scoring: HIGH (has date + time), MEDIUM (has date only), LOW (neither)
5. Deduplication via SHA-1 hash of normalized fragment text

**CJK regex gotcha:** Python's `\b` does NOT work as word boundary between CJK and ASCII characters because CJK chars are `\w`. Use `(?<!\d)` / `(?!\d)` lookarounds instead.

## Review Workflow (Frontend Core Feature)

`ReviewPage.tsx` has 4 steps with breadcrumb navigation:

1. **SELECT** — Pick SKU from today's plan (left sidebar)
2. **SESSION** — `SessionOverview` shows all sessions for that SKU grouped by date, with video availability and verified count
3. **COARSE** — `CoarseGrid` (4 zoom levels: narrow ±15min, wide ±45min, fine ±2min, fullscan) + `TimelineBar` (full-length timeline with lead markers) + optional CLIP image search
4. **FINE** — `FineTrimmer` with video player + `FrameStrip` (1fps horizontal strip, ±90s around hit point) + keyboard shortcuts (`[`/`]` for boundaries, Space for play/pause, arrows for ±1s) + rating (1-5) + preset tags + save

## CLIP Image Search

`backend/services/clip_service.py` — FashionCLIP + YOLO + HSV hybrid scoring:

1. **FashionCLIP** (`patrickjohncyh/fashion-clip` via transformers) — fashion-domain CLIP embeddings
2. **YOLO v8n** — person detection → crop torso (top 60% of bounding box), fallback to center crop
3. **HSV histogram** — 96-dim color feature (H/S/V each 32 bins)
4. **Score:** `0.7 * clip_cosine + 0.3 * color_cosine`, return top-K
5. Models lazy-loaded on first call. Device auto-select: MPS → CUDA → CPU

**transformers 5.x compat:** `get_image_features()` returns `BaseModelOutputWithPooling` instead of Tensor. The `_to_tensor()` helper extracts `pooler_output`.

## NAS Video Scanner

`backend/services/video_scanner.py` parses the NAS directory tree:

```
/Volumes/切片/衣甜/2025/大号/一月/1.01/衣甜202501-01.ts
                    ^^^^  ^^^^  ^^^^  ^^^^
                    year  label month date → session_date=2025-01-01, session_label=大号
```

File ordering uses parenthesized indices `(X-Y)` for session X segment Y, Chinese ordinals `（一）（二）（三）`, or timestamp-based sorting.

## Frontend State

Zustand stores (minimal, cross-page only):
- `reviewStore`: currentSkuCode, currentLead, savedClips
- `planStore`: today's plan
- `searchStore`: mode (sku/date), query
- `importStore`: snapshots, currentDiffs, uploading flag

## Configuration

Runtime settings stored in `data/settings.json` (editable via Settings page):

| Key | Default | Purpose |
|-----|---------|---------|
| `raw_video_root` | `/Volumes/切片/衣甜` | NAS raw video location |
| `proxy_video_root` | `/Volumes/My Passport/proxy` | Proxy output location |
| `downloaded_pic_dir` | `~/Downloads/切片/pic` | Oil monkey script download target |
| `frame_semaphore_limit` | 4 | Max concurrent ffmpeg frame extraction |
| `stream_chunk_size` | 2097152 | HTTP Range streaming chunk (2MB) |

## Important Conventions

- All videos are **vertical** (1080x1920, aspect 9:16). Frame extraction defaults: 180x320. CSS uses `aspect-[9/16]`.
- Frame URLs: `/api/video/frame?path=...&t=...&w=180&h=320`. Batch: `POST /api/video/frames`.
- Video streaming: `/api/video/stream?path=...` with HTTP Range support.
- SKU image access: `/data/sku_images/{filename}` (StaticFiles mount).
- Thumbnail access: `/data/thumbnails/{filename}`.
- Chrome image download uses **Profile 5** (hardcoded in `skus.py:browser_batch_download`).
- Backend uses `asyncio.create_subprocess_exec` for all ffmpeg/ffprobe calls.
- Database operations use raw SQL via aiosqlite (no ORM).
