# 实现记录

## M2-F1~F4 前端闭环补齐 + 收尾修复

> 日期: 2026-03-02 | 状态: **Codex 终审 Full-Go**

### 改动范围

| # | 文件 | Action | Feature |
|---|------|--------|---------|
| 1 | `backend/services/ffmpeg_service.py` | 修改 — `export_roughcut()` | F1 |
| 2 | `backend/routers/verified.py` | 修改 — `create-and-export` + `{clip_id}/export` | F1 |
| 3 | `frontend/src/api/client.ts` | 修改 — `createAndExportVerified`, `exportVerifiedClip` | F1 |
| 4 | `frontend/src/components/review/AnnotationBar.tsx` | 修改 — 导出粗剪按钮 + `onExported` | F1 |
| 5 | `frontend/src/pages/ReviewPage.tsx` | 修改 — SavedClipCard 增强 + handlers | F1, F2, F4 |
| 6 | `frontend/src/lib/clip-utils.ts` | **新建** — URL/tag 工具函数 | F4 |
| 7 | `frontend/src/components/review/VideoPreviewDialog.tsx` | **新建** — 视频预览 Dialog | F4 |
| 8 | `frontend/src/pages/ClipsPage.tsx` | **新建** — 独立片段管理页 | F3 |
| 9 | `frontend/src/App.tsx` | 修改 — `/clips` 路由 | F3 |
| 10 | `frontend/src/components/layout/NavBar.tsx` | 修改 — 片段 Tab | F3 |

### 收尾修复 (2 blocking issues)

| # | 问题 | 修复 |
|---|------|------|
| 1 | `create-and-export` 吞导出错误 | 前置校验源文件存在（400），导出失败回滚 DB 记录 + 清理残缺文件（500） |
| 2 | `getClipDownloadUrl` 不兼容绝对路径 | 解析 `/data/` 位置截取相对路径；DB 旧记录已批量修复 |

### 验证证据

| # | 检查项 | 结果 |
|---|--------|------|
| 1 | `py_compile` verified.py + ffmpeg_service.py | PASS |
| 2 | `tsc -b --noEmit` | PASS (0 errors) |
| 3 | 负例: 不存在源视频 → `create-and-export` | **400**, verified_clips 计数不变 (2→2) |
| 4 | 正例: 真实 proxy → `create-and-export` | **200**, `video_path="exports/roughcuts/..."` (相对路径) |
| 5 | ffprobe 导出文件 | duration=10.009s, size=746443B, 截取正确 |
| 6 | 旧记录 `/data/exports/roughcuts/...` 可访问 | **200** |
| 7 | DB 绝对路径已修复 | `SELECT COUNT(*) WHERE video_path LIKE '/%'` = **0** |

### Codex 终审结果

> **M2-F1F4-GATE-PASS**: Codex 终审判定 **Full-Go**。
> 前端闭环 10 文件已交付，2 阻塞已修复，7/7 验证项全绿。
> 证据: `docs/meeting-room/rooms/m1-roughcut-closeout-m2-readiness/execution/reports/artifacts/m2_f1f4_gate_20260302.json`

---

## R3 并发回归封板（v5）

> 日期: 2026-02-28 | 状态: **封板通过**

### 覆盖范围

| 阶段 | 场景 | 断言数 |
|------|------|--------|
| Phase 1 | 冷启动并发 batch×2，去重 + 精确计数 | 2 |
| Phase 2 | generating 下 batch + single POST 冲击（6 采样点单调） | 5 |
| Phase 3 | gap-hunting：20轮×3并发=60 请求，打 `_batch_inflight` 空窗 | 3 |
| Phase 4 | 热态 recover+batch 部分重叠（vid 已在队列） | 3 |
| Phase 5 | **冷态** partial-overlap + fresh-failed（重启后端清内存，重叠 vid 双方都有资格入队） | 5 |

### 结果

**18/18 断言全部通过**

关键证据：
- Phase 3：60 次请求，20/20 轮有效冲击（存在 generating vid），零击穿
- Phase 5：`[23,31]` vs `[31,40]` 并发，重叠 vid=31 恰好一方入队，总数精确 3

### 证据路径

```
execution/reports/artifacts/concurrent_recover_regression_20260228T144727Z.json
execution/reports/artifacts/concurrent_recover_test.py
```

### 非阻塞未覆盖风险

| # | 风险 | 说明 |
|---|------|------|
| 1 | 服务重启中途队列丢失 | 进程内存队列无持久化，与原始 `create_task` 行为一致，非回归 |
| 2 | 超大批量（>100 vid）并发入队锁争用 | 功能正确性已覆盖，属压测范畴 |

---

## R2 `/tiles/stream` Scheduler Integration

> 日期: 2026-02-28 | 状态: **Codex 终审通过**

### 改动范围

| 文件 | 改动 |
|------|------|
| `backend/services/tile_scheduler.py` | `TileTask` 增加 `on_frame_ready`/`segments` 字段；`submit()` 接受两参数，SSE 跳合并；`_worker_loop` 分支 segments 调用 + error/cancel None 哨兵；P2 offload 跳过流式/跨段；新增 `cache_hits` 统计计数器 |
| `backend/routers/video_tiles.py` | 移除 `extract_tile`/`extract_tile_segmented` 直接 import；`/tiles` 同步端点统一走 scheduler（含跨段）；`/tiles/stream` 删除 router 级 cache 直返分支，全部走 `scheduler.submit(on_frame_ready=queue)` |

### Checklist

| # | 项目 | 结果 |
|---|------|------|
| 1 | 无 `asyncio.create_task(extract_tile*)` 残留 | ✅ `grep` 零命中 |
| 2 | SSE Queue 生命周期：每 client 独立 Queue，所有退出路径推 None 哨兵 | ✅ scheduler cache-hit (L106-109)、worker except (L233-235)、worker cancel (L195-196) |
| 3 | P2 offload 门控：`not task.on_frame_ready and not task.segments` | ✅ tile_scheduler.py:204-205 |
| 4 | Merge 门控：`None if on_frame_ready else self._try_merge(...)` | ✅ tile_scheduler.py:116 |
| 5 | Cache-hit 走 scheduler queue 路径（非 router 直返） | ✅ router 无 `cached_stream`，scheduler.submit 推 frame+None 到 queue |
| 6 | `/tiles/stream` 无 `extract_tile*` 直接 import | ✅ 仅 import `SegmentInfo, TileSpec, tile_cache_check` |

### 关键验证结果

| 端点 | 场景 | 结果 |
|------|------|------|
| `POST /tiles/stream` | uncached 7200-7205s | 5 frames, 1215ms, `submitted:1 completed:1` |
| `POST /tiles/stream` | cached 100-105s | 5 frames, 0.1ms, `cache_hits: 1→2` |
| `POST /tiles` | cached 同步 | `task_id: cache_hit`, 5 frames |
| `GET /tiles/stats` | 全量计数 | `cache_hits:2, submitted:0, errors:0` |
| `GET /api/health` | 服务健康 | `{"status":"ok","version":"1.2"}` |

### 证据路径

```
execution/reports/artifacts/r2_stream_scheduler_validation_20260228T162517Z.json
```

---

## M1 全代码审查

> 日期: 2026-03-02 | 状态: **审查完成，待闸门裁决**
> 覆盖: tracked 20 文件 + untracked 15 文件 = **35 文件**

### 审查范围

| 分组 | 文件数 | 文件列表 |
|------|--------|---------|
| 后端核心 | 7 | config.py, database.py, main.py, models.py, settings.py, video_proxy.py, ffmpeg_service.py |
| Tile 管线 | 8 | video_tiles.py, tile_extractor.py, tile_scheduler.py, p2_spike_metrics.py, p2_spike.py, worker_pool.py, workers.py, tile_worker.py |
| 前端核心 | 10 | client.ts, MultiRowTimeline.tsx, SkuPanelItem.tsx, FocusRangeSlider.tsx, use-multi-res-frames.ts, ReviewPage.tsx, SettingsPage.tsx, types/index.ts, vite.config.ts, playwright.config.ts |
| 运维脚本 | 10 | gate_check.sh, health_guard.sh, install_meeting_room_scaffold.sh, new_meeting_room.sh, nightly_gate_archive.sh, start_execution_phase.sh, windows_worker_*.ps1 (×3), settings.json |

---

### P0 风险清单（必须清零）

| ID | 文件 | 行号 | 风险 | 修复建议 |
|----|------|------|------|---------|
| P0-01 | `database.py` | 21-37 | **`executescript` 可能重置 `PRAGMA foreign_keys=ON`**。SQLite `executescript()` 隐式提交并以 auto-commit 模式运行，可能导致 `foreign_keys` 失效，级联删除和引用完整性静默失效 | 将 `PRAGMA` 调用移到 `executescript` **之后**；初始化完成后用 `PRAGMA foreign_keys` 验证确实为 ON |
| P0-02 | `video_proxy.py` | 260-263, 601-604 | **状态机双重 `generating` 转换**。单 POST 端点在 `create_task` 前设 `generating`，batch worker 也为同一 vid 设 `generating`，存在窗口期两个任务并发处理同一视频 | 仅在 `_do_proxy_work` 内部设 `generating`，或将 vid 加入 `_proxy_jobs` 与 DB 更新做原子操作 |
| P0-03 | `tile_scheduler.py` | 293-300 | **Offload 任务 future 返回不完整结果**。`_try_offload` 立即 `set_result(TileResult(complete=False))`，调用方收到 `complete=False` 但无 error，router 返回 `status:complete` + 0 帧空数据 | 不立即 resolve future；改为轮询缓存出现后 resolve，或返回 `status:"offloaded"` 让前端 poll/retry |
| P0-04 | `tile_extractor.py` | 308-324 | **ffmpeg 进程取消时不被 kill**。task.cancelled 置位后 worker 继续等 `proc.communicate()`，浪费 semaphore slot（仅 3 个），4 个挂起的 ffmpeg 即可死锁全部帧抽取 | 传入取消令牌，定期检查并 `proc.kill()` |
| P0-05 | `worker_pool.py` | 133-167 | **`BEGIN IMMEDIATE` 阻塞所有 DB 操作**。aiosqlite 单连接上的显式事务期间，其他协程的所有 DB 操作排队等待，包括心跳、提交、查询 | 改用 `UPDATE ... WHERE status='queued' ORDER BY ... LIMIT 1 RETURNING *`（SQLite ≥3.35）做原子 claim，消除显式事务 |
| P0-06 | `MultiRowTimeline.tsx` | 1294-1302 | **拖拽中卸载导致 document 事件监听器永久泄漏**。orange 播放头的 `pointermove/pointerup` 注册在 `document` 上，组件卸载时无清理机制 | 存入 ref，在 `useEffect` cleanup 中移除 |
| P0-07 | `use-multi-res-frames.ts` | 106-125 | **Semaphore waiters 卸载后不清理**。未解析的 Promise resolve 回调持有组件闭包引用，阻止 GC；`reset()` 仅在消费方显式调用时执行，无自动卸载清理 | 在 hook 内添加 `useEffect(() => () => reset(), [])` |
| P0-08 | `ReviewPage.tsx` | 334-348, 404-435 | **数据请求无 AbortController**。快速切换 SKU 时多个并发 fetch 竞争，后到的旧 SKU 数据覆盖当前 SKU 状态 | 每个 effect 创建 AbortController，cleanup 时 abort；或用 `let stale = false` 守卫 |

---

### P1 风险清单（封板前尽量完成）

| ID | 文件 | 行号 | 风险 | 修复建议 |
|----|------|------|------|---------|
| P1-01 | `main.py` | 47-54 | CORS `allow_origins=["*"]` + `allow_credentials=True` 违反规范 | 改为 `["http://localhost:5181"]` |
| P1-02 | `main.py` | 77 | `/data` 静态挂载暴露 `livecuts.db`、`settings.json`、XLSX 快照 | 仅挂载 `sku_images`、`frames`、`thumbnails` 子目录 |
| P1-03 | `config.py` | 36-52 | settings 读写无锁，并发 PATCH 丢失更新 | 加 `asyncio.Lock` 或原子写（写临时 + rename） |
| P1-04 | `config.py` | 69-77 | 模块级常量（`PROXY_VIDEO_ROOT` 等）运行时 PATCH 后不刷新 | 改为函数调用或延迟属性 |
| P1-05 | `database.py` | 5-12 | 全局 `db` 无并发守卫，多协程共享单连接无序列化 | 写操作加 `asyncio.Lock` |
| P1-06 | `models.py` | 213-218 | `BatchFramesIn.path` 接受任意文件路径，无根目录校验 | 校验路径以已知 root 开头 |
| P1-07 | `settings.py` | 131 | `REPLACE()` 替换所有匹配（非仅前缀），可能损坏含前缀的中间路径 | 改用 `? \|\| SUBSTR({col}, LENGTH(?)+1)` |
| P1-08 | `video_proxy.py` | 28 | `_proxy_progress` dict 无限增长 | 加 TTL 清理或完成 1h 后删除 |
| P1-09 | `video_proxy.py` | 266 | fire-and-forget task 未跟踪，关机时不取消 | 存入 set + done callback，关机时 cancel+await |
| P1-10 | `video_proxy.py` | 358-374 | 错误处理 DB 操作失败时静默吞异常，视频永久停留 `generating` | 二级 try/except + 日志 |
| P1-11 | `ffmpeg_service.py` | 88-99 | ffmpeg subprocess 无超时，挂起时永久占用 semaphore | 加 `asyncio.wait_for(..., timeout=120)` + `proc.kill()` |
| P1-12 | `ffmpeg_service.py` | 88-103 | 失败时不清理部分文件，下次命中损坏缓存 | `returncode != 0` 时 `unlink(missing_ok=True)` |
| P1-13 | `ffmpeg_service.py` | 231-242 | `generate_thumbnail` 不检查 ffmpeg 返回码 | 检查 returncode，失败时 raise |
| P1-14 | `tile_scheduler.py` | 188-190 | `_worker_loop` 捕获 `CancelledError` 后 continue 而非 raise，阻止干净关机 | 在 `except Exception` 前加 `except (CancelledError, KeyboardInterrupt): raise` |
| P1-15 | `tile_scheduler.py` | 54, 131 | PriorityQueue 无 maxsize，快速滚动可堆积数百 P2 任务 | 设 `maxsize=50` 或 P2 软上限丢弃 |
| P1-16 | `tile_extractor.py` | 193-236 | 同 cache_key 并发请求共享 PID 为后缀的 tmp_dir，rename 竞争 | tmp_dir 后缀加 `uuid4().hex[:8]` |
| P1-17 | `worker_pool.py` | 202-236 | `cache_key` 可含 `../` 导致路径穿越写文件 | 正则校验 cache_key 格式 |
| P1-18 | `workers.py` | 20-94 | Worker API 完全无认证，LAN 内任何客户端可注册/投毒 | 加 shared secret header |
| P1-19 | `video_tiles.py` | 383-386 | warm 探针无并发限制，多 hint 可生成数十个并发 ffmpeg | 加 `Semaphore(4)` 限流 |
| P1-20 | `client.ts` | 7-14 | 大部分 API 请求不支持 AbortSignal | `request<T>()` 加 `signal?` 参数 |
| P1-21 | `MultiRowTimeline.tsx` | 584, 654 | `processPointer` deps 缺 `edgeHitBoundary`/`displayRange`，拖拽期间读到过期值 | 用 ref 读最新值 |
| P1-22 | `MultiRowTimeline.tsx` | 202-206 | frame Refs（Maps）切换 session 时不清空，短暂期间几何数据错位 | 在 frames identity 变化时重置 Maps |
| P1-23 | `FocusRangeSlider.tsx` | 88-95 | 拖拽中卸载导致 `mousemove/mouseup` 监听器泄漏 | 存入 ref + `useEffect` cleanup |
| P1-24 | `FocusRangeSlider.tsx` | 53, 60 | `focusRange` 拖拽开始时快照冻结，auto-expand 后计算基于过期数据 | 用 ref 实时读取 |
| P1-25 | `SkuPanelItem.tsx` | 79-113 | 进度轮询 interval videoInfo 变化时不清除，轮询错误 videoId | `videoInfo` 变化时先 `clearProgressPolling()` |
| P1-26 | `ReviewPage.tsx` | 503-510 | `handleVideoInfoUpdate` deps 含 `sessions`，回调身份不稳导致轮询重启 | sessions 改用 ref |
| P1-27 | `gate_check.sh` | 42-48 | 等待循环无失败路径，后端未启动时继续盲测产生误导结果 | 循环后加 `curl -sf ... \|\| exit 1` |
| P1-28 | `nightly_gate_archive.sh` | 4 | 硬编码 `/Users/ddmbp/dcut/v1.2`，其他机器无法运行 | 改用 `$(cd "$(dirname "$0")/.." && pwd)` |
| P1-29 | `windows_worker_supervisor.ps1` | 61-63 | 无日志轮转，crash loop 下每天产生 ~10800 对日志文件 | 每次循环清理 7 天前日志 |
| P1-30 | `windows_worker_supervisor.ps1` | 55-97 | 无 crash-loop 退避，持续失败时 8s 定间隔死循环 | 连续快速退出 5 次后指数退避 |

---

### P2 风险清单（可延后到 M2）

| ID | 文件 | 风险 |
|----|------|------|
| P2-01 | `config.py` | `_resolve_path` 无路径穿越校验 |
| P2-02 | `database.py` | 无迁移策略，仅 `CREATE TABLE IF NOT EXISTS` |
| P2-03 | `main.py` | 关机不取消/等待后台 proxy 任务 |
| P2-04 | `models.py` | `rating` 无 Pydantic 范围校验（依赖 DB CHECK） |
| P2-05 | `settings.py` | `clear-frame-cache` 非递归，子目录跳过 |
| P2-06 | `settings.py` | `_dir_stats` 阻塞 I/O 可能卡事件循环 |
| P2-07 | `ffmpeg_service.py` | MD5 截断 8 字符的生日碰撞风险 |
| P2-08 | `ffmpeg_service.py` | tempfile 进程被 kill 时泄漏 |
| P2-09 | `tile_extractor.py` | scout 帧永不清理 |
| P2-10 | `tile_scheduler.py` | `cancel_obsolete` 不处理队列中的任务 |
| P2-11 | `worker_pool.py` | `tile_tasks` 表无限增长 |
| P2-12 | `p2_spike.py` | `/observe` 端点无认证可注入假数据 |
| P2-13 | `tile_worker.py` | Base64 帧上传带宽低效（33% 开销） |
| P2-14 | `video_tiles.py` | `_warmed_paths` set 无限增长 |
| P2-15 | `types/index.ts` | `proxy_status` 类型为 `string` 而非联合类型 |
| P2-16 | `ReviewPage.tsx` | keyboard effect 14 deps 每帧重注册 |
| P2-17 | `MultiRowTimeline.tsx` | `ZOOM_LEVELS` 每次渲染重建 |
| P2-18 | `gate_check.sh` | `kill -9` 可能误杀用户自己的 dev server |
| P2-19 | `gate_check.sh` | uvicorn 绑 `0.0.0.0` 暴露 LAN |
| P2-20 | `windows_worker_install_task.ps1` | `-ExecutionPolicy Bypass` 禁用签名检查 |
| P2-21 | `settings.json` | `distributed_tiles_enabled` / `p2_spike_enabled` 默认 true |

---

### M1 封板建议修复计划

#### 第一批：P0 必修（阻塞封板）

| 优先序 | ID | 预计工作量 | 说明 |
|--------|-----|-----------|------|
| 1 | P0-01 | 10min | database.py PRAGMA 顺序调整 + 验证 |
| 2 | P0-06 | 15min | MultiRowTimeline 拖拽监听器 ref+cleanup |
| 3 | P0-07 | 5min | use-multi-res-frames useEffect cleanup |
| 4 | P0-08 | 20min | ReviewPage 数据 effect 加 stale guard |
| 5 | P0-02 | 20min | video_proxy 状态机原子化 |
| 6 | P0-03 | 15min | tile_scheduler offload future 处理 |
| 7 | P0-04 | 15min | tile_extractor ffmpeg 取消 kill |
| 8 | P0-05 | 15min | worker_pool 改用 RETURNING 原子 claim |

**预计总工时: ~2h**

#### 第二批：P1 高优先（封板前尽量完成）

| 优先序 | ID 组 | 说明 |
|--------|-------|------|
| 1 | P1-01, P1-02 | CORS + 静态文件暴露（安全） |
| 2 | P1-11, P1-12, P1-13 | ffmpeg 超时 + 缓存一致性 |
| 3 | P1-21, P1-22, P1-24, P1-25 | 前端 stale closure 集中修复 |
| 4 | P1-14, P1-15 | scheduler 关机 + 背压 |
| 5 | P1-09, P1-10 | video_proxy 任务跟踪 + 错误处理 |
| 6 | P1-27, P1-28, P1-29 | 运维脚本健壮性 |

#### 第三批：P2 延后到 M2

全部 21 项 P2 不阻塞 M1 封板，在 M2 启动后按优先级逐步消化。

---

### 与 M1-P0 待办对照

| INDEX.md 待办 | 审查覆盖 | 状态 |
|---------------|---------|------|
| M1-P0-01 变更范围冻结 | 已清点 35 文件，分 4 组 | ✅ 已输出分组，待收口提交 |
| M1-P0-02 代理链路一致性 | P0-02 (状态机), P1-08/09/10 (进度/任务/错误) | ✅ 已审查，发现 4 项风险 |
| M1-P0-03 粗剪主链体感 | P0-06/07/08 (前端泄漏/竞争), P1-20~26 (stale closure) | ✅ 已审查，发现 10 项风险 |
| M1-P0-04 回归命令固化 | P1-27/28 (gate_check/nightly 脚本) | ✅ 已审查，发现 2 项阻塞 |
