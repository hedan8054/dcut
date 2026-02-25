import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatDuration, formatSec } from '@/lib/format'
import type { TimeRange } from '@/lib/timeline-range'
import type { ZoomLevel } from './MultiRowTimeline'
import { useGlobalFocusWindows } from '@/hooks/use-global-focus-windows'

interface Props {
  videoPath: string
  videoId?: number
  videoDuration: number
  leadTimestamps: number[]
  currentCenter: number
  playbackSec: number
  zoomLevel: ZoomLevel
  coarseRange: TimeRange
  focusRange: TimeRange
  onSeek: (sec: number) => void
  onCoarseRangeChange: (range: TimeRange) => void
  onFocusRangeChange: (range: TimeRange) => void
  clipHotspots?: number[]
}

const STRIP_H = 64
const FRAME_UI_W = 36
const MIN_SLOTS = 12
const MAX_SLOTS = 140

function adaptiveStep(duration: number): number {
  const targetMarks = 12
  const raw = duration / targetMarks
  const niceSteps = [30, 60, 120, 300, 600, 900, 1800, 3600]
  return niceSteps.find(s => s >= raw) ?? 3600
}

export function GlobalTimeline({
  videoPath,
  videoId,
  videoDuration,
  leadTimestamps,
  currentCenter,
  playbackSec,
  zoomLevel,
  coarseRange,
  focusRange,
  onSeek,
  onCoarseRangeChange,
  onFocusRangeChange,
  clipHotspots,
}: Props) {
  const barRef = useRef<HTMLDivElement>(null)
  const [hoverSec, setHoverSec] = useState<number | null>(null)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const [dragging, setDragging] = useState<'coarse' | 'focus' | null>(null)
  const [slotCount, setSlotCount] = useState(40)
  const dragStartRef = useRef<{
    kind: 'coarse' | 'focus'
    mouseX: number
    start: number
    end: number
  } | null>(null)

  const overview = useGlobalFocusWindows(videoPath, videoId, videoDuration, slotCount, zoomLevel)

  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width <= 0) return
      // 按「可用宽度 / 单帧宽」取上整，保证时间轴尽量铺满、无明显间隙
      const next = Math.ceil(width / FRAME_UI_W)
      setSlotCount(Math.max(MIN_SLOTS, Math.min(MAX_SLOTS, next)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const secToPct = useCallback((sec: number): string => {
    if (videoDuration <= 0) return '0%'
    const clamped = Math.max(0, Math.min(videoDuration, sec))
    return `${(clamped / videoDuration) * 100}%`
  }, [videoDuration])

  const pxToSec = useCallback((clientX: number): number => {
    if (!barRef.current || videoDuration <= 0) return 0
    const rect = barRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * videoDuration
  }, [videoDuration])

  const startRangeDrag = useCallback((e: React.MouseEvent, kind: 'coarse' | 'focus') => {
    e.stopPropagation()
    e.preventDefault()
    const range = kind === 'coarse' ? coarseRange : focusRange
    setDragging(kind)
    dragStartRef.current = { kind, mouseX: e.clientX, start: range[0], end: range[1] }

    const onMove = (ev: MouseEvent) => {
      if (!barRef.current || !dragStartRef.current) return
      const rect = barRef.current.getBoundingClientRect()
      const dx = ev.clientX - dragStartRef.current.mouseX
      const dSec = (dx / rect.width) * videoDuration
      const span = dragStartRef.current.end - dragStartRef.current.start
      let start = dragStartRef.current.start + dSec
      let end = start + span
      if (start < 0) {
        start = 0
        end = span
      }
      if (end > videoDuration) {
        end = videoDuration
        start = end - span
      }
      const next: TimeRange = [start, end]
      if (dragStartRef.current.kind === 'coarse') onCoarseRangeChange(next)
      else onFocusRangeChange(next)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setTimeout(() => setDragging(null), 50)
      dragStartRef.current = null
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [coarseRange, focusRange, onCoarseRangeChange, onFocusRangeChange, videoDuration])

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (dragging) return
    onSeek(pxToSec(e.clientX))
  }, [dragging, onSeek, pxToSec])

  const step = useMemo(() => adaptiveStep(videoDuration), [videoDuration])
  const timeMarks = useMemo(() => {
    const marks: number[] = []
    for (let t = 0; t <= videoDuration; t += step) marks.push(t)
    return marks
  }, [videoDuration, step])
  const majorMarks = useMemo(() => {
    const marks: number[] = []
    for (let t = 0; t <= videoDuration; t += 30 * 60) marks.push(t)
    return marks
  }, [videoDuration])

  if (videoDuration <= 0) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">全局时间轴</h3>
        <span className="text-[11px] text-muted-foreground">双层框：外框粗览范围，内框1秒精查范围</span>
        <div className="flex-1" />
        <span className="text-[11px] text-muted-foreground font-mono">
          {formatSec(0)} - {formatSec(videoDuration)} · 每帧约 {formatDuration(overview.intervalSec)} · {overview.progress[0]}/{overview.progress[1]}
        </span>
      </div>

      <div
        ref={barRef}
        className="relative rounded bg-black/80 cursor-pointer select-none overflow-hidden"
        style={{ height: STRIP_H }}
        onClick={handleClick}
        onMouseMove={(e) => {
          if (!barRef.current) return
          const rect = barRef.current.getBoundingClientRect()
          setHoverX(e.clientX - rect.left)
          setHoverSec(pxToSec(e.clientX))
        }}
        onMouseLeave={() => {
          setHoverX(null)
          setHoverSec(null)
        }}
      >
        <div
          className="absolute inset-0 grid"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, overview.frames.length)}, minmax(0, 1fr))` }}
        >
          {overview.frames.map((frame, idx) => {
            const nearHotspot = clipHotspots?.some(h => Math.abs(h - frame.timestamp) <= overview.intervalSec / 2) ?? false
            return (
                <button
                  key={`${frame.timestamp}-${idx}`}
                  type="button"
                  className={`h-full overflow-hidden ${nearHotspot ? 'ring-1 ring-blue-400/80' : ''}`}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    onSeek(frame.timestamp)
                  }}
                  title={formatSec(frame.timestamp)}
                >
                  {frame.url ? (
                    <img
                      src={frame.url}
                      className="w-full h-full object-cover"
                      draggable={false}
                      loading="lazy"
                    />
                ) : (
                  <div className={`w-full h-full ${overview.loading ? 'bg-muted/30 animate-pulse' : 'bg-black/85'}`} />
                )}
              </button>
            )
          })}
        </div>

        {timeMarks.map(t => (
          <div key={t} className="absolute top-0 bottom-0 w-px bg-white/10" style={{ left: secToPct(t) }} />
        ))}

        {leadTimestamps.map((ts, i) => (
          <div
            key={`${ts}-${i}`}
            className="absolute top-1.5 w-2 h-2 -ml-1 rounded-full bg-rv-accent shadow-sm z-20"
            style={{ left: secToPct(ts) }}
            title={formatSec(ts)}
          />
        ))}

        <div
          className="absolute top-0 bottom-0 border-x-2 border-rv-accent/90 bg-rv-accent/15 cursor-grab z-20"
          style={{ left: secToPct(coarseRange[0]), width: secToPct(coarseRange[1] - coarseRange[0]) }}
          onMouseDown={(e) => startRangeDrag(e, 'coarse')}
          title="粗览范围"
        />

        <div
          className={`absolute top-1 bottom-1 border-x-2 z-30 ${zoomLevel === '1s' ? 'border-white bg-white/15' : 'border-white/80 bg-white/10'} cursor-grab`}
          style={{ left: secToPct(focusRange[0]), width: secToPct(focusRange[1] - focusRange[0]) }}
          onMouseDown={(e) => startRangeDrag(e, 'focus')}
          title="1秒精查范围"
        />

        {/* 橙针（播放位置） */}
        {playbackSec > 0 && (
          <div
            className="absolute top-0 bottom-0 pointer-events-none z-38"
            style={{ left: secToPct(playbackSec), transform: 'translateX(-50%)' }}
          >
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[5px] border-r-[5px] border-t-[7px] border-l-transparent border-r-transparent border-t-orange-400" />
            <div className="absolute top-[7px] bottom-0 left-1/2 -translate-x-1/2 w-[2px] bg-orange-400/90" />
          </div>
        )}

        {/* 白针（锚点/定位针） */}
        <div
          className="absolute top-0 bottom-0 pointer-events-none z-40"
          style={{ left: secToPct(currentCenter), transform: 'translateX(-50%)' }}
        >
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[5px] border-r-[5px] border-t-[7px] border-l-transparent border-r-transparent border-t-white" />
          <div className="absolute top-[7px] bottom-0 left-1/2 -translate-x-1/2 w-[2px] bg-white/90" />
        </div>

        {hoverX !== null && hoverSec !== null && (
          <>
            <div className="absolute top-0 bottom-0 w-px bg-white/40 pointer-events-none z-50" style={{ left: hoverX }} />
            <div
              className="absolute -top-6 px-1.5 py-0.5 rounded bg-foreground text-background text-[10px] font-mono pointer-events-none whitespace-nowrap z-50"
              style={{ left: hoverX, transform: 'translateX(-50%)' }}
            >
              {formatSec(hoverSec)}
            </div>
          </>
        )}
      </div>

      <div className="relative h-3">
        {majorMarks.map(t => (
          <span
            key={t}
            className="absolute text-[10px] text-muted-foreground font-mono -translate-x-1/2"
            style={{ left: secToPct(t) }}
          >
            {formatSec(t)}
          </span>
        ))}
      </div>
    </div>
  )
}
