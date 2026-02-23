import { useMemo } from 'react'
import { formatSec } from '@/lib/format'
import { CompressionBag } from './CompressionBag'
import type { DisplayItem } from './timeline-types'

const FRAME_W = 36
const FRAME_H = 64 // 9:16
const WAVEFORM_H = 12
const LABEL_W = 76

interface Props {
  rowIndex: number
  items: DisplayItem[]
  startSec: number
  endSec: number
  /** 选区范围 [start, end] 秒 — 如果与本行有重叠则渲染 overlay */
  selectionRange: [number, number] | null
  /** 播放头位置 (秒) */
  playheadSec: number | null
  /** 以图找图匹配到的时间戳集合 — 帧边框高亮 */
  clipHighlights?: Set<number>
  onFrameClick: (timestamp: number) => void
  /** bag 需要的参数 */
  onSelectionChange?: (range: [number, number]) => void
  onDeferCompression?: () => void
  onResumeCompression?: () => void
  hitTimestamp?: number | null
}

/**
 * 单行时间轴: [label] [frame track] [end label]
 * frame track 下方有 12px 波形占位条
 * 支持渲染 FrameItem 和 BagItem (压缩袋)
 */
export function TimelineRow({
  rowIndex, items, startSec, endSec,
  selectionRange, playheadSec,
  clipHighlights,
  onFrameClick,
  onSelectionChange,
  onDeferCompression,
  onResumeCompression,
  hitTimestamp,
}: Props) {
  const rowDuration = endSec - startSec

  const selOverlay = useMemo(() => {
    if (!selectionRange || rowDuration <= 0) return null
    const [selS, selE] = selectionRange
    // 判断是否与本行重叠
    if (selE <= startSec || selS >= endSec) return null
    const clampedS = Math.max(selS, startSec)
    const clampedE = Math.min(selE, endSec)
    const leftPct = ((clampedS - startSec) / rowDuration) * 100
    const widthPct = ((clampedE - clampedS) / rowDuration) * 100
    return { leftPct, widthPct }
  }, [selectionRange, startSec, endSec, rowDuration])

  const playheadPct = useMemo(() => {
    if (playheadSec === null || playheadSec < startSec || playheadSec > endSec || rowDuration <= 0) return null
    return ((playheadSec - startSec) / rowDuration) * 100
  }, [playheadSec, startSec, endSec, rowDuration])

  return (
    <div className="flex items-start gap-0">
      {/* 左标签 */}
      <div className="shrink-0 pt-1" style={{ width: LABEL_W }}>
        <p className="text-[11px] text-[#666] font-mono leading-tight">
          Row {rowIndex + 1}: {formatSec(startSec)}
        </p>
      </div>

      {/* 帧轨道 + 波形 */}
      <div className="flex-1 min-w-0 relative">
        {/* 帧条 */}
        <div className="flex" style={{ height: FRAME_H }}>
          {items.map((item) => {
            if (item.kind === 'bag') {
              return (
                <CompressionBag
                  key={`bag-${item.startSec}`}
                  bag={item}
                  onSelectionChange={onSelectionChange ?? (() => {})}
                  onDeferCompression={onDeferCompression}
                  onResumeCompression={onResumeCompression}
                  hitTimestamp={hitTimestamp}
                />
              )
            }
            // kind === 'frame'
            const { frame } = item
            const isClipMatch = clipHighlights?.has(frame.timestamp)
            return (
              <div
                key={frame.timestamp}
                data-timestamp={frame.timestamp}
                className={`shrink-0 cursor-pointer overflow-hidden transition-shadow ${
                  isClipMatch
                    ? 'ring-2 ring-cyan-400'
                    : 'hover:ring-1 hover:ring-rv-accent/50'
                }`}
                style={{ width: FRAME_W, height: FRAME_H }}
                onClick={() => onFrameClick(frame.timestamp)}
                title={formatSec(frame.timestamp)}
              >
                <img
                  src={frame.url}
                  className="w-full h-full object-cover"
                  loading="lazy"
                  draggable={false}
                />
              </div>
            )
          })}
        </div>

        {/* 波形占位条 */}
        <div className="bg-rv-waveform rounded-b" style={{ height: WAVEFORM_H }} />

        {/* 选区 overlay — bag 激活时由上层传 null 禁用 */}
        {selOverlay && (
          <div
            className="absolute top-0 pointer-events-none border-x-2 border-rv-accent"
            style={{
              left: `${selOverlay.leftPct}%`,
              width: `${selOverlay.widthPct}%`,
              height: FRAME_H + WAVEFORM_H,
              background: 'rgba(255, 132, 0, 0.15)',
            }}
          >
            {/* Start handle */}
            <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-rv-accent" />
            {/* End handle */}
            <div className="absolute right-0 top-0 bottom-0 w-1.5 bg-rv-accent" />
          </div>
        )}

        {/* 播放头 */}
        {playheadPct !== null && (
          <div
            className="absolute top-0 w-0.5 bg-white pointer-events-none z-10"
            style={{ left: `${playheadPct}%`, height: FRAME_H + WAVEFORM_H }}
          />
        )}
      </div>

      {/* 右标签 */}
      <div className="shrink-0 pt-1 text-right" style={{ width: LABEL_W }}>
        <p className="text-[11px] text-[#666] font-mono leading-tight">
          {formatSec(endSec)}
        </p>
      </div>
    </div>
  )
}
