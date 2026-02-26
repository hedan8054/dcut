import { useCallback, useRef, useState } from 'react'
import type { ExpandResult } from '@/lib/timeline-range'

// --- 文档第 5 节量化参数 ---
const DEFAULT_EDGE_THRESHOLD_PX = 20
const DEFAULT_START_DELAY_MS = 300
const DEFAULT_THROTTLE_MS = 150
/** 递进步长（秒）：0-300ms=无, 300-900ms=+10s, 900-1500ms=+20s, 1500ms+=+30s */
const DEFAULT_STEPS: readonly number[] = [10, 20, 30]
/** 回滞带倍数: 扩窗中维持热区的阈值 = edgeThresholdPx * HYSTERESIS_FACTOR */
const HYSTERESIS_FACTOR = 3

export interface AutoExpandOptions {
  videoDuration: number
  minFocusSpan: number
  edgeThresholdPx?: number
  startDelayMs?: number
  throttleMs?: number
  steps?: readonly number[]
  /** 调用方提供的扩窗执行器 */
  onExpand: (direction: 'left' | 'right', deltaSec: number) => ExpandResult
}

export interface AutoExpandState {
  /** 当前发光方向（用于 UI overlay） */
  glowSide: 'left' | 'right' | null
  /** 是否正在扩展中 */
  expanding: boolean
  /** 是否撞到视频绝对边界 */
  hitBoundary: boolean
  /** 贴边预备态: 在热区但还没到起步延迟 */
  preExpand: boolean
  /** 当前扩窗步长 (10/20/30) 或 null */
  currentStep: number | null
}

export interface AutoExpandReturn extends AutoExpandState {
  /**
   * 每帧 pointermove 中调用。
   * @param distToBoundaryPx 指针距容器边缘的像素距离（正数 = 在内侧）
   * @param direction 'left' | 'right' — 哪侧边界
   */
  checkEdgeHit: (distToBoundaryPx: number, direction: 'left' | 'right') => void
  /** pointerup / dragEnd 时调用，清理定时器 */
  stopExpand: () => void
}

/**
 * 自动扩窗 hook
 *
 * 管理"拖拽贴边 → 延迟 → 节流递进扩窗"的状态机。
 * 不直接修改 React state；通过 `onExpand` 回调让调用方控制 focusRange/coarseRange。
 *
 * 时序:
 *   进入热区(< 20px) → 等 300ms → 第一次扩 +10s → 每 150ms 继续扩
 *   停留 600ms 后步长升级 +20s → 停留 1200ms 后升级 +30s
 *
 * 回滞带: 扩窗中使用 3x 阈值防止微小抖动导致中断
 */
export function useAutoExpand(options: AutoExpandOptions): AutoExpandReturn {
  const {
    edgeThresholdPx = DEFAULT_EDGE_THRESHOLD_PX,
    startDelayMs = DEFAULT_START_DELAY_MS,
    throttleMs = DEFAULT_THROTTLE_MS,
    steps = DEFAULT_STEPS,
    onExpand,
  } = options

  // 状态全部用 ref（避免高频 setState 触发渲染）
  const expandingRef = useRef(false)
  const glowSideRef = useRef<'left' | 'right' | null>(null)
  const hitBoundaryRef = useRef(false)
  const directionRef = useRef<'left' | 'right' | null>(null)
  // 贴边预备态 + 当前步长
  const preExpandRef = useRef(false)
  const currentStepRef = useRef<number | null>(null)

  // --- React state: 驱动 UI 渲染（从 ref 同步） ---
  const [uiState, setUiState] = useState<AutoExpandState>({
    glowSide: null,
    expanding: false,
    hitBoundary: false,
    preExpand: false,
    currentStep: null,
  })
  /** 将 ref 快照同步到 React state，触发一次渲染 */
  const flushState = useCallback(() => {
    setUiState({
      glowSide: glowSideRef.current,
      expanding: expandingRef.current,
      hitBoundary: hitBoundaryRef.current,
      preExpand: preExpandRef.current,
      currentStep: currentStepRef.current,
    })
  }, [])

  // 定时器
  const delayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // dwell 起始时间（进入热区的时刻）
  const dwellStartRef = useRef(0)
  // 上次扩窗时间（用于节流校验）
  const lastExpandRef = useRef(0)
  // 同向累计 delta（节流窗口内合并）
  const pendingDeltaRef = useRef(0)

  const clearTimers = useCallback(() => {
    if (delayTimerRef.current !== null) {
      clearTimeout(delayTimerRef.current)
      delayTimerRef.current = null
    }
    if (intervalTimerRef.current !== null) {
      clearInterval(intervalTimerRef.current)
      intervalTimerRef.current = null
    }
  }, [])

  /** 根据 dwell 时长选择步长档位 */
  const getStepSec = useCallback((): number => {
    const dwellMs = Date.now() - dwellStartRef.current
    // 300-900ms → steps[0], 900-1500ms → steps[1], 1500ms+ → steps[2]
    if (dwellMs < startDelayMs + 600) return steps[0] ?? 10
    if (dwellMs < startDelayMs + 1200) return steps[1] ?? 20
    return steps[2] ?? 30
  }, [startDelayMs, steps])

  /** 执行一次扩窗 */
  const doExpand = useCallback(() => {
    const dir = directionRef.current
    if (!dir) return

    const now = Date.now()
    const stepSec = getStepSec()
    currentStepRef.current = stepSec

    // 节流: 距上次扩窗 < throttleMs → 累计到 pendingDelta
    if (now - lastExpandRef.current < throttleMs) {
      pendingDeltaRef.current += stepSec
      flushState()
      return
    }

    const totalDelta = stepSec + pendingDeltaRef.current
    pendingDeltaRef.current = 0
    lastExpandRef.current = now

    const result = onExpand(dir, totalDelta)
    hitBoundaryRef.current = result.hitBoundary

    if (result.hitBoundary) {
      // 撞到绝对边界 → 停止继续扩窗
      clearTimers()
      expandingRef.current = false
      preExpandRef.current = false
    }
    flushState()
  }, [clearTimers, flushState, getStepSec, onExpand, throttleMs])

  /** 启动扩窗循环 */
  const startExpandCycle = useCallback((direction: 'left' | 'right') => {
    directionRef.current = direction
    expandingRef.current = true
    hitBoundaryRef.current = false
    pendingDeltaRef.current = 0
    lastExpandRef.current = 0
    preExpandRef.current = true
    currentStepRef.current = null
    flushState()

    // 300ms 延迟后首次扩窗
    delayTimerRef.current = setTimeout(() => {
      preExpandRef.current = false
      flushState()
      doExpand()
      // 之后每 throttleMs 持续扩窗
      intervalTimerRef.current = setInterval(() => {
        doExpand()
      }, throttleMs)
    }, startDelayMs)
  }, [doExpand, flushState, startDelayMs, throttleMs])

  const checkEdgeHit = useCallback((distToBoundaryPx: number, direction: 'left' | 'right') => {
    // 负距离 = 指针已越过边界（拖出轨道外）= 最强扩窗意图，视同在热区内
    const inZone = distToBoundaryPx < edgeThresholdPx

    // 回滞带: 扩窗中 + 同方向 → 用更宽松的阈值，防止微小抖动中断扩窗
    const keepZone = expandingRef.current
      && directionRef.current === direction
      && distToBoundaryPx < edgeThresholdPx * HYSTERESIS_FACTOR

    if (inZone || keepZone) {
      glowSideRef.current = direction

      // 已经在同方向扩展中 → 不重启
      if (expandingRef.current && directionRef.current === direction) return

      // 方向变了或尚未开始 → 重启
      clearTimers()
      dwellStartRef.current = Date.now()
      startExpandCycle(direction)
    } else {
      // 离开热区 → 停止扩窗
      if (expandingRef.current || glowSideRef.current !== null) {
        clearTimers()
        expandingRef.current = false
        glowSideRef.current = null
        directionRef.current = null
        pendingDeltaRef.current = 0
        preExpandRef.current = false
        currentStepRef.current = null
        flushState()
      }
    }
  }, [clearTimers, edgeThresholdPx, flushState, startExpandCycle])

  const stopExpand = useCallback(() => {
    clearTimers()
    expandingRef.current = false
    glowSideRef.current = null
    hitBoundaryRef.current = false
    directionRef.current = null
    pendingDeltaRef.current = 0
    preExpandRef.current = false
    currentStepRef.current = null
    flushState()
  }, [clearTimers, flushState])

  return {
    checkEdgeHit,
    stopExpand,
    glowSide: uiState.glowSide,
    expanding: uiState.expanding,
    hitBoundary: uiState.hitBoundary,
    preExpand: uiState.preExpand,
    currentStep: uiState.currentStep,
  }
}
