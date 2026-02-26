import { useCallback, useEffect, useRef, useState } from 'react'

export type UiHintVariant = 'info' | 'warning'

export interface UiHint {
  id: number
  text: string
  variant: UiHintVariant
}

export function useUiHint(defaultDurationMs = 1400) {
  const [hint, setHint] = useState<UiHint | null>(null)
  const seqRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  const clear = useCallback(() => {
    setHint(null)
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const show = useCallback((text: string, durationMs = defaultDurationMs, variant: UiHintVariant = 'info') => {
    const id = ++seqRef.current
    setHint({ id, text, variant })

    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }

    if (durationMs <= 0) return

    timerRef.current = window.setTimeout(() => {
      setHint(prev => (prev?.id === id ? null : prev))
      timerRef.current = null
    }, durationMs)
  }, [defaultDurationMs])

  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
      }
    }
  }, [])

  return { hint, show, clear }
}
