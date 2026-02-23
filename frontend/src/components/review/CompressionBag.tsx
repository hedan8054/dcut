import { useCallback, useRef } from 'react'
import { formatSec } from '@/lib/format'
import type { BagItem } from './timeline-types'

const FRAME_W = 36
const FRAME_H = 64
const MIN_SELECTION_SEC = 2

interface Props {
  bag: BagItem
  onSelectionChange: (range: [number, number]) => void
  /** mousedown 时调用，通知上层展开帧 → elementFromPoint 可用 */
  onDeferCompression?: () => void
  /** mouseup 时调用，通知上层立即压缩 */
  onResumeCompression?: () => void
  hitTimestamp?: number | null
}

/** 从鼠标坐标向上查找带 data-timestamp 的帧元素 */
function findTimestampFromPoint(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y)
  if (!el) return null
  let node: Element | null = el
  for (let i = 0; i < 4 && node; i++) {
    if (node instanceof HTMLElement && node.dataset.timestamp != null) {
      return parseFloat(node.dataset.timestamp)
    }
    node = node.parentElement
  }
  return null
}

/**
 * 压缩袋组件
 * mousedown → onDeferCompression → 上层延迟压缩 → 帧展开 → elementFromPoint 跟踪
 * mouseup → 无特殊处理 → 上层 debounce 400ms 后自动重新压缩
 */
export function CompressionBag({
  bag, onSelectionChange, onDeferCompression, onResumeCompression, hitTimestamp,
}: Props) {
  const dragRef = useRef<{
    side: 'left' | 'right'
    startSec: number
    endSec: number
    lastTs: number
  } | null>(null)

  const startDrag = useCallback((e: React.MouseEvent, side: 'left' | 'right') => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = {
      side,
      startSec: bag.startSec,
      endSec: bag.endSec,
      lastTs: side === 'left' ? bag.startSec : bag.endSec,
    }

    // 通知上层延迟压缩 → React 重渲染 → 帧元素出现在 DOM
    onDeferCompression?.()

    // 等一帧让帧元素渲染完，再绑定 mousemove
    requestAnimationFrame(() => {
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return
        const ts = findTimestampFromPoint(ev.clientX, ev.clientY)
        if (ts == null || ts === dragRef.current.lastTs) return

        if (dragRef.current.side === 'left') {
          if (dragRef.current.endSec - ts < MIN_SELECTION_SEC) return
          dragRef.current.lastTs = ts
          onSelectionChange([ts, dragRef.current.endSec])
        } else {
          if (ts - dragRef.current.startSec < MIN_SELECTION_SEC) return
          dragRef.current.lastTs = ts
          onSelectionChange([dragRef.current.startSec, ts])
        }
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        dragRef.current = null
        onResumeCompression?.()
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
  }, [bag.startSec, bag.endSec, onSelectionChange, onDeferCompression, onResumeCompression])

  const bagW = bag.slots * FRAME_W

  // 命中点白线
  const hitPct = (() => {
    if (hitTimestamp == null) return null
    if (hitTimestamp < bag.startSec || hitTimestamp > bag.endSec) return null
    const span = bag.endSec - bag.startSec
    if (span <= 0) return null
    return ((hitTimestamp - bag.startSec) / span) * 100
  })()

  return (
    <div
      className="shrink-0 relative select-none"
      style={{ width: bagW, height: FRAME_H }}
    >
      {/* 绿色底板 */}
      <div className="absolute inset-0 bg-green-950/30 rounded-sm" />

      {/* 降采样帧 */}
      <div className="flex" style={{ height: FRAME_H }}>
        {bag.sampledFrames.map(frame => (
          <div
            key={frame.timestamp}
            className="shrink-0 overflow-hidden"
            style={{ width: FRAME_W, height: FRAME_H }}
            title={formatSec(frame.timestamp)}
          >
            <img
              src={frame.url}
              className="w-full h-full object-cover opacity-75"
              loading="lazy"
              draggable={false}
            />
          </div>
        ))}
      </div>

      {/* 绿色边线 + badge */}
      <div className="absolute top-0 inset-x-0 h-px bg-green-500" />
      <div className="absolute bottom-0 inset-x-0 h-px bg-green-500" />
      <div className="absolute top-0.5 left-3 flex items-center gap-1 pointer-events-none">
        <span className="bg-green-600/90 text-[9px] text-white font-bold px-1 rounded">
          {bag.frameCount}帧
        </span>
        <span className="bg-black/60 text-[8px] text-green-300 px-1 rounded font-mono">
          {formatSec(bag.startSec)}–{formatSec(bag.endSec)}
        </span>
      </div>

      {/* 命中点白线 */}
      {hitPct != null && (
        <div
          className="absolute inset-y-0 w-px bg-white/80 z-20 pointer-events-none"
          style={{ left: `${hitPct}%` }}
        />
      )}

      {/* 左拖拽手柄 */}
      <div
        className="absolute left-0 top-0 bottom-0 w-2.5 bg-green-500/70 cursor-ew-resize z-30 hover:bg-green-400/90 transition-colors"
        onMouseDown={(e) => startDrag(e, 'left')}
      />

      {/* 右拖拽手柄 */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2.5 bg-green-500/70 cursor-ew-resize z-30 hover:bg-green-400/90 transition-colors"
        onMouseDown={(e) => startDrag(e, 'right')}
      />
    </div>
  )
}
