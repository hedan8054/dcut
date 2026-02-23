import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Monitor, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { TimelineRow } from './TimelineRow'
import { FocusRangeSlider } from './FocusRangeSlider'
import { formatSec } from '@/lib/format'
import type { FrameData } from '@/hooks/use-multi-res-frames'
import type { TimeRange } from '@/lib/timeline-range'
import { BAG_THRESHOLD } from './timeline-types'
import type { DisplayItem, FrameItem, BagItem } from './timeline-types'

export type ZoomLevel = '1s' | '10s' | '60s' | '2min'
const ZOOM_ORDER: ZoomLevel[] = ['2min', '60s', '10s', '1s']
const ZOOM_INTERVAL_SEC: Record<ZoomLevel, number> = {
  '1s': 1,
  '10s': 10,
  '60s': 60,
  '2min': 120,
}

const FRAME_W = 36
const FRAME_H = 64
const WAVEFORM_H = 12
const LABEL_W = 76
const ROW_GAP = 8
const BOTTOM_RESERVED = 170

interface Props {
  anchorSec: number
  videoDuration: number
  zoomLevel: ZoomLevel
  onZoomChange: (zoom: ZoomLevel) => void
  displayRange: TimeRange
  coarseRange: TimeRange
  focusRange: TimeRange
  onFocusRangeChange: (range: TimeRange) => void
  onFrameSelect: (timestamp: number) => void
  l2Frames: FrameData[]
  l3Frames: FrameData[]
  l2Loading: boolean
  l3Loading: boolean
  l2Progress: [number, number]
  l3Progress: [number, number]
  onRequestL3: (centerSec: number) => void
  onViewportCapacityChange?: (capacity: number) => void
  clipTimestamps?: number[]
  selectionRange?: [number, number] | null
  playheadSec?: number | null
  onSelectionRangeChange?: (range: [number, number]) => void
  hitTimestamp?: number | null
}

/**
 * 将帧列表 + 选区转为 DisplayItem[]
 * 选区内帧数 > BAG_THRESHOLD → 用 l2Frames 降采样替换为动态宽度 BagItem
 * sampledFrames: 高一档间隔的帧（如 10s 间隔的 l2Frames）
 */
function buildDisplayItems(
  frames: FrameData[],
  selectionRange: [number, number] | null,
  sampledFrames: FrameData[],
): DisplayItem[] {
  if (!selectionRange || frames.length === 0) {
    return frames.map(f => ({ kind: 'frame', frame: f } as FrameItem))
  }

  const [selS, selE] = selectionRange
  const before: FrameItem[] = []
  const inside: FrameData[] = []
  const after: FrameItem[] = []

  for (const f of frames) {
    if (f.timestamp < selS) {
      before.push({ kind: 'frame', frame: f })
    } else if (f.timestamp >= selS && f.timestamp <= selE) {
      inside.push(f)
    } else {
      after.push({ kind: 'frame', frame: f })
    }
  }

  // 不满足阈值 → 不压缩，用原 overlay
  if (inside.length <= BAG_THRESHOLD) {
    return frames.map(f => ({ kind: 'frame', frame: f } as FrameItem))
  }

  // 从高一档帧中筛选落在选区内的采样帧
  const sampled = sampledFrames.filter(f => f.timestamp >= selS && f.timestamp <= selE)

  // 没有可用采样帧 → 不压缩（避免空袋）
  if (sampled.length < 1) {
    return frames.map(f => ({ kind: 'frame', frame: f } as FrameItem))
  }

  const bag: BagItem = {
    kind: 'bag',
    sampledFrames: sampled,
    frameCount: inside.length,
    startSec: selS,
    endSec: selE,
    slots: sampled.length,
  }

  return [...before, bag, ...after]
}

/**
 * 将 DisplayItem[] 按 framesPerRow 上限分行
 * bag 计 BAG_SLOTS slots，frame 计 1 slot
 */
function splitIntoRows(items: DisplayItem[], framesPerRow: number): DisplayItem[][] {
  const rows: DisplayItem[][] = []
  let currentRow: DisplayItem[] = []
  let slotsUsed = 0

  for (const item of items) {
    const itemSlots = item.kind === 'bag' ? item.slots : 1
    // 如果加入后超出行宽，先换行（但空行必须接受）
    if (slotsUsed > 0 && slotsUsed + itemSlots > framesPerRow) {
      rows.push(currentRow)
      currentRow = []
      slotsUsed = 0
    }
    currentRow.push(item)
    slotsUsed += itemSlots
  }

  if (currentRow.length > 0) {
    rows.push(currentRow)
  }

  return rows
}

export function MultiRowTimeline({
  anchorSec, zoomLevel,
  onZoomChange,
  displayRange,
  coarseRange, focusRange,
  onFocusRangeChange,
  onFrameSelect,
  l2Frames, l3Frames, l2Loading, l3Loading,
  l2Progress, l3Progress, onRequestL3,
  onViewportCapacityChange,
  clipTimestamps,
  selectionRange = null,
  playheadSec = null,
  onSelectionRangeChange,
  hitTimestamp = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [framesPerRow, setFramesPerRow] = useState(20)
  const activeRange: TimeRange = zoomLevel === '1s' ? focusRange : displayRange

  // ── 鼠标按下展开 / 松开压缩 ──
  // mousedown bag 手柄 → true → 帧展开 + overlay + elementFromPoint
  // mouseup → false → 立即压缩为 bag
  const [compressionDeferred, setCompressionDeferred] = useState(false)

  const handleDeferCompression = useCallback(() => setCompressionDeferred(true), [])
  const handleResumeCompression = useCallback(() => setCompressionDeferred(false), [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const updateLayout = () => {
      const rect = el.getBoundingClientRect()
      const trackW = Math.max(120, rect.width - LABEL_W * 2)
      const cols = Math.max(3, Math.floor(trackW / FRAME_W))
      setFramesPerRow(cols)

      const rowH = FRAME_H + WAVEFORM_H + ROW_GAP
      const availableH = Math.max(100, window.innerHeight - rect.top - BOTTOM_RESERVED)
      const rows = Math.max(1, Math.floor((availableH + ROW_GAP) / rowH))
      onViewportCapacityChange?.(cols * rows)
    }

    const ro = new ResizeObserver(() => updateLayout())
    ro.observe(el)
    window.addEventListener('resize', updateLayout)
    updateLayout()

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', updateLayout)
    }
  }, [onViewportCapacityChange])

  const l2FramesByZoom = useMemo(() => {
    const interval = ZOOM_INTERVAL_SEC[zoomLevel]
    if (zoomLevel === '10s') return l2Frames
    return l2Frames.filter(frame => {
      const mod = frame.timestamp % interval
      return mod < 0.05 || interval - mod < 0.05
    })
  }, [l2Frames, zoomLevel])

  // 1s zoom: l3 精细区（1s 间隔）+ l2 扩展区（10s 间隔），让选区之后的帧可见
  const frames = useMemo(() => {
    if (zoomLevel !== '1s') return l2FramesByZoom
    if (l3Frames.length === 0) return l2Frames

    const l3Start = l3Frames[0].timestamp
    const l3End = l3Frames[l3Frames.length - 1].timestamp

    // l3 覆盖区域外补 l2 帧
    const l2Before = l2Frames.filter(f => f.timestamp < l3Start)
    const l2After = l2Frames.filter(f => f.timestamp > l3End)

    return [...l2Before, ...l3Frames, ...l2After]
  }, [zoomLevel, l3Frames, l2Frames, l2FramesByZoom])
  const loading = zoomLevel === '1s' ? (l3Loading || l2Loading) : l2Loading
  const prog = zoomLevel === '1s' ? (l3Loading ? l3Progress : l2Progress) : l2Progress
  const interval = ZOOM_INTERVAL_SEC[zoomLevel]

  const clipSet = useMemo(() => {
    if (!clipTimestamps?.length) return new Set<number>()
    return new Set(clipTimestamps.map(t => Math.round(t / interval) * interval))
  }, [clipTimestamps, interval])

  // 构建 DisplayItem[]
  // compressionDeferred=true → 全部帧（不压缩，overlay 可见）
  // compressionDeferred=false → buildDisplayItems（可能生成 bag）
  const displayItems = useMemo(
    () => compressionDeferred
      ? frames.map(f => ({ kind: 'frame', frame: f } as FrameItem))
      : buildDisplayItems(
          frames,
          zoomLevel === '1s' ? selectionRange : null,
          l2Frames,
        ),
    [frames, selectionRange, l2Frames, zoomLevel, compressionDeferred],
  )

  // bag 是否激活（决定 overlay 是否禁用）
  const bagActive = useMemo(
    () => displayItems.some(item => item.kind === 'bag'),
    [displayItems],
  )

  // 按 framesPerRow 分行
  const visibleRows = useMemo(
    () => splitIntoRows(displayItems, framesPerRow),
    [displayItems, framesPerRow],
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let lastZoomTime = 0
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const now = Date.now()
      if (now - lastZoomTime < 200) return
      lastZoomTime = now

      const idx = ZOOM_ORDER.indexOf(zoomLevel)
      if (idx < 0) return

      if (e.deltaY < 0 && idx < ZOOM_ORDER.length - 1) {
        const next = ZOOM_ORDER[idx + 1]
        if (next === '1s') onRequestL3((focusRange[0] + focusRange[1]) / 2)
        onZoomChange(next)
      } else if (e.deltaY > 0 && idx > 0) {
        onZoomChange(ZOOM_ORDER[idx - 1])
      }
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [zoomLevel, focusRange, onRequestL3, onZoomChange])

  const handleZoomToggle = (z: ZoomLevel) => {
    if (z === zoomLevel) return
    if (z === '1s') onRequestL3((focusRange[0] + focusRange[1]) / 2)
    onZoomChange(z)
  }

  return (
    <div className="space-y-2" ref={containerRef}>
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-sm font-semibold">局部时间轴</h3>

        <div className="flex rounded-md border border-rv-border overflow-hidden text-[11px]">
          <button
            className={`px-2 py-0.5 transition-colors ${zoomLevel === '1s' ? 'bg-rv-accent text-black font-medium' : 'text-muted-foreground'}`}
            onClick={() => handleZoomToggle('1s')}
          >
            1秒
          </button>
          <button
            className={`px-2 py-0.5 transition-colors ${zoomLevel === '10s' ? 'bg-rv-accent text-black font-medium' : 'text-muted-foreground'}`}
            onClick={() => handleZoomToggle('10s')}
          >
            10秒
          </button>
          <button
            className={`px-2 py-0.5 transition-colors ${zoomLevel === '60s' ? 'bg-rv-accent text-black font-medium' : 'text-muted-foreground'}`}
            onClick={() => handleZoomToggle('60s')}
          >
            60秒
          </button>
          <button
            className={`px-2 py-0.5 transition-colors ${zoomLevel === '2min' ? 'bg-rv-accent text-black font-medium' : 'text-muted-foreground'}`}
            onClick={() => handleZoomToggle('2min')}
          >
            2分
          </button>
        </div>

        <Badge variant="outline" className="text-[11px] gap-1">
          <Monitor className="w-3 h-3" />
          自动换行 · {visibleRows.length}行
        </Badge>

        <div className="flex-1" />
        <span className="text-[11px] text-muted-foreground font-mono">
          {formatSec(activeRange[0])} → {formatSec(activeRange[1])}
        </span>
        <span className="text-[11px] font-mono">
          锚点 <span className="text-rv-accent">{formatSec(anchorSec)}</span>
        </span>
      </div>

      {/* 1s 模式下用内联压缩袋替代 FocusRangeSlider selection mode */}
      {zoomLevel !== '1s' && (
        <FocusRangeSlider
          coarseRange={coarseRange}
          focusRange={focusRange}
          minSpanSec={20}
          onChange={onFocusRangeChange}
        />
      )}

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>加载中 {prog[0]}/{prog[1]}</span>
          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-rv-accent rounded-full transition-all"
              style={{ width: prog[1] > 0 ? `${(prog[0] / prog[1]) * 100}%` : '0%' }}
            />
          </div>
        </div>
      )}

      {visibleRows.length === 0 && loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map(i => (
            <div key={i} className="flex gap-0">
              <div style={{ width: LABEL_W }} />
              <div className="flex-1 flex">
                {Array.from({ length: Math.min(framesPerRow, 20) }, (_, j) => (
                  <div key={j} className="shrink-0 bg-muted/30 animate-pulse" style={{ width: FRAME_W, height: 64 }} />
                ))}
              </div>
              <div style={{ width: LABEL_W }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {visibleRows.map((rowItems, i) => {
            // 从 items 中提取首帧和尾帧时间戳用于标签
            const firstTs = getFirstTimestamp(rowItems)
            const lastTs = getLastTimestamp(rowItems)
            const rowStart = firstTs ?? 0
            const rowEnd = (lastTs ?? 0) + interval
            return (
              <TimelineRow
                key={`${rowStart}-${i}`}
                rowIndex={i}
                items={rowItems}
                startSec={rowStart}
                endSec={rowEnd}
                selectionRange={bagActive ? null : selectionRange}
                playheadSec={playheadSec}
                clipHighlights={clipSet.size > 0 ? clipSet : undefined}
                onFrameClick={onFrameSelect}
                onSelectionChange={onSelectionRangeChange}
                onDeferCompression={handleDeferCompression}
                onResumeCompression={handleResumeCompression}
                hitTimestamp={hitTimestamp}
              />
            )
          })}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        先在粗档位(10s/60s/2min)定位范围，再切 1 秒精查；选区 &gt; 3 帧后自动压缩为绿色袋，拖绿手柄调整入点/出点
      </p>
    </div>
  )
}

/** 从一行 DisplayItem 中提取最早的时间戳 */
function getFirstTimestamp(items: DisplayItem[]): number | null {
  for (const item of items) {
    if (item.kind === 'frame') return item.frame.timestamp
    if (item.kind === 'bag') return item.startSec
  }
  return null
}

/** 从一行 DisplayItem 中提取最晚的时间戳 */
function getLastTimestamp(items: DisplayItem[]): number | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'frame') return item.frame.timestamp
    if (item.kind === 'bag') return item.endSec
  }
  return null
}
