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

/** 限制并发数的批处理执行器 */
const MAX_BATCH_CONCURRENCY = 2

async function runWithLimit<T>(
  items: T[], limit: number, worker: (item: T) => Promise<void>,
) {
  let idx = 0
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (idx < items.length) {
        const cur = items[idx++]
        await worker(cur)
      }
    },
  )
  await Promise.all(runners)
}

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
 * 多分辨率帧缓存 hook
 *
 * L1: 30s — 全局 filmstrip，覆盖整个视频
 * L2: 10s — 局部 filmstrip 默认层（±10min）
 * L3: 1s — 局部 filmstrip 放大层（±2min，按需加载）
 *
 * ref 存缓存避免闭包过期，state 存进度触发渲染
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

  const [progress, setProgress] = useState<MultiResProgress>({
    loading: { ...EMPTY_LOADING },
    progress: { ...EMPTY_PROGRESS },
  })

  const [version, setVersion] = useState(0)
  const bump = useCallback(() => setVersion(v => v + 1), [])

  /** 内部：加载指定层级指定范围的帧 */
  const loadRange = useCallback(async (
    videoPath: string,
    videoId: number | undefined,
    layer: ResLayer,
    start: number,
    end: number,
    sid: number,
  ) => {
    const config = LAYER_CONFIG[layer]
    const allTs = generateTimestamps(start, end, config.interval, videoDuration)
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

    // 限制并发为 MAX_BATCH_CONCURRENCY，每批完成后增量更新进度
    let done = 0
    try {
      await runWithLimit(batches, MAX_BATCH_CONCURRENCY, async (batch) => {
        if (sessionRef.current !== sid) return
        try {
          const result = await batchFrames({
            path: videoPath,
            video_id: videoId,
            timestamps: batch,
            w: config.frameW, h: config.frameH,
          })
          if (sessionRef.current !== sid) return

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
          console.error(`[${layer}] 批量抽帧失败:`, err)
        }
      })
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
   * 启动预加载 — 场次选择时调用
   * 默认仅预加载 L2（锚点 ±10min），避免全局首屏被 L1 拖慢
   */
  const startPreload = useCallback((videoPath: string, anchorSec: number, videoId?: number) => {
    const sid = ++sessionRef.current

    // 用户马上需要看到的是局部 L2
    loadRange(videoPath, videoId, 'L2', anchorSec - 10 * 60, anchorSec + 10 * 60, sid)
  }, [loadRange])

  /** 按需加载 L3（局部 1s 放大），用户 zoom 到 1s 时调用 */
  const loadL3 = useCallback((videoPath: string, centerSec: number, videoId?: number) => {
    const sid = sessionRef.current
    const halfRange = 2 * 60 // ±2min
    loadRange(videoPath, videoId, 'L3', centerSec - halfRange, centerSec + halfRange, sid)
  }, [loadRange])

  /** 获取指定层级指定范围内的帧 */
  const getFrames = useCallback((
    layer: ResLayer, startSec: number, endSec: number,
  ): FrameData[] => {
    const config = LAYER_CONFIG[layer]
    const cache = cacheRef.current[layer]
    const frames: FrameData[] = []

    const s = Math.max(0, Math.ceil(startSec / config.interval) * config.interval)
    const e = Math.min(videoDuration, endSec)
    for (let t = s; t <= e; t += config.interval) {
      const ts = Math.round(t * 10) / 10
      const url = cache.get(ts)
      if (url) frames.push({ timestamp: ts, url })
    }
    return frames
  }, [videoDuration])

  /** 平移时增量加载 */
  const extendRange = useCallback((
    videoPath: string,
    videoId: number | undefined,
    layer: ResLayer,
    newStart: number,
    newEnd: number,
  ) => {
    const sid = sessionRef.current
    const existing = rangeRef.current[layer]

    if (!existing) {
      loadRange(videoPath, videoId, layer, newStart, newEnd, sid)
      return
    }

    const [es, ee] = existing
    // 新窗口与已加载窗口完全不相交时，只补当前窗口，避免跨小时“补桥”导致长时间空白
    if (newEnd < es || newStart > ee) {
      rangeRef.current[layer] = null
      loadRange(videoPath, videoId, layer, newStart, newEnd, sid)
      return
    }

    if (newStart < es) loadRange(videoPath, videoId, layer, newStart, es, sid)
    if (newEnd > ee) loadRange(videoPath, videoId, layer, ee, newEnd, sid)
  }, [loadRange])

  /** 重置缓存（切换 lead / 切换场次） */
  const reset = useCallback(() => {
    sessionRef.current++
    cacheRef.current = { L1: new Map(), L2: new Map(), L3: new Map() }
    rangeRef.current = { L1: null, L2: null, L3: null }
    inFlightRef.current = { L1: 0, L2: 0, L3: 0 }
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
