import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Monitor } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { FocusRangeSlider } from './FocusRangeSlider'
import { DiagPanel, useDiagState } from './DiagPanel'
import { formatSec } from '@/lib/format'
import type { FrameData } from '@/hooks/use-multi-res-frames'
import { useCapsuleGeometry, type FramePoint, type RowBounds } from '@/hooks/use-capsule-geometry'
import { useDragInteraction } from '@/hooks/use-drag-interaction'
import type { TimeRange } from '@/lib/timeline-range'
import type { CapsuleInteractionState, ReviewCapsule } from '@/types'

const FRAME_SIZES = [
  { w: 36, h: 64 },   // 默认
  { w: 54, h: 96 },
  { w: 72, h: 128 },
] as const
const WAVEFORM_H = 0
const LABEL_W = 76
const ROW_GAP = 24
const BOTTOM_RESERVED = 170
const MIN_SPAN_SEC = 2
const AUTO_SCROLL_EDGE_PX = 24
const AUTO_SCROLL_MAX_PX = 18
const DRAG_THRESHOLD_PX = 6

export type ZoomLevel = '1s' | '10s' | '60s' | '2min'

interface Props {
  anchorSec: number
  playbackSec: number
  displayRange: TimeRange
  coarseRange: TimeRange
  focusRange: TimeRange
  onFocusRangeChange: (range: TimeRange) => void
  frames: FrameData[]
  sampleFrames: FrameData[]
  loading: boolean
  progress: [number, number]
  capsules: ReviewCapsule[]
  activeCapsuleId: number | null
  onFrameSelect: (timestamp: number) => void
  onCreateCapsule: (range: { start_sec: number; end_sec: number }) => void
  onUpdateCapsule: (capsuleId: number, patch: { start_sec?: number; end_sec?: number }) => void
  onActivateCapsule: (capsuleId: number) => void
  onInteractionStateChange?: (state: CapsuleInteractionState) => void
  onViewportCapacityChange?: (capacity: number) => void
}

interface DisplayFrame extends FrameData {
  width: number
  compressed: boolean
  compressedGroup: 'none' | 'active' | 'other'
}

type DragMode = 'create' | 'resize-start' | 'resize-end' | 'move'

interface DragState {
  mode: DragMode
  capsuleId?: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  originStart?: number
  originEnd?: number
  originSnapTs?: number
  currentStart?: number
  currentEnd?: number
}

interface RubberBandInfo {
  frameCount: number
  startSec: number
  endSec: number
}

interface DragTimeHint {
  capsuleId: number
  mode: 'resize-start' | 'resize-end' | 'move'
  startSec: number
  endSec: number
}

function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  if (!node) return null
  let current: HTMLElement | null = node
  while (current) {
    const style = window.getComputedStyle(current)
    const y = style.overflowY
    const x = style.overflowX
    const scrollable = /(auto|scroll|overlay)/.test(`${x} ${y}`)
    if (scrollable && (current.scrollHeight > current.clientHeight || current.scrollWidth > current.clientWidth)) {
      return current
    }
    current = current.parentElement
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null
}

function nearestTimestamp(sorted: number[], target: number): number | null {
  if (sorted.length === 0) return null
  if (target <= sorted[0]) return sorted[0]
  if (target >= sorted[sorted.length - 1]) return sorted[sorted.length - 1]

  let lo = 0
  let hi = sorted.length - 1
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const v = sorted[mid]
    if (v === target) return v
    if (v < target) lo = mid + 1
    else hi = mid - 1
  }

  const left = sorted[Math.max(0, hi)]
  const right = sorted[Math.min(sorted.length - 1, lo)]
  return Math.abs(target - left) <= Math.abs(right - target) ? left : right
}

function floorTimestamp(sorted: number[], target: number): number | null {
  if (sorted.length === 0) return null
  if (target < sorted[0]) return null
  let lo = 0
  let hi = sorted.length - 1
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (sorted[mid] <= target) lo = mid + 1
    else hi = mid - 1
  }
  return sorted[Math.max(0, hi)]
}

function ceilTimestamp(sorted: number[], target: number): number | null {
  if (sorted.length === 0) return null
  if (target > sorted[sorted.length - 1]) return null
  let lo = 0
  let hi = sorted.length - 1
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (sorted[mid] < target) lo = mid + 1
    else hi = mid - 1
  }
  return sorted[Math.min(sorted.length - 1, lo)]
}

export function MultiRowTimeline({
  anchorSec,
  playbackSec,
  displayRange,
  coarseRange,
  focusRange,
  onFocusRangeChange,
  frames,
  sampleFrames,
  loading,
  progress,
  capsules,
  activeCapsuleId,
  onFrameSelect,
  onCreateCapsule,
  onUpdateCapsule,
  onActivateCapsule,
  onInteractionStateChange,
  onViewportCapacityChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const framePointsRef = useRef<FramePoint[]>([])
  const rowBoundsRef = useRef<Map<number, RowBounds>>(new Map())
  const rowPointsRef = useRef<Map<number, FramePoint[]>>(new Map())
  const frameMapRef = useRef<Map<number, FramePoint>>(new Map())
  const sortedTimestampsRef = useRef<number[]>([])
  const scrollParentRef = useRef<HTMLElement | null>(null)
  const pendingCreateCleanupRef = useRef<(() => void) | null>(null)

  const [framesPerRow, setFramesPerRow] = useState(20)
  const [frameSizeIdx, setFrameSizeIdx] = useState(0) // 0=64h, 1=96h, 2=128h
  const FRAME_W = FRAME_SIZES[frameSizeIdx].w
  const FRAME_H = FRAME_SIZES[frameSizeIdx].h
  const [zoomLevel, setZoomLevel] = useState(1) // 1s, 10s, 30s, 60s 每帧间隔
  const [layoutVersion, setLayoutVersion] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [interactionState, setInteractionState] = useState<CapsuleInteractionState>('idle')
  const [rubberBand, setRubberBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [rubberBandInfo, setRubberBandInfo] = useState<RubberBandInfo | null>(null)
  const [dragPreview, setDragPreview] = useState<{ capsuleId: number; start: number; end: number } | null>(null)
  const [dragTimeHint, setDragTimeHint] = useState<DragTimeHint | null>(null)

  const {
    rbDiagEnabled,
    rbFixVersion,
    diagEvents,
    diagDragStartCount,
    diagLastMouseMove,
    diagSnapTarget,
    diagAutoScroll,
    pushDiagEvent,
    setDiagSnapTarget,
    setDiagAutoScroll,
  } = useDiagState()

  const setInteraction = useCallback((next: CapsuleInteractionState) => {
    setInteractionState((prev) => (prev === next ? prev : next))
    onInteractionStateChange?.(next)
  }, [onInteractionStateChange])

  const dedupedFrames = useMemo(() => {
    const map = new Map<number, FrameData>()
    for (const frame of frames) {
      map.set(frame.timestamp, frame)
    }
    return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp)
  }, [frames])

  // 按 zoomLevel 子采样，减少重复帧提高浏览效率
  const zoomedFrames = useMemo(() => {
    if (zoomLevel <= 1 || dedupedFrames.length === 0) return dedupedFrames
    const base = dedupedFrames[0].timestamp
    return dedupedFrames.filter(f => Math.round(f.timestamp - base) % zoomLevel === 0)
  }, [dedupedFrames, zoomLevel])

  const frameInterval = useMemo(() => {
    if (zoomedFrames.length < 2) return Math.max(1, zoomLevel)
    let minDiff = Number.POSITIVE_INFINITY
    for (let i = 1; i < zoomedFrames.length; i++) {
      const diff = zoomedFrames[i].timestamp - zoomedFrames[i - 1].timestamp
      if (diff > 0 && diff < minDiff) minDiff = diff
    }
    if (!Number.isFinite(minDiff)) return Math.max(1, zoomLevel)
    return Math.max(1, Math.round(minDiff))
  }, [zoomedFrames, zoomLevel])

  const activeCapsule = useMemo(
    () => capsules.find(c => c.id === activeCapsuleId) ?? null,
    [capsules, activeCapsuleId],
  )

  // activeCompression 仅用于 badge 展示
  const activeCompression = useMemo(() => {
    if (!activeCapsule) return null
    const start = Math.min(activeCapsule.start_sec, activeCapsule.end_sec)
    const end = Math.max(activeCapsule.start_sec, activeCapsule.end_sec)
    const sampleInterval = Math.max(1, Math.round(activeCapsule.sample_interval_sec || 10))
    const ratio = Math.max(0.25, Math.min(0.9, activeCapsule.compression_ratio || 0.5))
    const frameWidth = Math.max(12, Math.round(FRAME_W * ratio))
    return { start, end, sampleInterval, frameWidth }
  }, [activeCapsule])

  // 所有胶囊的压缩区域 — 确保非 active 的胶囊也保持压缩
  const allCompressions = useMemo(() => {
    return capsules.map(c => {
      const start = Math.min(c.start_sec, c.end_sec)
      const end = Math.max(c.start_sec, c.end_sec)
      const sampleInterval = Math.max(1, Math.round(c.sample_interval_sec || 10))
      const ratio = Math.max(0.25, Math.min(0.9, c.compression_ratio || 0.5))
      const frameWidth = Math.max(12, Math.round(FRAME_W * ratio))
      return { capsuleId: c.id, start, end, sampleInterval, frameWidth }
    })
  }, [capsules])

  const displayFrames = useMemo<DisplayFrame[]>(() => {
    if (allCompressions.length === 0) {
      return zoomedFrames.map((frame) => ({
        ...frame,
        width: FRAME_W,
        compressed: false,
        compressedGroup: 'none',
      }))
    }

    const result: DisplayFrame[] = []

    // 为 active 胶囊用 sampleFrames（高精度），其他胶囊用 modulo 采样
    const activeSampleSet = new Set<number>()
    if (activeCapsuleId != null) {
      for (const sf of sampleFrames) activeSampleSet.add(sf.timestamp)
    }

    for (const frame of zoomedFrames) {
      // 找到包含此帧的压缩区域（优先 active 胶囊）
      let zone = allCompressions.find(
        z => z.capsuleId === activeCapsuleId && frame.timestamp >= z.start && frame.timestamp <= z.end,
      )
      if (!zone) {
        zone = allCompressions.find(
          z => frame.timestamp >= z.start && frame.timestamp <= z.end,
        )
      }

      if (!zone) {
        // 不在任何胶囊范围内 — 原始尺寸
        result.push({ ...frame, width: FRAME_W, compressed: false, compressedGroup: 'none' })
        continue
      }

      const isActiveZone = zone.capsuleId === activeCapsuleId
      const relOffset = frame.timestamp - zone.start
      const zoneSpan = zone.end - zone.start

      // 首尾帧始终保留
      const isEdge = relOffset === 0 || frame.timestamp >= zone.end
      // active 胶囊用 sampleFrames 集合，其他用 modulo
      const isSample = isActiveZone
        ? activeSampleSet.has(frame.timestamp)
        : (zoneSpan > 0 && relOffset % zone.sampleInterval === 0)

      if (isEdge || isSample) {
        result.push({
          ...frame,
          width: zone.frameWidth,
          compressed: true,
          compressedGroup: isActiveZone ? 'active' : 'other',
        })
      }
      // else: 被压缩跳过
    }

    return result
  }, [allCompressions, activeCapsuleId, zoomedFrames, sampleFrames])

  const frameSourceMap = useMemo(() => {
    const map = new Map<number, FrameData>()
    for (const frame of dedupedFrames) map.set(frame.timestamp, frame)
    for (const frame of sampleFrames) {
      if (!map.has(frame.timestamp)) map.set(frame.timestamp, frame)
    }
    return map
  }, [dedupedFrames, sampleFrames])

  const rows = useMemo(() => {
    const maxRowWidth = Math.max(FRAME_W * 3, framesPerRow * FRAME_W)
    const packed: Array<Array<DisplayFrame & { colIndex: number }>> = []
    let current: Array<DisplayFrame & { colIndex: number }> = []
    let usedW = 0
    let colIndex = 0

    for (const frame of displayFrames) {
      if (current.length > 0 && usedW + frame.width > maxRowWidth) {
        packed.push(current)
        current = []
        usedW = 0
        colIndex = 0
      }
      current.push({ ...frame, colIndex })
      colIndex += 1
      usedW += frame.width
    }

    if (current.length > 0) packed.push(current)
    return packed
  }, [displayFrames, framesPerRow])

  const collectFrameLayout = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return

    const gridRect = grid.getBoundingClientRect()
    const points: FramePoint[] = []
    const map = new Map<number, FramePoint>()
    const rowBounds = new Map<number, RowBounds>()
    const rowPoints = new Map<number, FramePoint[]>()

    const frameEls = grid.querySelectorAll<HTMLElement>('[data-timestamp]')
    frameEls.forEach((el) => {
      const ts = Number(el.dataset.timestamp)
      if (!Number.isFinite(ts)) return

      const row = Number(el.dataset.rowIndex ?? -1)
      const col = Number(el.dataset.colIndex ?? -1)
      const rect = el.getBoundingClientRect()
      const point: FramePoint = {
        timestamp: ts,
        left: rect.left - gridRect.left,
        right: rect.right - gridRect.left,
        top: rect.top - gridRect.top,
        bottom: rect.bottom - gridRect.top,
        cx: rect.left + rect.width / 2 - gridRect.left,
        cy: rect.top + rect.height / 2 - gridRect.top,
        row,
        col,
      }
      points.push(point)
      map.set(ts, point)

      if (!rowPoints.has(row)) rowPoints.set(row, [])
      rowPoints.get(row)!.push(point)

      const prev = rowBounds.get(row)
      if (!prev) {
        rowBounds.set(row, {
          top: point.top,
          bottom: point.bottom,
          left: point.left,
          right: point.right,
        })
      } else {
        rowBounds.set(row, {
          top: Math.min(prev.top, point.top),
          bottom: Math.max(prev.bottom, point.bottom),
          left: Math.min(prev.left, point.left),
          right: Math.max(prev.right, point.right),
        })
      }
    })

    points.sort((a, b) => a.timestamp - b.timestamp)
    for (const [row, list] of rowPoints.entries()) {
      list.sort((a, b) => (a.col - b.col) || (a.timestamp - b.timestamp))
      rowPoints.set(row, list)
    }

    framePointsRef.current = points
    frameMapRef.current = map
    rowBoundsRef.current = rowBounds
    rowPointsRef.current = rowPoints
    sortedTimestampsRef.current = points.map(p => p.timestamp)
    setLayoutVersion(v => v + 1)
  }, [])

  const findNearestFrame = useCallback((clientX: number, clientY: number): FramePoint | null => {
    const grid = gridRef.current
    if (!grid) return null
    const gridRect = grid.getBoundingClientRect()
    const x = clientX - gridRect.left
    const y = clientY - gridRect.top

    // 判断点击是否在行间距中（帧区域上方的空白）
    // 如果是，只匹配下方行的帧，不匹配上方行
    let clickInGap = false
    let gapBelowRowTop = Infinity
    for (const [, bounds] of rowBoundsRef.current) {
      if (y < bounds.top && y >= bounds.top - ROW_GAP) {
        clickInGap = true
        gapBelowRowTop = bounds.top
        break
      }
    }

    let best: FramePoint | null = null
    let bestD2 = Number.POSITIVE_INFINITY
    for (const fp of framePointsRef.current) {
      // 在行间距中点击时，跳过上方行的帧（只匹配下方行）
      if (clickInGap && fp.top < gapBelowRowTop) continue
      const dx = fp.cx - x
      const dy = fp.cy - y
      const d2 = dx * dx + dy * dy
      if (d2 < bestD2) {
        bestD2 = d2
        best = fp
      }
    }
    return best
  }, [])

  const getNearestTimestamp = useCallback((target: number): number | null => {
    return nearestTimestamp(sortedTimestampsRef.current, target)
  }, [])

  const startCreateDrag = useCallback((clientX: number, clientY: number) => {
    dragRef.current = {
      mode: 'create',
      startX: clientX,
      startY: clientY,
      lastX: clientX,
      lastY: clientY,
    }
    setRubberBand({ x: clientX, y: clientY, w: 0, h: 0 })
    setRubberBandInfo(null)
    setDragTimeHint(null)
    setDragging(true)
    setInteraction('dragging')
  }, [setInteraction])

  const startCapsuleDrag = useCallback((
    mode: 'resize-start' | 'resize-end' | 'move',
    capsule: ReviewCapsule,
    clientX: number,
    clientY: number,
  ) => {
    const nearest = findNearestFrame(clientX, clientY)
    if (!nearest) return

    const baseStart = dragPreview?.capsuleId === capsule.id ? dragPreview.start : capsule.start_sec
    const baseEnd = dragPreview?.capsuleId === capsule.id ? dragPreview.end : capsule.end_sec

    dragRef.current = {
      mode,
      capsuleId: capsule.id,
      startX: clientX,
      startY: clientY,
      lastX: clientX,
      lastY: clientY,
      originStart: baseStart,
      originEnd: baseEnd,
      originSnapTs: nearest.timestamp,
      currentStart: baseStart,
      currentEnd: baseEnd,
    }
    setDragPreview({ capsuleId: capsule.id, start: baseStart, end: baseEnd })
    setDragTimeHint({
      capsuleId: capsule.id,
      mode,
      startSec: baseStart,
      endSec: baseEnd,
    })
    setDragging(true)
    setInteraction('dragging')
    onActivateCapsule(capsule.id)
  }, [dragPreview, findNearestFrame, onActivateCapsule, setInteraction])

  const updateDragPreview = useCallback((capsuleId: number, startSec: number, endSec: number) => {
    setDragPreview((prev) => {
      if (
        prev
        && prev.capsuleId === capsuleId
        && Math.abs(prev.start - startSec) < 1e-3
        && Math.abs(prev.end - endSec) < 1e-3
      ) {
        return prev
      }
      return { capsuleId, start: startSec, end: endSec }
    })
  }, [])

  const processPointer = useCallback((clientX: number, clientY: number) => {
    const ds = dragRef.current
    if (!ds) return
    ds.lastX = clientX
    ds.lastY = clientY

    if (ds.mode === 'create') {
      const x = Math.min(ds.startX, clientX)
      const y = Math.min(ds.startY, clientY)
      const w = Math.abs(clientX - ds.startX)
      const h = Math.abs(clientY - ds.startY)
      setRubberBand({ x, y, w, h })

      const grid = gridRef.current
      if (!grid) {
        setRubberBandInfo(null)
        return
      }

      const gridRect = grid.getBoundingClientRect()
      const selected = framePointsRef.current
        .filter(fp => {
          const cx = gridRect.left + fp.cx
          const cy = gridRect.top + fp.cy
          return cx >= x && cx <= x + w && cy >= y && cy <= y + h
        })
        .map(fp => fp.timestamp)

      if (selected.length > 0) {
        setRubberBandInfo({
          frameCount: selected.length,
          startSec: Math.min(...selected),
          endSec: Math.max(...selected),
        })
      } else {
        setRubberBandInfo(null)
      }
      return
    }

    if (ds.capsuleId == null || ds.originStart == null || ds.originEnd == null || ds.originSnapTs == null) return
    const nearest = findNearestFrame(clientX, clientY)
    if (!nearest) return

    setDiagSnapTarget(nearest.timestamp)

    const sorted = sortedTimestampsRef.current
    if (sorted.length < 2) return
    const minTs = sorted[0]
    const maxTs = sorted[sorted.length - 1]

    if (ds.mode === 'resize-start') {
      const maxAllowed = ds.originEnd - MIN_SPAN_SEC
      const clamped = Math.min(nearest.timestamp, maxAllowed)
      const floor = floorTimestamp(sorted, clamped)
      const fallback = nearestTimestamp(sorted, clamped)
      const nextStart = floor ?? fallback
      if (nextStart == null) return
      ds.currentStart = nextStart
      ds.currentEnd = ds.originEnd
      updateDragPreview(ds.capsuleId, nextStart, ds.originEnd)
      setDragTimeHint({
        capsuleId: ds.capsuleId,
        mode: ds.mode,
        startSec: nextStart,
        endSec: ds.originEnd,
      })
      return
    }

    if (ds.mode === 'resize-end') {
      const minAllowed = ds.originStart + MIN_SPAN_SEC
      const clamped = Math.max(nearest.timestamp, minAllowed)
      const ceil = ceilTimestamp(sorted, clamped)
      const fallback = nearestTimestamp(sorted, clamped)
      const nextEnd = ceil ?? fallback
      if (nextEnd == null) return
      ds.currentStart = ds.originStart
      ds.currentEnd = nextEnd
      updateDragPreview(ds.capsuleId, ds.originStart, nextEnd)
      setDragTimeHint({
        capsuleId: ds.capsuleId,
        mode: ds.mode,
        startSec: ds.originStart,
        endSec: nextEnd,
      })
      return
    }

    const span = ds.originEnd - ds.originStart
    const rawDelta = nearest.timestamp - ds.originSnapTs
    const lowerBound = minTs
    const upperBound = maxTs - span
    let nextStart = ds.originStart + rawDelta
    nextStart = Math.max(lowerBound, Math.min(upperBound, nextStart))
    let nextEnd = nextStart + span

    const snappedStart = getNearestTimestamp(nextStart) ?? nextStart
    const snappedEnd = getNearestTimestamp(nextEnd) ?? nextEnd

    let finalStart = snappedStart
    let finalEnd = snappedEnd

    if (finalEnd - finalStart < MIN_SPAN_SEC) {
      const ceil = ceilTimestamp(sorted, finalStart + MIN_SPAN_SEC)
      if (ceil != null) {
        finalEnd = ceil
      } else {
        const floor = floorTimestamp(sorted, finalEnd - MIN_SPAN_SEC)
        if (floor != null) finalStart = floor
      }
    }

    ds.currentStart = finalStart
    ds.currentEnd = finalEnd
    updateDragPreview(ds.capsuleId, finalStart, finalEnd)
    setDragTimeHint({
      capsuleId: ds.capsuleId,
      mode: ds.mode,
      startSec: finalStart,
      endSec: finalEnd,
    })
  }, [findNearestFrame, getNearestTimestamp, updateDragPreview])

  const finishDrag = useCallback((clientX: number, clientY: number) => {
    const ds = dragRef.current
    dragRef.current = null
    setDragging(false)
    setInteraction('idle')
    setDiagAutoScroll(null)

    if (!ds) {
      setRubberBand(null)
      setRubberBandInfo(null)
      setDragPreview(null)
      setDragTimeHint(null)
      return
    }

    if (ds.mode === 'create') {
      const dx = Math.abs(clientX - ds.startX)
      const dy = Math.abs(clientY - ds.startY)

      if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX) { // 安全网：延迟拖拽已在上游拦截点击，这里是 fallback
        const nearest = findNearestFrame(clientX, clientY)
        if (nearest) onFrameSelect(nearest.timestamp)
        setRubberBand(null)
        setRubberBandInfo(null)
        setDragTimeHint(null)
        return
      }

      const x = Math.min(ds.startX, clientX)
      const y = Math.min(ds.startY, clientY)
      const w = Math.abs(clientX - ds.startX)
      const h = Math.abs(clientY - ds.startY)

      const selected = framePointsRef.current
        .filter(fp => {
          const grid = gridRef.current
          if (!grid) return false
          const gridRect = grid.getBoundingClientRect()
          const cx = gridRect.left + fp.cx
          const cy = gridRect.top + fp.cy
          return cx >= x && cx <= x + w && cy >= y && cy <= y + h
        })
        .map(fp => fp.timestamp)

      if (selected.length >= 2) {
        const startSec = Math.min(...selected)
        const endSec = Math.max(...selected)
        if (endSec - startSec >= 2) { // Minimum threshold to create capsule
          onCreateCapsule({ start_sec: startSec, end_sec: endSec })
        }
      }

      setRubberBand(null)
      setRubberBandInfo(null)
      setDragTimeHint(null)
      return
    }

    if (ds.capsuleId != null && ds.currentStart != null && ds.currentEnd != null) {
      const changed = ds.originStart != null
        && ds.originEnd != null
        && (Math.abs(ds.originStart - ds.currentStart) > 1e-3 || Math.abs(ds.originEnd - ds.currentEnd) > 1e-3)
      if (changed) {
        onUpdateCapsule(ds.capsuleId, {
          start_sec: ds.currentStart,
          end_sec: ds.currentEnd,
        })
      }
    }

    setDragPreview(null)
    setDragTimeHint(null)
  }, [findNearestFrame, onCreateCapsule, onFrameSelect, onUpdateCapsule, setInteraction])

  useEffect(() => {
    if (interactionState !== 'activating') return undefined
    const timer = window.setTimeout(() => setInteraction('idle'), 140)
    return () => window.clearTimeout(timer)
  }, [interactionState, setInteraction])

  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return undefined

    const onDragStart = (e: DragEvent) => {
      pushDiagEvent(e)
      e.preventDefault()
    }

    grid.addEventListener('dragstart', onDragStart, true)
    return () => {
      grid.removeEventListener('dragstart', onDragStart, true)
    }
  }, [pushDiagEvent])

  // 清理延迟拖拽的临时监听器
  useEffect(() => {
    return () => { pendingCreateCleanupRef.current?.() }
  }, [])

  useDragInteraction({
    dragging,
    processPointer,
    finishDrag,
    collectFrameLayout,
    getDragSnapshot: () => {
      const ds = dragRef.current
      if (!ds) return null
      return {
        lastX: ds.lastX,
        lastY: ds.lastY,
      }
    },
    scrollParentRef,
    onPointerMoveEvent: pushDiagEvent,
    onPointerUpEvent: pushDiagEvent,
    onAutoScrollChange: setDiagAutoScroll,
    autoScrollEdgePx: AUTO_SCROLL_EDGE_PX,
    autoScrollMaxPx: AUTO_SCROLL_MAX_PX,
  })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined

    const updateLayout = () => {
      const rect = el.getBoundingClientRect()
      const trackW = Math.max(120, rect.width - LABEL_W * 2)
      const cols = Math.max(3, Math.floor(trackW / FRAME_W))
      setFramesPerRow(cols)

      const rowH = FRAME_H + WAVEFORM_H + ROW_GAP
      const availableH = Math.max(100, window.innerHeight - rect.top - BOTTOM_RESERVED)
      const visibleRows = Math.max(1, Math.floor((availableH + ROW_GAP) / rowH))
      onViewportCapacityChange?.(cols * visibleRows)

      scrollParentRef.current = findScrollParent(el)
    }

    const ro = new ResizeObserver(() => updateLayout())
    ro.observe(el)
    window.addEventListener('resize', updateLayout)
    updateLayout()

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', updateLayout)
    }
  }, [onViewportCapacityChange, FRAME_W, FRAME_H])

  // Ctrl+滚轮 缩放帧间隔 (1s → 10s → 30s → 60s)
  const ZOOM_LEVELS = [1, 10, 30, 60] as const
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoomLevel(prev => {
        const idx = ZOOM_LEVELS.indexOf(prev as 1 | 10 | 30 | 60)
        const cur = idx >= 0 ? idx : 0
        const next = e.deltaY > 0 ? Math.min(ZOOM_LEVELS.length - 1, cur + 1) : Math.max(0, cur - 1)
        return ZOOM_LEVELS[next]
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // frameSizeIdx 变化后多等一帧让 DOM 更新，再重新收集布局
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => collectFrameLayout())
    })
    return () => cancelAnimationFrame(raf)
  }, [collectFrameLayout, rows, FRAME_W, FRAME_H])

  useEffect(() => {
    const scrollEl = scrollParentRef.current
    if (!scrollEl) return undefined
    let rafPending = false
    const onScroll = () => {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        collectFrameLayout()
        rafPending = false
      })
    }
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    return () => scrollEl.removeEventListener('scroll', onScroll)
  }, [collectFrameLayout, layoutVersion])

  const { capsuleGeometries } = useCapsuleGeometry({
    capsules,
    dragPreview,
    sampleFrames,
    frameSourceMap,
    frameMap: frameMapRef.current,
    rowPoints: rowPointsRef.current,
    rowBounds: rowBoundsRef.current,
    sortedTimestamps: sortedTimestampsRef.current,
    layoutVersion,
  })

  const handleGridPointerDownCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement | null
    if (!target) return

    if (target.closest('[data-capsule-handle]') || target.closest('[data-capsule-body]')) return
    if (target.closest('button,input,textarea,select')) return
    if (!target.closest('[data-timestamp], [data-timeline-track]') && target !== gridRef.current) return

    e.preventDefault()

    // 延迟拖拽：mousedown 只记录位置，移动超阈值才启动拖拽
    const startX = e.clientX
    const startY = e.clientY

    const cleanup = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      pendingCreateCleanupRef.current = null
    }

    const onMove = (me: PointerEvent) => {
      if (Math.hypot(me.clientX - startX, me.clientY - startY) > DRAG_THRESHOLD_PX) {
        cleanup()
        startCreateDrag(startX, startY)
      }
    }

    const onUp = (ue: PointerEvent) => {
      cleanup()
      // 纯点击 → 选中最近帧
      const nearest = findNearestFrame(ue.clientX, ue.clientY)
      if (nearest) onFrameSelect(nearest.timestamp)
    }

    const onCancel = () => { cleanup() }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    pendingCreateCleanupRef.current = cleanup
  }, [findNearestFrame, onFrameSelect, startCreateDrag])

  const handleCapsulePointerDown = useCallback((
    e: React.PointerEvent<HTMLDivElement>,
    mode: 'resize-start' | 'resize-end' | 'move',
    capsule: ReviewCapsule,
  ) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    if (activeCapsuleId !== capsule.id) {
      setInteraction('activating')
      // 放置白针到点击位置
      const nearest = findNearestFrame(e.clientX, e.clientY)
      if (nearest) onFrameSelect(nearest.timestamp)
      // 直接激活被点击的胶囊（不依赖 findNearestFrame 的命中检测）
      onActivateCapsule(capsule.id)
      return
    }
    startCapsuleDrag(mode, capsule, e.clientX, e.clientY)
  }, [activeCapsuleId, findNearestFrame, onActivateCapsule, onFrameSelect, setInteraction, startCapsuleDrag])

  return (
    <div className="space-y-2" ref={containerRef}>
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-sm font-semibold">胶囊时间轴</h3>

        <Badge variant="outline" className="text-[11px] gap-1">
          <Monitor className="w-3 h-3" />
          自动换行 · {rows.length}行
        </Badge>

        {activeCompression && (
          <Badge className="text-[11px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
            胶囊压缩: 1s → {activeCompression.sampleInterval}s · 宽度 x{(activeCompression.frameWidth / FRAME_W).toFixed(2)}
          </Badge>
        )}

        {/* 帧尺寸切换 */}
        <div className="flex items-center gap-1">
          {FRAME_SIZES.map((sz, idx) => (
            <button
              key={sz.h}
              className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                frameSizeIdx === idx
                  ? 'bg-rv-accent text-black font-bold'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted'
              }`}
              onClick={() => setFrameSizeIdx(idx)}
            >
              {sz.h}p
            </button>
          ))}
        </div>

        {/* 缩放指示器 — Ctrl+滚轮切换 */}
        <div className="flex items-center gap-1">
          {([1, 10, 30, 60] as const).map(lvl => (
            <button
              key={lvl}
              className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                zoomLevel === lvl
                  ? 'bg-rv-accent text-black font-bold'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted'
              }`}
              onClick={() => setZoomLevel(lvl)}
            >
              {lvl}s
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <span className="text-[11px] text-muted-foreground font-mono">
          {formatSec(displayRange[0])} → {formatSec(displayRange[1])}
        </span>
        <span className="text-[11px] font-mono">
          <span className="text-white">▎</span>{formatSec(anchorSec)}
        </span>
        {playbackSec > 0 && (
          <span className="text-[11px] font-mono">
            <span className="text-orange-400">▎</span>{formatSec(playbackSec)}
          </span>
        )}
      </div>

      <FocusRangeSlider
        coarseRange={coarseRange}
        focusRange={focusRange}
        minSpanSec={20}
        onChange={onFocusRangeChange}
      />

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>加载中 {progress[0]}/{progress[1]}</span>
          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-rv-accent rounded-full transition-all"
              style={{ width: progress[1] > 0 ? `${(progress[0] / progress[1]) * 100}%` : '0%' }}
            />
          </div>
        </div>
      ) : frames.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-emerald-400">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          就绪 · {frames.length} 帧可浏览，拖框创建胶囊
        </div>
      )}

      <div
        ref={gridRef}
        className="space-y-6 relative pt-6"
        onPointerDownCapture={handleGridPointerDownCapture}
        data-rb-fix-version={rbFixVersion}
        data-rb-diag={rbDiagEnabled ? '1' : '0'}
        data-capsule-interaction={interactionState}
        style={{ userSelect: 'none' }}
      >
        {rows.map((rowFrames, rowIdx) => {
          const rowStart = rowFrames[0]?.timestamp ?? 0
          const rowTailInterval = rowFrames[rowFrames.length - 1]?.compressed ? (activeCompression?.sampleInterval ?? frameInterval) : frameInterval
          const rowEnd = rowFrames.length > 0
            ? rowFrames[rowFrames.length - 1].timestamp + rowTailInterval
            : rowStart + frameInterval

          return (
            <div key={`row-${rowIdx}-${rowStart}`} className="flex items-start gap-0">
              <div className="shrink-0 pt-1" style={{ width: LABEL_W }}>
                <p className="text-[11px] text-[#666] font-mono leading-tight">
                  Row {rowIdx + 1}: {formatSec(rowStart)}
                </p>
              </div>

              <div className="flex-1 min-w-0 relative" data-timeline-track data-row-index={rowIdx}>
                <div className="flex overflow-hidden" style={{ height: FRAME_H }}>
                  {rowFrames.map((frame) => (
                    <div
                      key={`frame-${rowIdx}-${frame.timestamp}-${frame.colIndex}`}
                      data-timestamp={frame.timestamp}
                      data-row-index={rowIdx}
                      data-col-index={frame.colIndex}
                      data-compressed={frame.compressed ? '1' : '0'}
                      className={`shrink-0 cursor-pointer overflow-hidden transition-shadow ${frame.compressed
                        ? frame.compressedGroup === 'active'
                          ? 'ring-1 ring-emerald-400/35'
                          : 'ring-1 ring-cyan-400/30'
                        : 'hover:ring-1 hover:ring-rv-accent/50'
                        }`}
                      style={{ width: frame.width, height: FRAME_H }}
                      draggable={false}
                      title={formatSec(frame.timestamp)}
                    >
                      <div
                        className="w-full h-full bg-cover bg-center bg-no-repeat pointer-events-none select-none"
                        style={{ backgroundImage: `url("${frame.url}")` }}
                      />
                    </div>
                  ))}
                </div>

                {/* 双播放头 — 白针（锚点）+ 橙针（播放位置） */}
                {(() => {
                  const calcX = (sec: number) => {
                    let x = 0
                    for (let i = 0; i < rowFrames.length; i++) {
                      const f = rowFrames[i]
                      const nextTs = i + 1 < rowFrames.length ? rowFrames[i + 1].timestamp : rowEnd
                      if (sec <= f.timestamp) break
                      if (sec >= nextTs) { x += f.width; continue }
                      x += f.width * ((sec - f.timestamp) / Math.max(0.1, nextTs - f.timestamp))
                      break
                    }
                    return x
                  }
                  return (
                    <>
                      {/* 橙针（播放位置）— 在白针下层，空心矩形针头在帧上方 */}
                      {playbackSec > 0 && playbackSec >= rowStart && playbackSec <= rowEnd && (
                        <div
                          className="absolute top-0 pointer-events-none z-[2000]"
                          style={{ left: calcX(playbackSec), height: FRAME_H, transform: 'translateX(-50%)' }}
                        >
                          <div className="absolute -top-[20px] left-1/2 -translate-x-1/2 w-[10px] h-[16px] border-[3px] border-orange-400 pointer-events-auto cursor-grab" />
                          <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-[2px] bg-orange-400/90" />
                        </div>
                      )}
                      {/* 白针（锚点/定位针）— 实心矩形针头在帧上方 */}
                      {anchorSec >= rowStart && anchorSec <= rowEnd && (
                        <div
                          className="absolute top-0 pointer-events-none z-[2001]"
                          style={{ left: calcX(anchorSec), height: FRAME_H, transform: 'translateX(-50%)' }}
                        >
                          <div className="absolute -top-[20px] left-1/2 -translate-x-1/2 w-[10px] h-[16px] bg-white shadow-sm pointer-events-auto cursor-grab" />
                          <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-[2px] bg-white/90" />
                        </div>
                      )}
                    </>
                  )
                })()}
              </div>

              <div className="shrink-0 pt-1 text-right" style={{ width: LABEL_W }}>
                <p className="text-[11px] text-[#666] font-mono leading-tight">
                  {formatSec(rowEnd)}
                </p>
              </div>
            </div>
          )
        })}

        <div className="absolute inset-0 pointer-events-none">
          {capsuleGeometries.map((geo) => {
            const isActive = activeCapsuleId === geo.capsule.id
            const z = 30 + geo.capsule.z_index + (isActive ? 1000 : 0)
            const ratio = Math.max(0.2, Math.min(0.8, geo.capsule.compression_ratio || 0.5))
            const thumbW = FRAME_W * ratio

            return (
              <div key={`capsule-${geo.capsule.id}`} className="absolute inset-0" style={{ zIndex: z }}>
                {geo.segments.map((seg) => (
                  <div
                    key={`capsule-${geo.capsule.id}-row-${seg.row}`}
                    className={`absolute rounded-md border-2 transition-colors ${isActive
                      ? 'border-emerald-400 shadow-[0_0_0_1px_rgba(16,185,129,0.65)]'
                      : 'border-cyan-400/70'
                      }`}
                    data-capsule-segment
                    data-capsule-id={geo.capsule.id}
                    data-capsule-active={isActive ? '1' : '0'}
                    data-seg-start={seg.startTs}
                    data-seg-end={seg.endTs}
                    style={{
                      left: seg.left,
                      top: seg.top,
                      width: seg.width,
                      height: seg.height,
                      background: isActive ? 'rgba(16, 185, 129, 0.15)' : 'rgba(0, 0, 0, 0.45)',
                    }}
                  >
                    <div
                      data-capsule-body
                      data-capsule-id={geo.capsule.id}
                      className={`absolute inset-0 pointer-events-auto overflow-hidden ${isActive
                        ? 'cursor-grab active:cursor-grabbing'
                        : 'cursor-pointer'
                        }`}
                      onPointerDown={(e) => handleCapsulePointerDown(e, 'move', geo.capsule)}
                      title={`${formatSec(geo.startTs)} - ${formatSec(geo.endTs)}`}
                    >
                      <div className="absolute inset-0 overflow-hidden">
                        {seg.samples.length > 0 ? (
                          seg.samples.map((sample, idx) => {
                            const segSpan = Math.max(1, seg.endTs - seg.startTs)
                            const ratioPos = segSpan <= 0 ? 0 : (sample.timestamp - seg.startTs) / segSpan
                            const clamped = Math.max(0, Math.min(1, ratioPos))
                            return (
                              <div
                                key={`sample-${geo.capsule.id}-${seg.row}-${sample.timestamp}`}
                                className="absolute top-[4%] h-[92%] rounded-sm border border-white/15 bg-cover bg-center"
                                style={{
                                  width: thumbW,
                                  left: `calc(${(clamped * 100).toFixed(4)}% - ${thumbW / 2}px)`,
                                  zIndex: idx + 1,
                                  backgroundImage: `url("${sample.url}")`,
                                  opacity: isActive ? 0.95 : 0.6,
                                }}
                              />
                            )
                          })
                        ) : (
                          <div className="absolute inset-0 bg-emerald-500/10" />
                        )}
                      </div>

                      <div className="absolute left-1 top-1 flex items-center gap-1 pointer-events-none">
                        <span className="bg-black/65 text-[9px] text-emerald-200 px-1 rounded font-mono">
                          {formatSec(seg.startTs)}–{formatSec(seg.endTs)}
                        </span>
                        {isActive && (
                          <span className="bg-emerald-400/85 text-[9px] text-black px-1 rounded font-bold">ACTIVE</span>
                        )}
                      </div>

                      {isActive && dragTimeHint && dragTimeHint.capsuleId === geo.capsule.id && dragTimeHint.mode === 'move' && (
                        <div
                          data-capsule-drag-info
                          className="absolute left-1/2 -translate-x-1/2 -top-5 pointer-events-none bg-emerald-500/90 text-black text-[10px] px-1.5 py-0.5 rounded font-mono whitespace-nowrap"
                        >
                          {formatSec(dragTimeHint.startSec)}–{formatSec(dragTimeHint.endSec)}
                        </div>
                      )}
                    </div>

                    {isActive && seg.isStart && (
                      <div
                        data-capsule-handle
                        data-capsule-id={geo.capsule.id}
                        data-side="left"
                        className="absolute left-[-6px] top-0 bottom-0 w-[18px] pointer-events-auto cursor-ew-resize flex items-center justify-center z-[100]"
                        onPointerDown={(e) => handleCapsulePointerDown(e, 'resize-start', geo.capsule)}
                      >
                        <div className="h-full w-[4px] bg-emerald-500/90 shadow-[0_0_0_1px_rgba(16,185,129,0.8)] hover:bg-emerald-300" />
                        {dragTimeHint && dragTimeHint.capsuleId === geo.capsule.id && dragTimeHint.mode === 'resize-start' && (
                          <span
                            data-capsule-drag-info
                            className="absolute -top-5 left-0 bg-emerald-500/95 text-black text-[10px] px-1 rounded font-mono whitespace-nowrap"
                          >
                            {formatSec(dragTimeHint.startSec)}
                          </span>
                        )}
                      </div>
                    )}

                    {isActive && seg.isEnd && (
                      <div
                        data-capsule-handle
                        data-capsule-id={geo.capsule.id}
                        data-side="right"
                        className="absolute right-[-6px] top-0 bottom-0 w-[18px] pointer-events-auto cursor-ew-resize flex items-center justify-center z-[100]"
                        onPointerDown={(e) => handleCapsulePointerDown(e, 'resize-end', geo.capsule)}
                      >
                        <div className="h-full w-[4px] bg-emerald-500/90 shadow-[0_0_0_1px_rgba(16,185,129,0.8)] hover:bg-emerald-300" />
                        {dragTimeHint && dragTimeHint.capsuleId === geo.capsule.id && dragTimeHint.mode === 'resize-end' && (
                          <span
                            data-capsule-drag-info
                            className="absolute -top-5 right-0 bg-emerald-500/95 text-black text-[10px] px-1 rounded font-mono whitespace-nowrap"
                          >
                            {formatSec(dragTimeHint.endSec)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          })}
        </div>

        {rubberBand && (
          <>
            <div
              className="fixed border-[3px] border-yellow-400 bg-yellow-400/20 pointer-events-none z-50 rounded"
              style={{
                left: rubberBand.x,
                top: rubberBand.y,
                width: rubberBand.w,
                height: rubberBand.h,
              }}
            />
            {rubberBandInfo && (
              <div
                data-rubberband-info
                className="fixed pointer-events-none z-[51] rounded bg-yellow-400/95 text-black text-[11px] px-2 py-1 font-mono shadow"
                style={{
                  left: rubberBand.x + rubberBand.w + 8,
                  top: rubberBand.y + rubberBand.h + 8,
                }}
              >
                已选 {rubberBandInfo.frameCount} 帧 · {formatSec(rubberBandInfo.startSec)} - {formatSec(rubberBandInfo.endSec)}
              </div>
            )}
          </>
        )}
      </div>

      {rbDiagEnabled && (
        <DiagPanel
          rbFixVersion={rbFixVersion}
          activeCapsuleId={activeCapsuleId}
          interactionState={interactionState}
          diagSnapTarget={diagSnapTarget}
          diagAutoScroll={diagAutoScroll}
          diagDragStartCount={diagDragStartCount}
          diagLastMouseMove={diagLastMouseMove}
          diagEvents={diagEvents}
        />
      )}

      <p className="text-[11px] text-muted-foreground">
        拖框创建胶囊；拖【/】调整边界；拖胶囊中间整体平移。边缘自动滚动，mouseup 后才提交几何更新。
      </p>
    </div>
  )
}
