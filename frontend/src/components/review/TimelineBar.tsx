import { useCallback, useMemo, useRef, useState } from 'react'
import { formatSec } from '@/lib/format'
import type { FrameData } from '@/hooks/use-multi-res-frames'

interface Props {
  videoDuration: number
  leadTimestamps: number[]
  currentCenter: number          // 锚点
  viewRange: [number, number]    // CoarseGrid 可视范围
  l1Frames: FrameData[]          // L1 全局帧（30s 间隔）
  l1Loading: boolean
  onSeek: (sec: number) => void
  onRangeChange: (range: [number, number]) => void
  clipHotspots?: number[]
}

const THUMB_W = 60
const THUMB_H = 107   // 9:16 竖屏

/**
 * 全局 filmstrip 时间轴
 *
 * 上层: 时间刻度条 + lead 标记 + 高亮范围（可拖拽）
 * 下层: L1 帧缩略图水平排列（60px 宽，30s/帧）
 */
export function TimelineBar({
  videoDuration,
  leadTimestamps,
  currentCenter,
  viewRange,
  l1Frames,
  l1Loading,
  onSeek,
  onRangeChange,
  clipHotspots,
}: Props) {
  const barRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const [hoverSec, setHoverSec] = useState<number>(0)
  const [dragging, setDragging] = useState(false)
  const dragStartRef = useRef<{ mouseX: number; rangeStart: number; rangeEnd: number } | null>(null)

  // 每 30 分钟一个时间刻度
  const timeMarks = useMemo(() => {
    const marks: number[] = []
    const step = 30 * 60
    for (let t = 0; t <= videoDuration; t += step) marks.push(t)
    return marks
  }, [videoDuration])

  const secToPct = (sec: number): string => {
    if (videoDuration <= 0) return '0%'
    return `${(sec / videoDuration) * 100}%`
  }

  const pxToSec = useCallback((clientX: number): number => {
    if (!barRef.current || videoDuration <= 0) return 0
    const rect = barRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * videoDuration
  }, [videoDuration])

  // --- 点击跳转 ---
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (dragging) return
    const sec = pxToSec(e.clientX)
    onSeek(sec)
  }, [pxToSec, onSeek, dragging])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!barRef.current) return
    const rect = barRef.current.getBoundingClientRect()
    setHoverX(e.clientX - rect.left)
    setHoverSec(pxToSec(e.clientX))
  }, [pxToSec])

  const handleMouseLeave = useCallback(() => { setHoverX(null) }, [])

  // --- 高亮范围拖拽 ---
  const handleHighlightMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setDragging(true)
    dragStartRef.current = {
      mouseX: e.clientX,
      rangeStart: viewRange[0],
      rangeEnd: viewRange[1],
    }

    const onMove = (ev: MouseEvent) => {
      if (!dragStartRef.current || !barRef.current) return
      const rect = barRef.current.getBoundingClientRect()
      const dx = ev.clientX - dragStartRef.current.mouseX
      const dSec = (dx / rect.width) * videoDuration
      const span = dragStartRef.current.rangeEnd - dragStartRef.current.rangeStart
      let s = dragStartRef.current.rangeStart + dSec
      let e = s + span
      if (s < 0) { s = 0; e = span }
      if (e > videoDuration) { e = videoDuration; s = e - span }
      onRangeChange([s, e])
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setTimeout(() => setDragging(false), 50)
      dragStartRef.current = null
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [viewRange, videoDuration, onRangeChange])

  // --- filmstrip 帧点击 ---
  const handleFrameClick = useCallback((ts: number) => {
    onSeek(ts)
  }, [onSeek])

  // --- filmstrip 帧滚动同步：高亮范围对应位置滚到可见 ---
  // 帧条的总宽度和 viewRange 对应的帧区域
  const totalFrames = l1Frames.length
  const frameStripWidth = totalFrames * THUMB_W

  if (videoDuration <= 0) return null

  return (
    <div className="space-y-0">
      {/* 时间刻度条 + 标记层 */}
      <div
        ref={barRef}
        className="relative h-7 rounded-t bg-muted cursor-pointer select-none overflow-hidden"
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* CLIP 热区 */}
        {clipHotspots?.map((ts, i) => (
          <div
            key={i}
            className="absolute top-0 bottom-0 bg-blue-500/20"
            style={{ left: secToPct(ts - 15), width: secToPct(30) }}
          />
        ))}

        {/* viewRange 高亮（可拖拽） */}
        <div
          className={`absolute top-0 bottom-0 border-x transition-colors
            ${dragging ? 'bg-primary/25 border-primary/50 cursor-grabbing' : 'bg-primary/15 border-primary/30 cursor-grab'}`}
          style={{ left: secToPct(viewRange[0]), width: secToPct(viewRange[1] - viewRange[0]) }}
          onMouseDown={handleHighlightMouseDown}
        />

        {/* 播放头 — 红色三角指针 + 竖线，高对比度区分 viewRange */}
        <div
          className="absolute top-0 bottom-0 pointer-events-none z-10"
          style={{ left: secToPct(currentCenter), transform: 'translateX(-50%)' }}
        >
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent border-t-red-500" />
          <div className="absolute top-[8px] bottom-0 left-1/2 -translate-x-1/2 w-[2px] bg-red-500/90" />
        </div>

        {/* lead 标记（橙色圆点） */}
        {leadTimestamps.map((ts, i) => (
          <div
            key={i}
            className="absolute top-1 w-2 h-2 -ml-1 rounded-full bg-amber-500 shadow-sm shadow-amber-500/50"
            style={{ left: secToPct(ts) }}
            title={formatSec(ts)}
          />
        ))}

        {/* CLIP 高分标记（蓝色三角） */}
        {clipHotspots?.map((ts, i) => (
          <div
            key={`clip-${i}`}
            className="absolute bottom-0 w-0 h-0 -ml-1 border-l-[4px] border-r-[4px] border-b-[6px] border-l-transparent border-r-transparent border-b-blue-500"
            style={{ left: secToPct(ts) }}
            title={`CLIP: ${formatSec(ts)}`}
          />
        ))}

        {/* 30min 刻度线 */}
        {timeMarks.map(t => (
          <div key={t} className="absolute top-0 bottom-0 w-px bg-foreground/10" style={{ left: secToPct(t) }} />
        ))}

        {/* 悬停提示 */}
        {hoverX !== null && (
          <>
            <div className="absolute top-0 bottom-0 w-px bg-foreground/40 pointer-events-none" style={{ left: hoverX }} />
            <div
              className="absolute -top-6 px-1.5 py-0.5 rounded bg-foreground text-background text-[10px] font-mono pointer-events-none whitespace-nowrap"
              style={{ left: hoverX, transform: 'translateX(-50%)' }}
            >
              {formatSec(hoverSec)}
            </div>
          </>
        )}
      </div>

      {/* 帧 filmstrip 条 */}
      <div
        ref={stripRef}
        className="relative overflow-x-auto overflow-y-hidden bg-black/80 rounded-b scrollbar-thin"
        style={{ height: THUMB_H + 4 }}
      >
        {l1Loading && l1Frames.length === 0 ? (
          // 骨架屏
          <div className="flex gap-px p-0.5" style={{ width: 'max-content' }}>
            {Array.from({ length: Math.min(40, Math.ceil(videoDuration / 30)) }, (_, i) => (
              <div key={i} className="shrink-0 bg-muted/30 animate-pulse rounded-sm" style={{ width: THUMB_W, height: THUMB_H }} />
            ))}
          </div>
        ) : (
          <div className="flex gap-px p-0.5" style={{ width: 'max-content' }}>
            {l1Frames.map(frame => {
              // 判断帧是否在 viewRange 内
              const inView = frame.timestamp >= viewRange[0] && frame.timestamp <= viewRange[1]
              return (
                <div
                  key={frame.timestamp}
                  className={`shrink-0 relative cursor-pointer transition-opacity
                    ${inView ? 'opacity-100 ring-1 ring-primary/50' : 'opacity-40 hover:opacity-70'}`}
                  style={{ width: THUMB_W, height: THUMB_H }}
                  onClick={() => handleFrameClick(frame.timestamp)}
                  title={formatSec(frame.timestamp)}
                >
                  <img
                    src={frame.url}
                    className="w-full h-full object-cover rounded-sm"
                    loading="lazy"
                    draggable={false}
                  />
                </div>
              )
            })}
          </div>
        )}

        {/* viewRange 在 filmstrip 上的高亮框 */}
        {l1Frames.length > 0 && (
          <div
            className="absolute top-0 bottom-0 border-2 border-primary/60 pointer-events-none rounded-sm"
            style={{
              left: `${(viewRange[0] / videoDuration) * frameStripWidth + 2}px`,
              width: `${((viewRange[1] - viewRange[0]) / videoDuration) * frameStripWidth}px`,
            }}
          />
        )}
      </div>

      {/* 时间刻度标签 */}
      <div className="relative h-4 mt-0.5">
        {timeMarks.map(t => (
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
