import { useRef, useEffect, useMemo } from 'react'
import { formatSec } from '@/lib/format'
import type { FrameData } from '@/hooks/use-frames'

interface Props {
  frames: FrameData[]
  startSec: number
  endSec: number
  currentTime: number
  onStartChange: (sec: number) => void
  onEndChange: (sec: number) => void
  onSeek: (sec: number) => void
}

/**
 * 帧条带 - 水平滚动的帧序列，带 start/end 滑块
 */
export function FrameStrip({
  frames, startSec, endSec, currentTime,
  onStartChange, onEndChange, onSeek,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  // 帧排序
  const sortedFrames = useMemo(
    () => [...frames].sort((a, b) => a.timestamp - b.timestamp),
    [frames],
  )

  const minTime = sortedFrames[0]?.timestamp ?? 0
  const maxTime = sortedFrames[sortedFrames.length - 1]?.timestamp ?? 0
  const range = maxTime - minTime || 1

  // 自动滚动到当前时间
  useEffect(() => {
    if (!containerRef.current || sortedFrames.length === 0) return
    const ratio = (currentTime - minTime) / range
    const scrollLeft = ratio * containerRef.current.scrollWidth - containerRef.current.clientWidth / 2
    containerRef.current.scrollTo({ left: Math.max(0, scrollLeft), behavior: 'smooth' })
  }, [currentTime, minTime, range, sortedFrames.length])

  const toPercent = (sec: number) => ((sec - minTime) / range) * 100

  return (
    <div className="relative">
      {/* 时间标签 */}
      <div className="flex justify-between text-xs text-muted-foreground mb-1 font-mono">
        <span>{formatSec(startSec)}</span>
        <span className="text-foreground font-medium">
          {formatSec(endSec - startSec > 0 ? endSec - startSec : 0)} 时长
        </span>
        <span>{formatSec(endSec)}</span>
      </div>

      {/* 帧条带容器 */}
      <div
        ref={containerRef}
        className="relative overflow-x-auto border rounded-md"
        style={{ height: 100 }}
      >
        <div className="flex h-full" style={{ width: `${sortedFrames.length * 56}px` }}>
          {sortedFrames.map((frame) => {
            const isInRange = frame.timestamp >= startSec && frame.timestamp <= endSec
            return (
              <div
                key={frame.timestamp}
                className={`relative h-full shrink-0 cursor-pointer border-r border-border/50 ${isInRange ? 'opacity-100' : 'opacity-30'}`}
                style={{ width: 56 }}
                onClick={() => onSeek(frame.timestamp)}
              >
                {frame.url ? (
                  <img
                    src={frame.url}
                    alt=""
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full bg-muted" />
                )}
              </div>
            )
          })}
        </div>

        {/* Start 标记 */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-green-500 cursor-ew-resize z-10"
          style={{ left: `${toPercent(startSec)}%` }}
          onMouseDown={(e) => {
            e.preventDefault()
            const container = containerRef.current!
            const rect = container.getBoundingClientRect()
            const totalWidth = container.scrollWidth
            const onMove = (ev: MouseEvent) => {
              const x = ev.clientX - rect.left + container.scrollLeft
              const ratio = Math.max(0, Math.min(1, x / totalWidth))
              const newTime = minTime + ratio * range
              if (newTime < endSec) onStartChange(Math.round(newTime * 10) / 10)
            }
            const onUp = () => {
              window.removeEventListener('mousemove', onMove)
              window.removeEventListener('mouseup', onUp)
            }
            window.addEventListener('mousemove', onMove)
            window.addEventListener('mouseup', onUp)
          }}
        >
          <div className="absolute -top-1 -left-1.5 w-3 h-3 rounded-full bg-green-500" />
        </div>

        {/* End 标记 */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-red-500 cursor-ew-resize z-10"
          style={{ left: `${toPercent(endSec)}%` }}
          onMouseDown={(e) => {
            e.preventDefault()
            const container = containerRef.current!
            const rect = container.getBoundingClientRect()
            const totalWidth = container.scrollWidth
            const onMove = (ev: MouseEvent) => {
              const x = ev.clientX - rect.left + container.scrollLeft
              const ratio = Math.max(0, Math.min(1, x / totalWidth))
              const newTime = minTime + ratio * range
              if (newTime > startSec) onEndChange(Math.round(newTime * 10) / 10)
            }
            const onUp = () => {
              window.removeEventListener('mousemove', onMove)
              window.removeEventListener('mouseup', onUp)
            }
            window.addEventListener('mousemove', onMove)
            window.addEventListener('mouseup', onUp)
          }}
        >
          <div className="absolute -top-1 -left-1.5 w-3 h-3 rounded-full bg-red-500" />
        </div>
      </div>
    </div>
  )
}
