/** 秒 -> HH:MM:SS */
export function formatSec(sec: number): string {
  const totalSec = Math.floor(sec)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 秒 -> MM:SS（不足1小时时） */
export function formatSecShort(sec: number): string {
  const totalSec = Math.floor(sec)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 秒 -> 中文时长描述 "3m15s" */
export function formatDuration(sec: number): string {
  const totalSec = Math.floor(sec)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m === 0) return `${s}s`
  if (s === 0) return `${m}m`
  return `${m}m${s}s`
}
