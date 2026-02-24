import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { batchFrames } from '@/api/client'
import { runWithLimit } from '@/lib/async-utils'

export type GlobalOverviewZoom = '1s' | '10s' | '60s' | '2min'

export interface GlobalOverviewFrame {
  timestamp: number
  url: string
}

const GLOBAL_FRAME_W = 90
const GLOBAL_FRAME_H = 160
const BATCH_SIZE = 240
const MAX_BATCH_CONCURRENCY = 2

function computeIntervalSec(duration: number, frameSlots: number, zoomLevel: GlobalOverviewZoom) {
  if (duration <= 0) return zoomLevel === '1s' ? 1 : 5
  const density =
    zoomLevel === '1s' ? 2
      : zoomLevel === '10s' ? 1
        : zoomLevel === '60s' ? 0.8
          : 0.6
  const raw = duration / Math.max(1, frameSlots * density)
  const base = zoomLevel === '1s' ? 1 : 5
  return Math.max(base, Math.round(raw / base) * base)
}

function buildSampleTimestamps(
  duration: number,
  frameSlots: number,
  intervalSec: number,
  zoomLevel: GlobalOverviewZoom,
) {
  if (duration <= 0 || intervalSec <= 0 || frameSlots <= 0) return [] as number[]

  const density =
    zoomLevel === '1s' ? 2
      : zoomLevel === '10s' ? 1
        : zoomLevel === '60s' ? 0.8
          : 0.6
  const targetCount = Math.max(2, Math.round(frameSlots * density))
  const maxGridTs = Math.floor(duration / intervalSec) * intervalSec
  if (maxGridTs <= 0) return [0]

  const set = new Set<number>()
  for (let i = 0; i < targetCount; i++) {
    const ratio = targetCount === 1 ? 0 : i / (targetCount - 1)
    const raw = ratio * duration
    const snapped = Math.round(raw / intervalSec) * intervalSec
    const clamped = Math.max(0, Math.min(maxGridTs, snapped))
    set.add(Math.round(clamped))
  }
  set.add(0)
  set.add(maxGridTs)
  return Array.from(set).sort((a, b) => a - b)
}

export function useGlobalFocusWindows(
  videoPath: string,
  videoId: number | undefined,
  duration: number,
  frameSlots: number,
  zoomLevel: GlobalOverviewZoom,
) {
  const cacheRef = useRef(new Map<string, string>())
  const sessionRef = useRef(0)
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<[number, number]>([0, 0])

  const intervalSec = useMemo(
    () => computeIntervalSec(duration, frameSlots, zoomLevel),
    [duration, frameSlots, zoomLevel],
  )

  const timestamps = useMemo(
    () => buildSampleTimestamps(duration, frameSlots, intervalSec, zoomLevel),
    [duration, frameSlots, intervalSec, zoomLevel],
  )

  const makeCacheKey = useCallback(
    (timestamp: number) => `${videoId ?? `path:${videoPath}`}|${GLOBAL_FRAME_W}x${GLOBAL_FRAME_H}|${timestamp}`,
    [videoId, videoPath],
  )

  useEffect(() => {
    sessionRef.current += 1
    if (!videoPath || timestamps.length === 0) {
      setLoading(false)
      setProgress([0, timestamps.length])
      return
    }

    const sid = sessionRef.current
    const missing = timestamps.filter(t => !cacheRef.current.has(makeCacheKey(t)))
    let done = timestamps.length - missing.length
    setProgress([done, timestamps.length])

    if (missing.length === 0) {
      setLoading(false)
      setVersion(v => v + 1)
      return
    }

    setLoading(true)
    const batches: number[][] = []
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      batches.push(missing.slice(i, i + BATCH_SIZE))
    }

    runWithLimit(batches, MAX_BATCH_CONCURRENCY, async batch => {
      if (sessionRef.current !== sid) return
      try {
        const res = await batchFrames({
          path: videoPath,
          video_id: videoId,
          timestamps: batch,
          w: GLOBAL_FRAME_W,
          h: GLOBAL_FRAME_H,
        })
        if (sessionRef.current !== sid) return

        for (const frame of res.frames) {
          if (!frame.url) continue
          cacheRef.current.set(makeCacheKey(Math.round(frame.timestamp)), frame.url)
        }
        done += batch.length
        setProgress([done, timestamps.length])
        setVersion(v => v + 1)
      } catch (err) {
        console.error('[GlobalOverview] 抽帧失败', err)
      }
    }).finally(() => {
      if (sessionRef.current !== sid) return
      setLoading(false)
      setProgress([timestamps.length, timestamps.length])
      setVersion(v => v + 1)
    })
  }, [makeCacheKey, timestamps, videoId, videoPath])

  const frames: GlobalOverviewFrame[] = useMemo(
    () => timestamps.map(ts => ({
      timestamp: ts,
      url: cacheRef.current.get(makeCacheKey(ts)) || '',
    })),
    [timestamps, makeCacheKey, version],
  )

  return {
    frames,
    loading,
    progress,
    intervalSec,
    frameSlots: timestamps.length,
  }
}
