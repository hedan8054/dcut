export type TimeRange = [number, number]

export function rangeSpan(range: TimeRange): number {
  return Math.max(0, range[1] - range[0])
}

export function rangeCenter(range: TimeRange): number {
  return range[0] + rangeSpan(range) / 2
}

export function clampRange(range: TimeRange, duration: number, minSpan = 0): TimeRange {
  if (duration <= 0) return [0, 0]
  const safeMinSpan = Math.max(0, Math.min(minSpan, duration))
  let start = Number.isFinite(range[0]) ? range[0] : 0
  let end = Number.isFinite(range[1]) ? range[1] : start
  if (end < start) [start, end] = [end, start]
  if (end - start < safeMinSpan) end = start + safeMinSpan
  if (end > duration) {
    end = duration
    start = end - Math.max(safeMinSpan, end - start)
  }
  if (start < 0) {
    start = 0
    end = Math.min(duration, start + Math.max(safeMinSpan, end - start))
  }
  if (end < start) end = start
  return [Math.max(0, start), Math.min(duration, end)]
}

export function makeCenteredRange(center: number, span: number, duration: number): TimeRange {
  const half = Math.max(0, span) / 2
  return clampRange([center - half, center + half], duration, Math.min(span, duration))
}

export function clampFocusIntoCoarse(
  focus: TimeRange,
  coarse: TimeRange,
  duration: number,
  minSpan: number,
): TimeRange {
  const coarseSafe = clampRange(coarse, duration, minSpan)
  let next = clampRange(focus, duration, minSpan)
  const coarseSpan = rangeSpan(coarseSafe)
  const targetSpan = Math.min(Math.max(minSpan, rangeSpan(next)), coarseSpan)
  if (targetSpan <= 0) return coarseSafe

  let start = next[0]
  let end = start + targetSpan
  if (start < coarseSafe[0]) {
    start = coarseSafe[0]
    end = start + targetSpan
  }
  if (end > coarseSafe[1]) {
    end = coarseSafe[1]
    start = end - targetSpan
  }
  next = [start, end]
  return clampRange(next, duration, minSpan)
}

export interface ExpandResult {
  focus: TimeRange
  coarse: TimeRange
  /** 是否撞到视频绝对边界 (0 或 duration) */
  hitBoundary: boolean
}

/**
 * 单方向扩展 focus，必要时同步扩展 coarse（白不越橙）。
 *
 * direction='right' → focus[1] += deltaSec，coarse[1] 跟扩
 * direction='left'  → focus[0] -= deltaSec，coarse[0] 跟扩
 *
 * 硬边界: clamp 到 [0, duration]。
 */
export function expandFocusOneDirection(
  focus: TimeRange,
  coarse: TimeRange,
  direction: 'left' | 'right',
  deltaSec: number,
  duration: number,
  minFocusSpan: number,
): ExpandResult {
  let [fs, fe] = focus
  let [cs, ce] = coarse
  let hitBoundary = false

  if (direction === 'right') {
    fe += deltaSec
    if (fe >= duration) { fe = duration; hitBoundary = true }
    // 白不越橙: focus 右边界不能超 coarse 右边界
    if (fe > ce) ce = fe
  } else {
    fs -= deltaSec
    if (fs <= 0) { fs = 0; hitBoundary = true }
    // 白不越橙: focus 左边界不能小于 coarse 左边界
    if (fs < cs) cs = fs
  }

  // 确保 focus 最小跨度
  if (fe - fs < minFocusSpan) {
    if (direction === 'right') fe = Math.min(duration, fs + minFocusSpan)
    else fs = Math.max(0, fe - minFocusSpan)
  }

  // 最终 clamp
  const nextFocus = clampRange([fs, fe], duration, minFocusSpan)
  const nextCoarse = clampRange([cs, ce], duration, minFocusSpan)

  return { focus: nextFocus, coarse: nextCoarse, hitBoundary }
}

