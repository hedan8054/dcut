import { useCallback, useRef } from 'react'

interface UndoStack<T> {
  /** 推入一条记录（清空 redo 栈） */
  push: (entry: T) => void
  /** 撤销：弹出最近一条，返回它；无可撤则返回 null */
  undo: () => T | null
  /** 重做：返回刚撤销的条目；无可重则返回 null */
  redo: () => T | null
  canUndo: boolean
  canRedo: boolean
  /** 清空所有历史 */
  clear: () => void
}

/**
 * 泛型 undo/redo 栈 hook
 *
 * 用于编辑栈（胶囊几何）和视窗栈（focusRange）。
 * 使用 ref 存储避免每次 push 触发重渲染；
 * undo/redo 返回值由调用方决定如何应用。
 */
export function useUndoStack<T>(maxDepth = 50): UndoStack<T> {
  const undoRef = useRef<T[]>([])
  const redoRef = useRef<T[]>([])
  // 触发外部感知变化的版本号（仅用于 canUndo/canRedo）
  const versionRef = useRef(0)

  const push = useCallback((entry: T) => {
    undoRef.current.push(entry)
    if (undoRef.current.length > maxDepth) {
      undoRef.current.splice(0, undoRef.current.length - maxDepth)
    }
    // 新操作清空 redo 栈
    redoRef.current.length = 0
    versionRef.current++
  }, [maxDepth])

  const undo = useCallback((): T | null => {
    const entry = undoRef.current.pop() ?? null
    if (entry !== null) {
      redoRef.current.push(entry)
      versionRef.current++
    }
    return entry
  }, [])

  const redo = useCallback((): T | null => {
    const entry = redoRef.current.pop() ?? null
    if (entry !== null) {
      undoRef.current.push(entry)
      versionRef.current++
    }
    return entry
  }, [])

  const clear = useCallback(() => {
    undoRef.current.length = 0
    redoRef.current.length = 0
    versionRef.current++
  }, [])

  return {
    push,
    undo,
    redo,
    get canUndo() { return undoRef.current.length > 0 },
    get canRedo() { return redoRef.current.length > 0 },
    clear,
  }
}
