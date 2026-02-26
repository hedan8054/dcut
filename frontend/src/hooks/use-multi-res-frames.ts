import { useState, useCallback, useRef } from 'react'
import { batchFrames } from '@/api/client'

export interface FrameData {
  timestamp: number
  url: string
}

export type ResLayer = 'L1' | 'L2' | 'L3'

interface LayerConfig {
  interval: number    // 帧间隔（秒）
  batchSize: number   // 每批请求帧数
  frameW: number      // 缩略图宽
  frameH: number      // 缩略图高
}

/**
 * 三层配置：
 * L1: 30s — 全局 filmstrip（全视频）
 * L2: 10s — 局部 filmstrip 默认（±10min）
 * L3: 1s  — 局部 filmstrip 放大（±2min）
 */
const LAYER_CONFIG: Record<ResLayer, LayerConfig> = {
  L1: { interval: 30, batchSize: 500, frameW: 60,  frameH: 107 },
  L2: { interval: 10, batchSize: 300, frameW: 90,  frameH: 160 },
  L3: { interval: 1,  batchSize: 300, frameW: 90,  frameH: 160 },
}

export { LAYER_CONFIG }

const MAX_BATCH_CONCURRENCY = 2

/**
 * 同向合并窗口（ms）。
 * 在此时间窗内连续的同层同向 extendRange 调用会被合并为一次请求。
 * 对应文档第 5 节: "同向窗口合并"
 */
const MERGE_WINDOW_MS = 150

type LoadingState = Record<ResLayer, boolean>
type ProgressState = Record<ResLayer, [number, number]>

export interface MultiResProgress {
  loading: LoadingState
  progress: ProgressState
}

/** 生成等间隔时间戳数组 */
function generateTimestamps(
  start: number, end: number, interval: number, duration: number,
): number[] {
  const s = Math.max(0, Math.ceil(start / interval) * interval)
  const e = Math.min(duration, end)
  const ts: number[] = []
  for (let t = s; t <= e; t += interval) {
    ts.push(Math.round(t * 10) / 10)
  }
  return ts
}

/** 合并两个范围 */
function mergeRange(
  a: [number, number] | null, b: [number, number],
): [number, number] {
  if (!a) return b
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])]
}

const EMPTY_LOADING: LoadingState = { L1: false, L2: false, L3: false }
const EMPTY_PROGRESS: ProgressState = { L1: [0, 0], L2: [0, 0], L3: [0, 0] }

/**
 * 全局信号量 — 限制所有 batchFrames 请求的总并发数。
 * 无论请求来自 startPreload、loadL3 还是 extendRange，
 * 同时在途的 batchFrames 请求数不超过 MAX_BATCH_CONCURRENCY（验收 #10）。
 */
interface AsyncSemaphore {
  count: number
  waiters: (() => void)[]
}

async function acquireSlot(sem: AsyncSemaphore) {
  if (sem.count < MAX_BATCH_CONCURRENCY) {
    sem.count++
    return
  }
  await new Promise<void>(resolve => sem.waiters.push(resolve))
  sem.count++
}

function releaseSlot(sem: AsyncSemaphore) {
  sem.count--
  if (sem.waiters.length > 0) {
    sem.waiters.shift()!()
  }
}

/** 待合并请求 */
interface PendingExpand {
  timer: ReturnType<typeof setTimeout>
  layer: ResLayer
  start: number
  end: number
  interval?: number
  videoPath: string
  videoId: number | undefined
}

/**
 * 多分辨率帧缓存 hook
 *
 * L1: 30s — 全局 filmstrip，覆盖整个视频
 * L2: 10s — 局部 filmstrip 默认层（±10min）
 * L3: 1s — 局部 filmstrip 放大层（±2min，按需加载）
 *
 * ref 存缓存避免闭包过期，state 存进度触发渲染
 *
 * 请求管理（文档第 5 节 / 验收 #10）:
 * - AbortController: 新请求到来时 abort 同层旧请求
 * - 同向合并: 150ms 窗口内连续 extendRange 合并为单次
 * - 并发 ≤ 2: 全局信号量 semRef 限制所有 batchFrames 总并发
 */
export function useMultiResFrames(videoDuration: number) {
  const cacheRef = useRef<Record<ResLayer, Map<number, string>>>({
    L1: new Map(), L2: new Map(), L3: new Map(),
  })
  const rangeRef = useRef<Record<ResLayer, [number, number] | null>>({
    L1: null, L2: null, L3: null,
  })
  const inFlightRef = useRef<Record<ResLayer, number>>({
    L1: 0, L2: 0, L3: 0,
  })
  const sessionRef = useRef(0)

  // --- 全局信号量 ---
  const semRef = useRef<AsyncSemaphore>({ count: 0, waiters: [] })

  // --- 请求取消 ---
  const abortControllersRef = useRef<Record<ResLayer, AbortController | null>>({
    L1: null, L2: null, L3: null,
  })
  const preloadAcRef = useRef<AbortController | null>(null)
  const l3AcRef = useRef<AbortController | null>(null)

  // --- 同向合并 ---
  const pendingExpandRef = useRef<Record<ResLayer, PendingExpand | null>>({
    L1: null, L2: null, L3: null,
  })

  const [progress, setProgress] = useState<MultiResProgress>({
    loading: { ...EMPTY_LOADING },
    progress: { ...EMPTY_PROGRESS },
  })

  const [version, setVersion] = useState(0)
  const bump = useCallback(() => setVersion(v => v + 1), [])

  /** 内部：加载指定层级指定范围的帧，intervalOverride 可覆盖默认间隔 */
  const loadRange = useCallback(async (
    videoPath: string,
    videoId: number | undefined,
    layer: ResLayer,
    start: number,
    end: number,
    sid: number,
    intervalOverride?: number,
    signal?: AbortSignal,
  ) => {
    const config = LAYER_CONFIG[layer]
    const interval = intervalOverride ?? config.interval
    const allTs = generateTimestamps(start, end, interval, videoDuration)
    if (allTs.length === 0) return

    const cache = cacheRef.current[layer]
    const uncached = allTs.filter(t => !cache.has(t))

    rangeRef.current[layer] = mergeRange(rangeRef.current[layer], [start, end])

    if (uncached.length === 0) { bump(); return }

    inFlightRef.current[layer] += 1
    setProgress(p => ({
      loading: { ...p.loading, [layer]: inFlightRef.current[layer] > 0 },
      progress: { ...p.progress, [layer]: [0, uncached.length] },
    }))

    const batches: number[][] = []
    for (let i = 0; i < uncached.length; i += config.batchSize) {
      batches.push(uncached.slice(i, i + config.batchSize))
    }

    // 通过全局信号量限制总并发 ≤ MAX_BATCH_CONCURRENCY（验收 #10）
    // 所有 loadRange 调用（startPreload / loadL3 / extendRange）共享同一信号量
    let done = 0
    const sem = semRef.current
    try {
      await Promise.all(batches.map(async (batch) => {
        if (sessionRef.current !== sid || signal?.aborted) return
        await acquireSlot(sem)
        try {
          if (sessionRef.current !== sid || signal?.aborted) return
          const result = await batchFrames({
            path: videoPath,
            video_id: videoId,
            timestamps: batch,
            w: config.frameW, h: config.frameH,
          }, signal)
          if (sessionRef.current !== sid || signal?.aborted) return

          const map = cacheRef.current[layer]
          for (const f of result.frames) {
            if (f.url) map.set(f.timestamp, f.url)
          }
          done += batch.length
          setProgress(p => ({
            loading: { ...p.loading, [layer]: inFlightRef.current[layer] > 0 },
            progress: { ...p.progress, [layer]: [done, uncached.length] },
          }))
          bump()
        } catch (err) {
          if (signal?.aborted) return
          console.error(`[${layer}] 批量抽帧失败:`, err)
        } finally {
          releaseSlot(sem)
        }
      }))
    } finally {
      if (inFlightRef.current[layer] > 0) inFlightRef.current[layer] -= 1
      if (sessionRef.current === sid) {
        setProgress(p => ({
          loading: { ...p.loading, [layer]: inFlightRef.current[layer] > 0 },
          progress: { ...p.progress, [layer]: [uncached.length, uncached.length] },
        }))
      }
    }
  }, [videoDuration, bump])

  /**
   * 渐进式预加载 — 场次选择时调用
   *
   * 加载顺序（保证最优体感）：
   * 1) 全视频 120s 间隔 → 页面秒开，几秒内有帧可看
   * 2) 全视频 60s 间隔 → 补 60s 间隙帧
   * 3) 锚点 ±10min 10s 间隔 → 用户最可能浏览的区域
   * 4) 锚点 ±2min 1s 间隔 → 精细预览
   *
   * 每步用 await 串行，后步的帧复用前步缓存（cache.has 跳过）
   * session 变化时 sid 不匹配，自动中止
   */
  const startPreload = useCallback((videoPath: string, anchorSec: number, videoId?: number) => {
    const sid = ++sessionRef.current

    // 中止旧的预加载，纳入全局并发控制
    preloadAcRef.current?.abort()
    const ac = new AbortController()
    preloadAcRef.current = ac

    ;(async () => {
      // 渐进式预加载，所有间隔都是 10 的倍数，保证嵌套对齐
      // 1. 全视频 120s — 最快出图（~125帧 for 250min video）
      await loadRange(videoPath, videoId, 'L2', 0, videoDuration, sid, 120, ac.signal)
      if (sessionRef.current !== sid || ac.signal.aborted) return

      // 2. 全视频 60s — 补中间帧（~125帧增量）
      await loadRange(videoPath, videoId, 'L2', 0, videoDuration, sid, 60, ac.signal)
      if (sessionRef.current !== sid || ac.signal.aborted) return

      // 3. 锚点附近 ±10min 10s — 用户最可能浏览的区域
      await loadRange(videoPath, videoId, 'L2', anchorSec - 10 * 60, anchorSec + 10 * 60, sid, 10, ac.signal)
      if (sessionRef.current !== sid || ac.signal.aborted) return

      // 4. 锚点附近 ±2min 1s — 精细层
      await loadRange(videoPath, videoId, 'L3', anchorSec - 2 * 60, anchorSec + 2 * 60, sid, undefined, ac.signal)
    })()
  }, [loadRange, videoDuration])

  /** 按需加载 L3（局部 1s 放大），渐进式扩展：±2min → ±4min → ±6min → ±8min */
  const loadL3 = useCallback((videoPath: string, centerSec: number, videoId?: number) => {
    const sid = sessionRef.current
    const steps = [2, 4, 6, 8] // 每步的半径（分钟）

    // 中止旧的 L3 加载，纳入全局并发控制
    l3AcRef.current?.abort()
    const ac = new AbortController()
    l3AcRef.current = ac

    ;(async () => {
      for (const mins of steps) {
        if (sessionRef.current !== sid || ac.signal.aborted) return
        const half = mins * 60
        await loadRange(videoPath, videoId, 'L3', centerSec - half, centerSec + half, sid, undefined, ac.signal)
      }
    })()
  }, [loadRange])

  /** 获取指定层级指定范围内的帧，intervalOverride 可覆盖默认步进。
   *  所有时间槽位都返回 FrameData，未加载的帧 url 为空串（UI 显示 skeleton）。 */
  const getFrames = useCallback((
    layer: ResLayer, startSec: number, endSec: number, intervalOverride?: number,
  ): FrameData[] => {
    const config = LAYER_CONFIG[layer]
    const interval = intervalOverride ?? config.interval
    const cache = cacheRef.current[layer]
    const frames: FrameData[] = []

    const s = Math.max(0, Math.ceil(startSec / interval) * interval)
    const e = Math.min(videoDuration, endSec)
    for (let t = s; t <= e; t += interval) {
      const ts = Math.round(t * 10) / 10
      const url = cache.get(ts) ?? ''
      frames.push({ timestamp: ts, url })
    }
    return frames
  }, [videoDuration])

  /**
   * 平移/扩窗时增量加载。
   *
   * 增强（文档第 5 节 / 验收 #10）:
   * - 取消过期请求: 同层新请求到来时 abort 旧的
   * - 同向合并: MERGE_WINDOW_MS 内多次调用合并为一次
   */
  const extendRange = useCallback((
    videoPath: string,
    videoId: number | undefined,
    layer: ResLayer,
    newStart: number,
    newEnd: number,
    intervalOverride?: number,
  ) => {
    const sid = sessionRef.current
    const existing = rangeRef.current[layer]

    // 计算实际需要加载的范围
    let loadLeft: [number, number] | null = null
    let loadRight: [number, number] | null = null

    if (!existing) {
      loadLeft = [newStart, newEnd]
    } else {
      const [es, ee] = existing
      // 完全不相交 → 重置
      if (newEnd < es || newStart > ee) {
        rangeRef.current[layer] = null
        loadLeft = [newStart, newEnd]
      } else {
        if (newStart < es) loadLeft = [newStart, es]
        if (newEnd > ee) loadRight = [ee, newEnd]
      }
    }

    if (!loadLeft && !loadRight) return

    // 取消同层旧的在途请求
    const oldAc = abortControllersRef.current[layer]
    if (oldAc) oldAc.abort()
    const ac = new AbortController()
    abortControllersRef.current[layer] = ac

    // 同向合并: 如果有 pending 则合并范围
    const pending = pendingExpandRef.current[layer]
    if (pending) {
      clearTimeout(pending.timer)
      // 合并范围
      if (loadLeft) {
        loadLeft = [Math.min(loadLeft[0], pending.start), Math.max(loadLeft[1], pending.end)]
      } else if (loadRight) {
        loadRight = [Math.min(loadRight[0], pending.start), Math.max(loadRight[1], pending.end)]
      }
      pendingExpandRef.current[layer] = null
    }

    // 合并后的总范围
    const mergedStart = loadLeft ? loadLeft[0] : loadRight![0]
    const mergedEnd = loadRight ? loadRight[1] : loadLeft![1]

    // 延迟发出（MERGE_WINDOW_MS 内可继续合并）
    // 合并 left/right 为单次 loadRange — 保证任意时刻在途请求 ≤ 2（验收 #10）
    // loadRange 内部通过全局信号量控制并发，已缓存的帧会被 filter 跳过
    const timer = setTimeout(() => {
      pendingExpandRef.current[layer] = null
      loadRange(videoPath, videoId, layer, mergedStart, mergedEnd, sid, intervalOverride, ac.signal)
    }, MERGE_WINDOW_MS)

    pendingExpandRef.current[layer] = {
      timer,
      layer,
      start: mergedStart,
      end: mergedEnd,
      interval: intervalOverride,
      videoPath,
      videoId,
    }
  }, [loadRange])

  /** 重置缓存（切换 lead / 切换场次） */
  const reset = useCallback(() => {
    sessionRef.current++
    cacheRef.current = { L1: new Map(), L2: new Map(), L3: new Map() }
    rangeRef.current = { L1: null, L2: null, L3: null }
    inFlightRef.current = { L1: 0, L2: 0, L3: 0 }
    // 取消所有在途请求（extendRange + startPreload + loadL3）
    for (const layer of ['L1', 'L2', 'L3'] as ResLayer[]) {
      abortControllersRef.current[layer]?.abort()
      abortControllersRef.current[layer] = null
      const p = pendingExpandRef.current[layer]
      if (p) { clearTimeout(p.timer); pendingExpandRef.current[layer] = null }
    }
    preloadAcRef.current?.abort()
    preloadAcRef.current = null
    l3AcRef.current?.abort()
    l3AcRef.current = null
    // 释放信号量等待队列（配合 sid 检查自动清退）
    const sem = semRef.current
    while (sem.waiters.length > 0) sem.waiters.shift()!()
    setProgress({
      loading: { ...EMPTY_LOADING },
      progress: { ...EMPTY_PROGRESS },
    })
    bump()
  }, [bump])

  return {
    ...progress,
    version,
    loadedRange: rangeRef.current,
    startPreload,
    loadL3,
    getFrames,
    extendRange,
    reset,
  }
}
