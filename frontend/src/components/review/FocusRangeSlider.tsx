import { useCallback, useMemo, useRef } from 'react'
import { formatSec } from '@/lib/format'
import type { TimeRange } from '@/lib/timeline-range'

type DragMode = 'left' | 'right' | 'move'

interface Props {
  coarseRange: TimeRange
  focusRange: TimeRange
  minSpanSec?: number
  onChange: (range: TimeRange) => void
}

export function FocusRangeSlider({
  coarseRange,
  focusRange,
  minSpanSec = 20,
  onChange,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ mode: DragMode; startX: number; focus: TimeRange } | null>(null)

  const coarseSpan = Math.max(1, coarseRange[1] - coarseRange[0])
  const focusSpan = Math.max(0, focusRange[1] - focusRange[0])

  const leftPct = useMemo(
    () => ((focusRange[0] - coarseRange[0]) / coarseSpan) * 100,
    [focusRange, coarseRange, coarseSpan],
  )
  const widthPct = useMemo(
    () => (focusSpan / coarseSpan) * 100,
    [focusSpan, coarseSpan],
  )

  const apply = useCallback((next: TimeRange) => {
    onChange([Math.round(next[0] * 10) / 10, Math.round(next[1] * 10) / 10])
  }, [onChange])

  const startDrag = useCallback((e: React.MouseEvent, mode: DragMode) => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { mode, startX: e.clientX, focus: focusRange }

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !trackRef.current) return
      const rect = trackRef.current.getBoundingClientRect()
      const dx = ev.clientX - dragRef.current.startX
      const dSec = (dx / rect.width) * coarseSpan
      const [rawStart, rawEnd] = dragRef.current.focus
      const span = rawEnd - rawStart
      const minSpan = Math.max(1, minSpanSec)

      if (dragRef.current.mode === 'move') {
        const maxStart = coarseRange[1] - span
        const start = Math.min(maxStart, Math.max(coarseRange[0], rawStart + dSec))
        apply([start, start + span])
        return
      }

      if (dragRef.current.mode === 'left') {
        const start = Math.max(coarseRange[0], Math.min(rawStart + dSec, rawEnd - minSpan))
        apply([start, rawEnd])
        return
      }

      const end = Math.min(coarseRange[1], Math.max(rawEnd + dSec, rawStart + minSpan))
      apply([rawStart, end])
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      dragRef.current = null
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [focusRange, coarseSpan, coarseRange, minSpanSec, apply])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono">
        <span>缩放范围</span>
        <span>{formatSec(focusRange[0])} → {formatSec(focusRange[1])}</span>
      </div>
      <div
        ref={trackRef}
        className="relative h-8 rounded bg-muted/30 border border-rv-border overflow-hidden select-none"
      >
        <div
          className="absolute inset-y-0 bg-rv-accent/15 border-x-2 border-rv-accent cursor-move"
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          onMouseDown={(e) => startDrag(e, 'move')}
        >
          <div
            className="absolute left-0 top-0 bottom-0 w-2.5 bg-rv-accent/70 cursor-ew-resize"
            onMouseDown={(e) => startDrag(e, 'left')}
          />
          <div
            className="absolute right-0 top-0 bottom-0 w-2.5 bg-rv-accent/70 cursor-ew-resize"
            onMouseDown={(e) => startDrag(e, 'right')}
          />
        </div>
      </div>
    </div>
  )
}
