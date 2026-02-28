"""Tile 优先级调度器 — P0/P1/P2 优先级 + 合并 + 在途保护

调度规则：
  P0 (urgent): 交互焦点 ±10s，必须 <300ms
  P1 (warm):   可视区 ±120s，应在 1s 内就绪
  P2 (bg):     远余量带预取，后台执行
"""
import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Callable, Awaitable

from backend.config import get_settings
from backend.services.tile_extractor import (
    SegmentInfo,
    TileSpec,
    TileResult,
    extract_tile,
    extract_tile_segmented,
    tile_cache_check,
)
from backend.services.p2_spike_metrics import TileEvent, get_observer, is_spike_enabled

logger = logging.getLogger(__name__)


class Priority(IntEnum):
    P0 = 0  # urgent — 交互焦点
    P1 = 1  # warm — 可视区
    P2 = 2  # background — 远余量


@dataclass(order=True)
class TileTask:
    """优先级队列中的任务"""
    priority: int
    created_at: float = field(compare=True)
    spec: TileSpec = field(compare=False, default=None)  # type: ignore[assignment]
    task_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12], compare=False)
    # 内部状态
    future: asyncio.Future | None = field(default=None, compare=False, repr=False)
    cancelled: bool = field(default=False, compare=False)
    on_frame_ready: asyncio.Queue | None = field(default=None, compare=False, repr=False)
    segments: list[SegmentInfo] | None = field(default=None, compare=False, repr=False)


class TileScheduler:
    """Tile 优先级调度器（单例，运行在 Mac 控制面）"""

    def __init__(self, max_workers: int = 3):
        self._queue: asyncio.PriorityQueue[TileTask] = asyncio.PriorityQueue()
        self._in_flight: dict[str, TileTask] = {}  # task_id → task
        self._max_workers = max_workers
        self._active_workers = 0
        self._worker_tasks: list[asyncio.Task] = []
        self._started = False
        self._stats = {"submitted": 0, "completed": 0, "merged": 0, "cancelled": 0, "errors": 0, "offloaded": 0, "cache_hits": 0}

    async def start(self) -> None:
        """启动 worker 协程"""
        if self._started:
            return
        self._started = True
        for i in range(self._max_workers):
            task = asyncio.create_task(self._worker_loop(i))
            self._worker_tasks.append(task)
        logger.info("TileScheduler 启动: %d workers", self._max_workers)

    async def stop(self) -> None:
        """停止调度器"""
        self._started = False
        for t in self._worker_tasks:
            t.cancel()
        await asyncio.gather(*self._worker_tasks, return_exceptions=True)
        self._worker_tasks.clear()
        logger.info("TileScheduler 已停止")

    async def submit(
        self,
        spec: TileSpec,
        priority: Priority = Priority.P1,
        on_frame_ready: asyncio.Queue | None = None,
        segments: list[SegmentInfo] | None = None,
    ) -> TileTask:
        """提交 Tile 任务

        Returns:
            TileTask（可通过 task.future 等待结果）
        """
        # 1. 缓存完整命中 → 直接返回
        cached = tile_cache_check(spec)
        if cached:
            task = TileTask(
                priority=priority,
                created_at=time.monotonic(),
                spec=spec,
                on_frame_ready=on_frame_ready,
                segments=segments,
            )
            loop = asyncio.get_event_loop()
            task.future = loop.create_future()
            task.future.set_result(cached)
            if on_frame_ready:
                for f in cached.frames:
                    await on_frame_ready.put(f)
                await on_frame_ready.put(None)
            self._stats["cache_hits"] += 1
            self._observe("cache_hit", task)
            return task

        # 2. 检查在途任务是否可覆盖（合并）
        # SSE 流式任务不能合并：每个调用方都需要独立 queue
        merged_task = None if on_frame_ready else self._try_merge(spec, priority)
        if merged_task:
            self._stats["merged"] += 1
            return merged_task

        # 3. 创建新任务入队
        task = TileTask(
            priority=priority,
            created_at=time.monotonic(),
            spec=spec,
            on_frame_ready=on_frame_ready,
            segments=segments,
        )
        loop = asyncio.get_event_loop()
        task.future = loop.create_future()
        await self._queue.put(task)
        self._stats["submitted"] += 1
        # P2 spike 影子观测: 新任务入队
        self._observe("submit", task)
        return task

    def cancel_obsolete(self, video_id: int, keep_range: tuple[float, float] | None = None) -> int:
        """取消不再需要的 P2 任务（用户滚走了）

        只取消 P2 任务；P0/P1 在途的永不取消
        """
        cancelled = 0
        for task_id, task in list(self._in_flight.items()):
            if task.spec.video_id != video_id:
                continue
            if task.priority <= Priority.P1:
                continue  # P0/P1 在途保护
            if keep_range:
                # 任务范围完全在 keep_range 内 → 不取消
                if task.spec.start_sec >= keep_range[0] and task.spec.end_sec <= keep_range[1]:
                    continue
            task.cancelled = True
            cancelled += 1
        self._stats["cancelled"] += cancelled
        return cancelled

    def get_stats(self) -> dict:
        return {
            **self._stats,
            "queue_size": self._queue.qsize(),
            "in_flight": len(self._in_flight),
            "active_workers": self._active_workers,
        }

    def _try_merge(self, spec: TileSpec, priority: Priority) -> TileTask | None:
        """尝试合并到在途任务（范围完全包含新请求）"""
        for task in self._in_flight.values():
            if task.cancelled:
                continue
            ts = task.spec
            if (ts.video_id == spec.video_id
                    and ts.interval == spec.interval
                    and ts.width == spec.width
                    and ts.height == spec.height
                    and ts.proxy_version == spec.proxy_version
                    and ts.start_sec <= spec.start_sec
                    and ts.end_sec >= spec.end_sec):
                # 在途任务完全覆盖新请求 → 等待现有任务
                logger.debug("Tile 合并: 新请求 [%.1f, %.1f] 被在途 %s 覆盖",
                             spec.start_sec, spec.end_sec, task.task_id)
                return task
        return None

    async def _worker_loop(self, worker_id: int) -> None:
        """Worker 协程：从队列取任务执行"""
        while self._started:
            try:
                task = await asyncio.wait_for(self._queue.get(), timeout=1.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                continue

            if task.cancelled:
                if task.future and not task.future.done():
                    task.future.set_result(TileResult(spec=task.spec, error="cancelled"))
                if task.on_frame_ready:
                    await task.on_frame_ready.put(None)
                self._observe("cancel", task)
                continue

            # P2 任务尝试卸载到远程 Worker
            if (
                task.priority == Priority.P2
                and self._should_offload()
                and not task.on_frame_ready
                and not task.segments
            ):
                if await self._try_offload(task):
                    continue

            self._active_workers += 1
            self._in_flight[task.task_id] = task

            try:
                if task.segments:
                    result = await extract_tile_segmented(
                        task.spec,
                        task.segments,
                        on_frame_ready=task.on_frame_ready,
                    )
                else:
                    result = await extract_tile(
                        task.spec,
                        on_frame_ready=task.on_frame_ready,
                    )
                if task.future and not task.future.done():
                    task.future.set_result(result)
                self._stats["completed"] += 1
                self._observe("complete", task, elapsed_ms=result.elapsed_ms)
            except Exception as e:
                logger.error("Worker-%d Tile 执行失败: %s", worker_id, e)
                if task.future and not task.future.done():
                    task.future.set_result(TileResult(spec=task.spec, error=str(e)))
                if task.on_frame_ready:
                    # 安全兜底，避免 SSE 读取端悬挂
                    await task.on_frame_ready.put(None)
                self._stats["errors"] += 1
                self._observe("error", task, error=str(e))
            finally:
                self._in_flight.pop(task.task_id, None)
                self._active_workers -= 1

    def _observe(self, event_type: str, task: TileTask,
                  elapsed_ms: float = 0.0, error: str = "") -> None:
        """P2 spike 影子观测 — fire-and-forget，不影响主链路"""
        try:
            if not is_spike_enabled():
                return
            obs = get_observer()
            obs.record(TileEvent(
                timestamp=time.monotonic(),
                event_type=event_type,
                task_id=task.task_id,
                video_id=task.spec.video_id if task.spec else 0,
                cache_key=task.spec.cache_key if task.spec else "",
                priority=task.priority,
                elapsed_ms=elapsed_ms,
                error=error,
            ))
            # 顺便采样队列深度
            obs.record_queue_depth(self._queue.qsize())
        except Exception:
            pass  # 影子观测绝不能影响主链路

    def _should_offload(self) -> bool:
        """检查是否启用了分布式卸载"""
        cfg = get_settings()
        return bool(cfg.get("distributed_tiles_enabled", False))

    async def _try_offload(self, task: TileTask) -> bool:
        """尝试将 P2 任务卸载到远程 Worker

        返回 True 表示已成功提交到远程队列，False 表示无可用 Worker 需本地回退。
        """
        from backend.services.worker_pool import get_worker_pool

        pool = get_worker_pool()
        spec = task.spec
        task_id = await pool.submit_task(
            video_id=spec.video_id,
            video_path=spec.video_path,
            start_sec=spec.start_sec,
            end_sec=spec.end_sec,
            interval_sec=spec.interval,
            width=spec.width,
            height=spec.height,
            proxy_version=spec.proxy_version,
            cache_key=spec.cache_key,
            priority=task.priority,
        )
        if task_id is None:
            return False  # 无在线 Worker，本地回退

        # 标记为已卸载（future 设置占位结果，实际帧由 Worker 写入缓存）
        if task.future and not task.future.done():
            task.future.set_result(TileResult(
                spec=spec,
                complete=False,
                error="",
                elapsed_ms=0,
            ))
        self._stats["offloaded"] += 1
        self._observe("offload", task)
        logger.info("P2 任务已卸载到远程: task=%s, cache_key=%s", task_id, spec.cache_key)
        return True


# 全局调度器实例
_scheduler: TileScheduler | None = None


def get_scheduler() -> TileScheduler:
    """获取全局调度器实例"""
    global _scheduler
    if _scheduler is None:
        _scheduler = TileScheduler(max_workers=3)
    return _scheduler


async def ensure_scheduler_started() -> TileScheduler:
    """确保调度器已启动"""
    scheduler = get_scheduler()
    await scheduler.start()
    return scheduler
