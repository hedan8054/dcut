import { useEffect, type RefObject } from 'react'

interface DragSnapshot {
  lastX: number
  lastY: number
}

interface UseDragInteractionOptions {
  dragging: boolean
  processPointer: (clientX: number, clientY: number) => void
  finishDrag: (clientX: number, clientY: number) => void
  collectFrameLayout: () => void
  getDragSnapshot: () => DragSnapshot | null
  scrollParentRef: RefObject<HTMLElement | null>
  onPointerMoveEvent?: (event: PointerEvent) => void
  onPointerUpEvent?: (event: PointerEvent) => void
  onAutoScrollChange?: (value: { vx: number; vy: number } | null) => void
  autoScrollEdgePx?: number
  autoScrollMaxPx?: number
}

export function useDragInteraction({
  dragging,
  processPointer,
  finishDrag,
  collectFrameLayout,
  getDragSnapshot,
  scrollParentRef,
  onPointerMoveEvent,
  onPointerUpEvent,
  onAutoScrollChange,
  autoScrollEdgePx = 24,
  autoScrollMaxPx = 18,
}: UseDragInteractionOptions) {
  useEffect(() => {
    if (!dragging) return undefined

    const onMove = (event: PointerEvent) => {
      onPointerMoveEvent?.(event)
      processPointer(event.clientX, event.clientY)
    }

    const onUp = (event: PointerEvent) => {
      onPointerUpEvent?.(event)
      finishDrag(event.clientX, event.clientY)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, finishDrag, onPointerMoveEvent, onPointerUpEvent, processPointer])

  useEffect(() => {
    if (!dragging) {
      onAutoScrollChange?.(null)
      return undefined
    }

    let rafId = 0

    const tick = () => {
      const scrollEl = scrollParentRef.current
      const snapshot = getDragSnapshot()

      if (!scrollEl || !snapshot) {
        onAutoScrollChange?.(null)
        rafId = requestAnimationFrame(tick)
        return
      }

      const rect = scrollEl.getBoundingClientRect()
      let vx = 0
      let vy = 0

      if (snapshot.lastX < rect.left + autoScrollEdgePx) {
        const ratio = (rect.left + autoScrollEdgePx - snapshot.lastX) / autoScrollEdgePx
        vx = -Math.ceil(Math.min(1, ratio) * autoScrollMaxPx)
      } else if (snapshot.lastX > rect.right - autoScrollEdgePx) {
        const ratio = (snapshot.lastX - (rect.right - autoScrollEdgePx)) / autoScrollEdgePx
        vx = Math.ceil(Math.min(1, ratio) * autoScrollMaxPx)
      }

      if (snapshot.lastY < rect.top + autoScrollEdgePx) {
        const ratio = (rect.top + autoScrollEdgePx - snapshot.lastY) / autoScrollEdgePx
        vy = -Math.ceil(Math.min(1, ratio) * autoScrollMaxPx)
      } else if (snapshot.lastY > rect.bottom - autoScrollEdgePx) {
        const ratio = (snapshot.lastY - (rect.bottom - autoScrollEdgePx)) / autoScrollEdgePx
        vy = Math.ceil(Math.min(1, ratio) * autoScrollMaxPx)
      }

      if (vx !== 0 || vy !== 0) {
        scrollEl.scrollBy(vx, vy)
        onAutoScrollChange?.({ vx, vy })
        collectFrameLayout()
        processPointer(snapshot.lastX, snapshot.lastY)
      } else {
        onAutoScrollChange?.(null)
      }

      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(rafId)
      onAutoScrollChange?.(null)
    }
  }, [
    autoScrollEdgePx,
    autoScrollMaxPx,
    collectFrameLayout,
    dragging,
    getDragSnapshot,
    onAutoScrollChange,
    processPointer,
    scrollParentRef,
  ])
}
