/**
 * 诊断面板 — 仅在 ?rbdiag=1 时渲染
 * 从 MultiRowTimeline 提取，用于调试 rubber band 拖拽行为
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CapsuleInteractionState } from '@/types'

interface RbDiagEvent {
  id: number
  type: string
  x: number | null
  y: number | null
  tag: string
  cls: string
}

function getTargetSnapshot(target: EventTarget | null): { tag: string; cls: string } {
  if (!(target instanceof Element)) return { tag: 'UNKNOWN', cls: '' }
  const cls = typeof target.className === 'string'
    ? target.className
    : (target.getAttribute('class') ?? '')
  return {
    tag: target.tagName,
    cls: cls.trim().replace(/\s+/g, '.').slice(0, 120),
  }
}

export interface DiagCallbacks {
  pushDiagEvent: (ev: Event, eventType?: string) => void
  setDiagSnapTarget: (val: number | null) => void
  setDiagAutoScroll: (val: { vx: number; vy: number } | null) => void
}

interface DiagPanelProps {
  rbFixVersion: string
  activeCapsuleId: number | null
  interactionState: CapsuleInteractionState
  diagSnapTarget: number | null
  diagAutoScroll: { vx: number; vy: number } | null
  diagDragStartCount: number
  diagLastMouseMove: { x: number; y: number } | null
  diagEvents: RbDiagEvent[]
}

export function DiagPanel({
  rbFixVersion,
  activeCapsuleId,
  interactionState,
  diagSnapTarget,
  diagAutoScroll,
  diagDragStartCount,
  diagLastMouseMove,
  diagEvents,
}: DiagPanelProps) {
  return (
    <div className="fixed right-3 bottom-3 z-[90] w-[360px] rounded-md border border-yellow-500/60 bg-black/85 text-yellow-100 shadow-lg pointer-events-none">
      <div className="px-2 py-1 border-b border-yellow-500/40 flex items-center justify-between text-[11px] font-mono">
        <span>RB DIAG</span>
        <span>fix={rbFixVersion}</span>
      </div>
      <div className="px-2 py-1 text-[11px] font-mono grid grid-cols-2 gap-x-2 gap-y-1">
        <span>dragstart: {diagDragStartCount}</span>
        <span>active: {activeCapsuleId ?? '-'}</span>
        <span>state: {interactionState}</span>
        <span>snap: {diagSnapTarget ?? '-'}</span>
        <span>auto: {diagAutoScroll ? `${diagAutoScroll.vx},${diagAutoScroll.vy}` : '0,0'}</span>
        <span className="col-span-2">move: {diagLastMouseMove ? `${diagLastMouseMove.x},${diagLastMouseMove.y}` : 'N/A'}</span>
      </div>
      <div className="px-2 pb-2 max-h-52 overflow-y-auto space-y-1 font-mono text-[10px] leading-tight">
        {diagEvents.map(ev => (
          <div key={ev.id} className="bg-white/5 rounded px-1 py-0.5">
            <span className="text-yellow-300">{ev.type}</span>
            {' '}
            <span>{ev.x == null || ev.y == null ? '(-,-)' : `(${ev.x},${ev.y})`}</span>
            {' '}
            <span className="text-zinc-300">{ev.tag}</span>
            {' '}
            <span className="text-zinc-500 truncate">{ev.cls || '-'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 诊断状态管理 hook — 仅在 DEV + ?rbdiag=1 时激活 */
export function useDiagState() {
  const rbDiagEnabled = (() => {
    if (!import.meta.env.DEV || typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('rbdiag') === '1'
  })()

  const rbFixVersion = (() => {
    if (typeof window === 'undefined') return 'bg-v2'
    return new URLSearchParams(window.location.search).get('rbfix') || 'bg-v2'
  })()

  const diagSeqRef = useRef(0)
  const diagLastMoveLogAtRef = useRef(0)
  const [diagEvents, setDiagEvents] = useState<RbDiagEvent[]>([])
  const [diagDragStartCount, setDiagDragStartCount] = useState(0)
  const [diagLastMouseMove, setDiagLastMouseMove] = useState<{ x: number; y: number } | null>(null)
  const [diagSnapTarget, setDiagSnapTarget] = useState<number | null>(null)
  const [diagAutoScroll, setDiagAutoScroll] = useState<{ vx: number; vy: number } | null>(null)

  useEffect(() => {
    if (!rbDiagEnabled) return
    diagSeqRef.current = 0
    diagLastMoveLogAtRef.current = 0
    setDiagEvents([])
    setDiagDragStartCount(0)
    setDiagLastMouseMove(null)
    setDiagSnapTarget(null)
    setDiagAutoScroll(null)
  }, [rbDiagEnabled])

  const pushDiagEvent = useCallback((ev: Event, eventType?: string) => {
    if (!rbDiagEnabled) return
    const type = eventType ?? ev.type
    const mouseLike = ev as MouseEvent
    const x = typeof mouseLike.clientX === 'number' ? mouseLike.clientX : null
    const y = typeof mouseLike.clientY === 'number' ? mouseLike.clientY : null
    const target = getTargetSnapshot(ev.target)

    if (type === 'pointermove' && x != null && y != null) {
      setDiagLastMouseMove({ x, y })
      const now = performance.now()
      if (now - diagLastMoveLogAtRef.current < 80) return
      diagLastMoveLogAtRef.current = now
    }

    if (type === 'dragstart') {
      setDiagDragStartCount(v => v + 1)
    }

    const id = ++diagSeqRef.current
    setDiagEvents(prev => [{ id, type, x, y, tag: target.tag, cls: target.cls }, ...prev].slice(0, 20))
  }, [rbDiagEnabled])

  return {
    rbDiagEnabled,
    rbFixVersion,
    diagEvents,
    diagDragStartCount,
    diagLastMouseMove,
    diagSnapTarget,
    diagAutoScroll,
    pushDiagEvent,
    setDiagSnapTarget,
    setDiagAutoScroll,
  }
}
