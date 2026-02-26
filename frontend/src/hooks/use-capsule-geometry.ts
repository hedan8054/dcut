import { useMemo } from 'react'
import type { FrameData } from '@/hooks/use-multi-res-frames'
import type { ReviewCapsule } from '@/types'

function nearestTimestamp(sorted: number[], target: number): number | null {
  if (sorted.length === 0) return null
  if (target <= sorted[0]) return sorted[0]
  if (target >= sorted[sorted.length - 1]) return sorted[sorted.length - 1]

  let lo = 0
  let hi = sorted.length - 1
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const value = sorted[mid]
    if (value === target) return value
    if (value < target) lo = mid + 1
    else hi = mid - 1
  }

  const left = sorted[Math.max(0, hi)]
  const right = sorted[Math.min(sorted.length - 1, lo)]
  return Math.abs(target - left) <= Math.abs(right - target) ? left : right
}

export interface FramePoint {
  timestamp: number
  left: number
  right: number
  top: number
  bottom: number
  cx: number
  cy: number
  row: number
  col: number
}

export interface RowBounds {
  top: number
  bottom: number
  left: number
  right: number
}

export interface SegmentGeometry {
  row: number
  left: number
  width: number
  top: number
  height: number
  startTs: number
  endTs: number
  isStart: boolean
  isEnd: boolean
  samples: FrameData[]
}

export interface CapsuleGeometry {
  capsule: ReviewCapsule
  startTs: number
  endTs: number
  startRow: number
  endRow: number
  segments: SegmentGeometry[]
}

export interface DragPreviewRange {
  capsuleId: number
  start: number
  end: number
}

interface UseCapsuleGeometryOptions {
  capsules: ReviewCapsule[]
  dragPreview: DragPreviewRange | null
  sampleFrames: FrameData[]
  frameSourceMap: Map<number, FrameData>
  frameMap: Map<number, FramePoint>
  rowPoints: Map<number, FramePoint[]>
  rowBounds: Map<number, RowBounds>
  sortedTimestamps: number[]
  layoutVersion: number
}

export function useCapsuleGeometry({
  capsules,
  dragPreview,
  sampleFrames,
  frameSourceMap,
  frameMap,
  rowPoints,
  rowBounds,
  sortedTimestamps,
  layoutVersion,
}: UseCapsuleGeometryOptions) {
  const capsuleRanges = useMemo(() => {
    const map = new Map<number, { start: number; end: number }>()
    for (const capsule of capsules) {
      map.set(capsule.id, {
        start: capsule.start_sec,
        end: capsule.end_sec,
      })
    }
    if (dragPreview) {
      map.set(dragPreview.capsuleId, {
        start: dragPreview.start,
        end: dragPreview.end,
      })
    }
    return map
  }, [capsules, dragPreview])

  const capsulesSorted = useMemo(() => {
    return [...capsules].sort((a, b) => (a.z_index - b.z_index) || (a.id - b.id))
  }, [capsules])

  const capsuleGeometries = useMemo<CapsuleGeometry[]>(() => {
    const geometries: CapsuleGeometry[] = []
    if (sortedTimestamps.length === 0) return geometries

    for (const capsule of capsulesSorted) {
      const range = capsuleRanges.get(capsule.id)
      if (!range) continue

      const startTs = nearestTimestamp(sortedTimestamps, range.start)
      const endTs = nearestTimestamp(sortedTimestamps, range.end)
      if (startTs == null || endTs == null) continue

      const normalizedStart = Math.min(startTs, endTs)
      const normalizedEnd = Math.max(startTs, endTs)
      const startPoint = frameMap.get(normalizedStart)
      const endPoint = frameMap.get(normalizedEnd)
      if (!startPoint || !endPoint) continue

      const startRow = Math.min(startPoint.row, endPoint.row)
      const endRow = Math.max(startPoint.row, endPoint.row)
      const segments: SegmentGeometry[] = []

      for (let row = startRow; row <= endRow; row++) {
        const points = rowPoints.get(row)
        const bounds = rowBounds.get(row)
        if (!points || points.length === 0 || !bounds) continue

        const rowStartPoint = row === startPoint.row ? startPoint : points[0]
        const rowEndPoint = row === endPoint.row ? endPoint : points[points.length - 1]

        const segLeft = Math.min(rowStartPoint.left, rowEndPoint.left)
        const segRight = Math.max(rowStartPoint.right, rowEndPoint.right)

        const segStartTs = row === startPoint.row ? normalizedStart : points[0].timestamp
        const segEndTs = row === endPoint.row ? normalizedEnd : points[points.length - 1].timestamp

        const sampleCandidates = sampleFrames
          .filter(f => f.timestamp >= segStartTs && f.timestamp <= segEndTs && !!f.url)
          .slice(0, 120)
        const sampleMap = new Map<number, FrameData>()
        for (const frame of sampleCandidates) sampleMap.set(frame.timestamp, frame)
        const startFrame = frameSourceMap.get(segStartTs)
        const endFrame = frameSourceMap.get(segEndTs)
        if (startFrame) sampleMap.set(segStartTs, startFrame)
        if (endFrame) sampleMap.set(segEndTs, endFrame)

        const sampleList = Array.from(sampleMap.values()).sort((a, b) => a.timestamp - b.timestamp)

        segments.push({
          row,
          left: segLeft,
          width: Math.max(8, segRight - segLeft),
          top: bounds.top,
          height: bounds.bottom - bounds.top,
          startTs: segStartTs,
          endTs: segEndTs,
          isStart: row === startPoint.row,
          isEnd: row === endPoint.row,
          samples: sampleList,
        })
      }

      if (segments.length === 0) continue

      geometries.push({
        capsule,
        startTs: normalizedStart,
        endTs: normalizedEnd,
        startRow,
        endRow,
        segments,
      })
    }

    return geometries
  }, [
    capsuleRanges,
    capsulesSorted,
    frameMap,
    frameSourceMap,
    layoutVersion,
    rowBounds,
    rowPoints,
    sampleFrames,
    sortedTimestamps,
  ])

  return {
    capsuleRanges,
    capsulesSorted,
    capsuleGeometries,
  }
}
