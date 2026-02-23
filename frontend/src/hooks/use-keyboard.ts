import { useEffect } from 'react'

type KeyHandler = (e: KeyboardEvent) => void

/**
 * 全局键盘快捷键 hook
 */
export function useKeyboard(handlers: Record<string, KeyHandler>) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 忽略输入框内的按键
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      const handler = handlers[e.key]
      if (handler) {
        handler(e)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handlers])
}
