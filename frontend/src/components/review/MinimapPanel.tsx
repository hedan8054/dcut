import { useCallback, useEffect, useState } from 'react'
import { Pin } from 'lucide-react'

const LS_KEY = 'minimap_pinned'

interface Props {
  open: boolean
  children: React.ReactNode
  onPinnedChange?: (pinned: boolean) => void
}

/**
 * Level 1: 可折叠 Minimap 面板
 *
 * 包裹 GlobalTimeline，提供:
 * - CSS grid 折叠/展开动画 (200ms)
 * - 右上角图钉按钮锁定常驻
 * - pinned 持久化到 localStorage
 */
export function MinimapPanel({ open, children, onPinnedChange }: Props) {
  const [pinned, setPinned] = useState(() => {
    try { return localStorage.getItem(LS_KEY) === '1' } catch { return false }
  })

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, pinned ? '1' : '0') } catch { /* ignore */ }
    onPinnedChange?.(pinned)
  }, [pinned, onPinnedChange])

  const togglePin = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setPinned(v => !v)
  }, [])

  const isOpen = open || pinned

  return (
    <div
      className="grid transition-[grid-template-rows] duration-200 ease-in-out"
      style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}
    >
      <div className="overflow-hidden min-h-0">
        <div className="relative">
          {/* 图钉按钮 */}
          <button
            type="button"
            onClick={togglePin}
            className={`absolute top-1 right-1 z-10 p-1 rounded transition-colors ${
              pinned
                ? 'bg-rv-accent/20 text-rv-accent'
                : 'bg-black/30 text-muted-foreground hover:text-foreground'
            }`}
            title={pinned ? '取消锁定' : '锁定常驻'}
          >
            <Pin className={`w-3.5 h-3.5 ${pinned ? '' : 'rotate-45'}`} />
          </button>
          {children}
        </div>
      </div>
    </div>
  )
}

/** 读取 localStorage 中的 pinned 初始值 */
export function getInitialPinned(): boolean {
  try { return localStorage.getItem(LS_KEY) === '1' } catch { return false }
}
