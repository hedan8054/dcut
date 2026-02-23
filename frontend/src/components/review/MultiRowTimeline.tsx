import { useEffect, useMemo, useRef, useState } from 'react'
import { Monitor, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { TimelineRow } from './TimelineRow'
import { FocusRangeSlider } from './FocusRangeSlider'
import { formatSec } from '@/lib/format'
import type { FrameData } from '@/hooks/use-multi-res-frames'
import type { TimeRange } from '@/lib/timeline-range'

export type ZoomLevel = '1s' | '10s' | '60s' | '90s'
const ZOOM_ORDER: ZoomLevel[] = ['90s', '60s', '10s', '1s']
const ZOOM_INTERVAL_SEC: Record<ZoomLevel, number> = {
  '1s': 1,
  '10s': 10,
  '60s': 60,
  '90s': 90,
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
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [framesPerRow, setFramesPerRow] = useState(20)
  const [maxRows, setMaxRows] = useState(6)
  const activeRange: TimeRange = zoomLevel === '1s' ? focusRange : displayRange

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
      setMaxRows(rows)

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

  const frames = zoomLevel === '1s' ? (l3Frames.length > 0 ? l3Frames : l2Frames) : l2FramesByZoom
  const loading = zoomLevel === '1s' ? (l3Loading || l2Loading) : l2Loading
  const prog = zoomLevel === '1s' ? (l3Loading ? l3Progress : l2Progress) : l2Progress

  const clipSet = useMemo(() => {
    if (!clipTimestamps?.length) return new Set<number>()
    const interval = ZOOM_INTERVAL_SEC[zoomLevel]
    return new Set(clipTimestamps.map(t => Math.round(t / interval) * interval))
  }, [clipTimestamps, zoomLevel])

  const rows = useMemo(() => {
    const result: FrameData[][] = []
    for (let i = 0; i < frames.length; i += framesPerRow) {
      result.push(frames.slice(i, i + framesPerRow))
    }
    return result
  }, [frames, framesPerRow])
  const visibleRows = useMemo(
    () => (zoomLevel === '1s' ? rows : rows.slice(0, maxRows)),
    [maxRows, rows, zoomLevel],
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
            className={`px-2 py-0.5 transition-colors ${zoomLevel === '90s' ? 'bg-rv-accent text-black font-medium' : 'text-muted-foreground'}`}
            onClick={() => handleZoomToggle('90s')}
          >
            90秒
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
          {visibleRows.map((rowFrames, i) => {
            const rowStart = rowFrames[0]?.timestamp ?? 0
            const interval = ZOOM_INTERVAL_SEC[zoomLevel]
            const rowEnd = (rowFrames[rowFrames.length - 1]?.timestamp ?? 0) + interval
            return (
              <TimelineRow
                key={`${rowStart}-${i}`}
                rowIndex={i}
                frames={rowFrames}
                startSec={rowStart}
                endSec={rowEnd}
                selectionRange={selectionRange}
                playheadSec={playheadSec}
                clipHighlights={clipSet.size > 0 ? clipSet : undefined}
                onFrameClick={onFrameSelect}
              />
            )
          })}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        先在粗档位(10s/60s/90s)定位范围，再切 1 秒精查；入点/出点仍在下方标注栏独立调整
      </p>
    </div>
  )
}
