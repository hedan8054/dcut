# 实现记录

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
