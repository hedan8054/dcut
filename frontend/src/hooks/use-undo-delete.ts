import { useCallback, useEffect, useRef, useState } from 'react'

export interface UndoPending<T> {
  token: number
  item: T
}

export function useUndoDelete<T>(timeoutMs = 5000) {
  const [pending, setPending] = useState<UndoPending<T> | null>(null)
  const seqRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  const clear = useCallback(() => {
    setPending(null)
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const stage = useCallback((item: T) => {
    const token = ++seqRef.current
    setPending({ token, item })

    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }

    timerRef.current = window.setTimeout(() => {
      setPending(prev => (prev?.token === token ? null : prev))
      timerRef.current = null
    }, timeoutMs)
  }, [timeoutMs])

  const consume = useCallback((): T | null => {
    if (!pending) return null
    const item = pending.item
    clear()
    return item
  }, [clear, pending])

  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
      }
    }
  }, [])

  return { pending, stage, clear, consume }
}
