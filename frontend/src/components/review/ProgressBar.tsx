import { useCallback, useRef } from 'react'
import type { TimeRange } from '@/lib/timeline-range'

interface CapsuleSlice {
  id: number
  start_sec: number
  end_sec: number
}

interface Props {
  videoDuration: number
  focusRange: TimeRange
  playbackSec: number
  anchorSec: number
  capsules: CapsuleSlice[]
  onClick: () => void
}

/**
 * Level 0: 8px 进度条 — 始终可见，提供全局方位感。
 *
 * 色彩:
 * - 白色色块: focusRange
 * - 橙色针: playbackSec (#FF8400)
 * - 白色针: anchorSec
 * - 绿色线段: 每个 capsule start~end (emerald-400)
 *
 * 点击 → 切换 minimap 展开/折叠
 */
export function ProgressBar({
  videoDuration,
  focusRange,
  playbackSec,
  anchorSec,
  capsules,
  onClick,
}: Props) {
  const barRef = useRef<HTMLDivElement>(null)

  const toPct = useCallback(
    (sec: number) => {
      if (videoDuration <= 0) return 0
      return (Math.max(0, Math.min(videoDuration, sec)) / videoDuration) * 100
    },
    [videoDuration],
  )

  if (videoDuration <= 0) return null

  const focusLeft = toPct(focusRange[0])
  const focusWidth = toPct(focusRange[1]) - focusLeft

  return (
    <div
      ref={barRef}
      className="relative h-2 shrink-0 cursor-pointer select-none"
      style={{ background: '#1A1D24' }}
      onClick={onClick}
      title="点击展开/折叠全局时间轴 (M)"
    >
      {/* focusRange 白色色块 */}
      <div
        className="absolute top-0 bottom-0 bg-white/25"
        style={{ left: `${focusLeft}%`, width: `${focusWidth}%` }}
      />

      {/* capsule 绿色线段 */}
      {capsules.map((c) => {
        const left = toPct(c.start_sec)
        const width = toPct(c.end_sec) - left
        return (
          <div
            key={c.id}
            className="absolute top-[2px] bottom-[2px] bg-emerald-400/70 rounded-full"
            style={{ left: `${left}%`, width: `${Math.max(0.15, width)}%` }}
          />
        )
      })}

      {/* 白色针 (anchorSec) */}
      <div
        className="absolute top-0 bottom-0 w-px bg-white/80 pointer-events-none"
        style={{ left: `${toPct(anchorSec)}%` }}
      />

      {/* 橙色针 (playbackSec) */}
      {playbackSec > 0 && (
        <div
          className="absolute top-0 bottom-0 w-[2px] pointer-events-none"
          style={{
            left: `${toPct(playbackSec)}%`,
            background: '#FF8400',
          }}
        />
      )}
    </div>
  )
}
