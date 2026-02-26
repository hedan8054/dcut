import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useReviewStore } from '@/stores/reviewStore'
import {
  fetchTodayPlan,
  fetchVerified,
  fetchVideoRegistry,
  registerVideo,
  fetchSkuImages,
  fetchSkuSessions,
} from '@/api/client'
import { SkuPanel } from '@/components/review/SkuPanel'
import { SessionTopBar } from '@/components/review/SessionTopBar'
import { GlobalTimeline } from '@/components/review/GlobalTimeline'
import { ProgressBar } from '@/components/review/ProgressBar'
import { MinimapPanel, getInitialPinned } from '@/components/review/MinimapPanel'
import { MultiRowTimeline } from '@/components/review/MultiRowTimeline'
import { AnnotationBar } from '@/components/review/AnnotationBar'
import { NasScanPanel } from '@/components/review/NasScanPanel'
import { useCapsuleManager } from '@/hooks/use-capsule-manager'
import { useClipSearch } from '@/hooks/use-clip-search'
import { useMultiResFrames } from '@/hooks/use-multi-res-frames'
import { useAutoExpand } from '@/hooks/use-auto-expand'
import { useUndoStack } from '@/hooks/use-undo-stack'
import { useUiHint } from '@/hooks/use-ui-hint'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Star, ChevronDown, Plus, Loader2, ScanSearch } from 'lucide-react'
import { formatSec, formatDuration } from '@/lib/format'
import {
  clampFocusIntoCoarse,
  clampRange,
  expandFocusOneDirection,
  makeCenteredRange,
  rangeCenter,
  rangeSpan,
  type TimeRange,
} from '@/lib/timeline-range'
import type {
  Lead,
  VerifiedClip,
  VideoControl,
  VideoRegistry,
  SkuImage,
  EnrichedPlanItem,
  SessionGroup,
} from '@/types'

const COARSE_SPAN_SEC = 20 * 60
const FOCUS_DEFAULT_SPAN_SEC = 4 * 60
const FOCUS_MIN_SPAN_SEC = 20

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return target.closest('[contenteditable="true"]') !== null
}

function parseLeadTimestamps(leads: Lead[]): number[] {
  const result: number[] = []
  for (const lead of leads) {
    try {
      const points: string[] = JSON.parse(lead.time_points_json)
      for (const pt of points) {
        const parts = pt.split(':').map(Number)
        if (parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
          result.push(parts[0] * 3600 + parts[1] * 60)
        }
      }
    } catch {
      // ignore invalid lead point payload
    }
  }
  return result
}

export default function ReviewPage() {
  const store = useReviewStore()
  const {
    currentSkuCode,
    setCurrentSkuCode,
    setCurrentLead,
    savedClips,
    setSavedClips,
    mode,
    setMode,
    sessions,
    setSessions,
    sessionsLoading,
    setSessionsLoading,
    currentSession,
    setCurrentSession,
    videoInfo,
    setVideoInfo,
    anchorSec,
    setAnchorSec,
    setViewRange,
    expandedSkuCode,
    setExpandedSkuCode,
    playbackSec,
    isPlaying,
  } = store

  const videoControlRef = useRef<VideoControl | null>(null)
  const [planItems, setPlanItems] = useState<EnrichedPlanItem[]>([])
  const [planLoading, setPlanLoading] = useState(true)
  const [sessionLeads, setSessionLeads] = useState<Lead[]>([])
  const [skuImages, setSkuImages] = useState<SkuImage[]>([])
  const [allVideos, setAllVideos] = useState<VideoRegistry[]>([])
  const [showVideoManager, setShowVideoManager] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [regDate, setRegDate] = useState('')
  const [regPath, setRegPath] = useState('')
  const [regLabel, setRegLabel] = useState('')

  const [coarseRange, setCoarseRange] = useState<TimeRange>([0, 0])
  const [focusRange, setFocusRange] = useState<TimeRange>([0, 0])
  const [, setTimelineCapacity] = useState(40)
  const [minimapOpen, setMinimapOpen] = useState(false)
  const [, setMinimapPinned] = useState(getInitialPinned)

  // 用 ref 存 focusRange/coarseRange 供高频回调使用（避免闭包过期）
  const focusRangeRef = useRef(focusRange)
  focusRangeRef.current = focusRange
  const coarseRangeRef = useRef(coarseRange)
  coarseRangeRef.current = coarseRange

  const videoPath = useMemo(() => {
    if (!videoInfo) return ''
    return videoInfo.proxy_path || videoInfo.raw_path
  }, [videoInfo])
  const videoId = videoInfo?.id
  const videoDuration = videoInfo?.duration_sec || 4 * 3600
  const leadTimestamps = useMemo(() => parseLeadTimestamps(sessionLeads), [sessionLeads])

  const framesHook = useMultiResFrames(videoDuration)
  const {
    getFrames,
    extendRange,
    loadL3,
    startPreload,
    reset: resetFrames,
    loading: frameLoading,
    progress: frameProgress,
    version: frameVersion,
  } = framesHook

  const l2Frames = useMemo(
    () => getFrames('L2', coarseRange[0], coarseRange[1], 10),
    [getFrames, coarseRange, frameVersion],
  )

  const l3Frames = useMemo(
    () => getFrames('L3', focusRange[0], focusRange[1]),
    [getFrames, focusRange, frameVersion],
  )

  const timelineFrames = useMemo(() => {
    if (l3Frames.length === 0) return l2Frames
    const l3Start = l3Frames[0].timestamp
    const l3End = l3Frames[l3Frames.length - 1].timestamp
    const l2Before = l2Frames.filter(f => f.timestamp < l3Start)
    const l2After = l2Frames.filter(f => f.timestamp > l3End)
    return [...l2Before, ...l3Frames, ...l2After]
  }, [l2Frames, l3Frames])

  const timelineLoading = frameLoading.L2 || frameLoading.L3
  const timelineProgress: [number, number] = frameLoading.L3 ? frameProgress.L3 : frameProgress.L2

  const [searchParams] = useSearchParams()
  const capsuleDryrun = useMemo(() => searchParams.get('capsule_dryrun') === '1', [searchParams])
  const { hint: uiHint, show: showUiHint } = useUiHint()

  /** 自动扩窗回调 — 由 useAutoExpand hook 在贴边延迟后调用 */
  const handleAutoExpand = useCallback((direction: 'left' | 'right', deltaSec: number) => {
    const result = expandFocusOneDirection(
      focusRangeRef.current, coarseRangeRef.current,
      direction, deltaSec, videoDuration, FOCUS_MIN_SPAN_SEC,
    )
    setFocusRange(result.focus)
    setCoarseRange(result.coarse)
    // 立即同步 ref，避免高频连续调用时闭包过期
    focusRangeRef.current = result.focus
    coarseRangeRef.current = result.coarse
    // 预取扩展范围的帧（L2 粗帧 + L3 焦点区精细帧）
    if (videoPath) {
      extendRange(videoPath, videoId, 'L2', result.coarse[0], result.coarse[1], 10)
      extendRange(videoPath, videoId, 'L3', result.focus[0], result.focus[1])
    }
    if (result.hitBoundary) {
      showUiHint('已到视频边界', 500, 'warning')
    }
    return result
  }, [videoDuration, videoPath, videoId, extendRange, showUiHint])

  const autoExpand = useAutoExpand({
    videoDuration,
    minFocusSpan: FOCUS_MIN_SPAN_SEC,
    onExpand: handleAutoExpand,
  })

  const { results: clipResults, searching: clipSearching, search: handleClipSearch, clear: clearClipResults } = useClipSearch(videoInfo, skuImages)

  const {
    capsules,
    capsulesLoading,
    activeCapsule,
    activeCapsuleId,
    interactionState: capsuleInteractionState,
    setInteractionState: setCapsuleInteractionState,
    undoPending: undoDelete,
    clearUndoState,
    createCapsule: handleCreateCapsule,
    createDefaultCapsuleAt,
    updateGeometry: handleUpdateCapsuleGeometry,
    activateCapsule: handleActivateCapsule,
    handleFrameSelect,
    patchActive: handlePatchActiveCapsule,
    deleteActive: handleDeleteActiveCapsule,
    undoDeleteCapsule: handleUndoDelete,
    cycleOverlapAtAnchor,
  } = useCapsuleManager({
    videoInfo,
    videoPath,
    videoId,
    videoDuration,
    anchorSec,
    setAnchorSec,
    currentSkuCode,
    setMode,
    dryrun: capsuleDryrun,
    showUiHint,
  })

  // --- 双栈 Undo (Sprint 4.1) ---
  const editStack = useUndoStack<{
    capsuleId: number
    before: { start_sec: number; end_sec: number }
    after: { start_sec: number; end_sec: number }
  }>()
  const viewportStack = useUndoStack<TimeRange>()

  /** 胶囊几何更新 + 编辑栈推入（before/after 对） */
  const handleUpdateWithUndo = useCallback((capsuleId: number, patch: { start_sec?: number; end_sec?: number }) => {
    const current = capsules.find(c => c.id === capsuleId)
    if (current) {
      editStack.push({
        capsuleId,
        before: { start_sec: current.start_sec, end_sec: current.end_sec },
        after: {
          start_sec: patch.start_sec ?? current.start_sec,
          end_sec: patch.end_sec ?? current.end_sec,
        },
      })
    }
    return handleUpdateCapsuleGeometry(capsuleId, patch)
  }, [capsules, editStack, handleUpdateCapsuleGeometry])

  /** 胶囊交互状态变化 — 拖拽开始时入 viewport 栈 */
  const handleInteractionStateChange = useCallback((state: import('@/types').CapsuleInteractionState) => {
    setCapsuleInteractionState(state)
    if (state === 'dragging') {
      // 拖拽会话级: 整个拖拽的所有 auto-expand 只算一条 viewport undo 记录
      viewportStack.push([...focusRangeRef.current] as TimeRange)
    }
  }, [setCapsuleInteractionState, viewportStack])

  useEffect(() => {
    setViewRange(focusRange)
  }, [focusRange, setViewRange])

  useEffect(() => {
    if (!videoPath) return
    extendRange(videoPath, videoId, 'L2', coarseRange[0], coarseRange[1], 10)
  }, [coarseRange, extendRange, videoId, videoPath])

  useEffect(() => {
    fetchTodayPlan()
      .then(ep => {
        const items = ep?.items ?? []
        setPlanItems(items)
        // SKU 列表默认展开第一个（或 URL 参数指定的）
        if (items.length > 0 && !expandedSkuCode) {
          const target = searchParams.get('sku')?.toUpperCase()
          const code = items.find(i => i.sku_code === target)?.sku_code ?? items[0].sku_code
          setCurrentSkuCode(code)
          setExpandedSkuCode(code)
        }
      })
      .catch(console.error)
      .finally(() => setPlanLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- 只在首次加载时执行

  useEffect(() => {
    fetchVideoRegistry().then(setAllVideos).catch(console.error)
  }, [])

  const bootstrapRanges = useCallback((anchor: number, duration: number) => {
    const coarse = makeCenteredRange(anchor, COARSE_SPAN_SEC, duration)
    const focusSeed = makeCenteredRange(anchor, FOCUS_DEFAULT_SPAN_SEC, duration)
    const focus = clampFocusIntoCoarse(focusSeed, coarse, duration, FOCUS_MIN_SPAN_SEC)
    setCoarseRange(coarse)
    setFocusRange(focus)
    return { coarse, focus }
  }, [])

  const selectSession = useCallback((session: SessionGroup) => {
    setCurrentSession(session)
    setSessionLeads(session.leads)
    const video = session.video
    setVideoInfo(video)
    setMode('browse')
    resetFrames()
    clearUndoState()

    const dur = video?.duration_sec || 4 * 3600
    const timestamps = parseLeadTimestamps(session.leads)
    const anchor = timestamps.length > 0 ? timestamps[0] : 0
    setAnchorSec(anchor)
    if (session.leads.length > 0) setCurrentLead(session.leads[0])
    const { coarse, focus } = bootstrapRanges(anchor, dur)

    if (video) {
      const vPath = video.proxy_path || video.raw_path
      startPreload(vPath, anchor, video.id)
      extendRange(vPath, video.id, 'L2', coarse[0], coarse[1], 10)
      loadL3(vPath, rangeCenter(focus), video.id)
    }
    clearClipResults()
  }, [
    bootstrapRanges,
    extendRange,
    loadL3,
    resetFrames,
    setAnchorSec,
    setCurrentLead,
    setCurrentSession,
    setMode,
    clearUndoState,
    startPreload,
    setVideoInfo,
  ])

  const selectSessionRef = useRef(selectSession)
  selectSessionRef.current = selectSession

  useEffect(() => {
    if (!currentSkuCode) {
      setSkuImages([])
      setSessions([])
      setCurrentSession(null)
      setVideoInfo(null)
      clearUndoState()
      return
    }

    fetchVerified(currentSkuCode).then(setSavedClips).catch(console.error)
    fetchSkuImages(currentSkuCode).then(setSkuImages).catch(() => setSkuImages([]))

    setSessionsLoading(true)
    fetchSkuSessions(currentSkuCode)
      .then(data => {
        setSessions(data.sessions)
        const withVideo = data.sessions.find(s => s.video !== null)
        const first = withVideo ?? data.sessions[0]
        if (first) selectSessionRef.current(first)
      })
      .catch(console.error)
      .finally(() => setSessionsLoading(false))
  }, [
    currentSkuCode,
    setCurrentSession,
    setSavedClips,
    setSessions,
    setSessionsLoading,
    clearUndoState,
    setVideoInfo,
  ])

  useEffect(() => {
    const skuParam = searchParams.get('sku')
    if (skuParam && !planLoading) setCurrentSkuCode(skuParam.toUpperCase())
  }, [searchParams, planLoading, setCurrentSkuCode])

  const handleSelectSku = useCallback((code: string) => {
    clearUndoState()
    setCurrentSkuCode(code)
    setExpandedSkuCode(code)
    setCurrentLead(null)
    setVideoInfo(null)
    setSessionLeads([])
    clearClipResults()
    setMode('browse')
  }, [clearUndoState, setCurrentSkuCode, setExpandedSkuCode, setCurrentLead, setVideoInfo, setMode])

  const handleToggleExpand = useCallback((code: string) => {
    setExpandedSkuCode(expandedSkuCode === code ? '' : code)
  }, [expandedSkuCode, setExpandedSkuCode])

  const handleSelectSessionFromTopBar = useCallback((session: SessionGroup) => {
    selectSession(session)
  }, [selectSession])

  const handleTimelineSeek = useCallback((sec: number) => {
    setAnchorSec(sec)
    const coarseSpan = Math.max(FOCUS_MIN_SPAN_SEC, rangeSpan(coarseRange) || COARSE_SPAN_SEC)
    const focusSpan = Math.max(FOCUS_MIN_SPAN_SEC, rangeSpan(focusRange) || FOCUS_DEFAULT_SPAN_SEC)

    const nextCoarse = makeCenteredRange(sec, coarseSpan, videoDuration)
    const nextFocusSeed = makeCenteredRange(sec, focusSpan, videoDuration)
    const nextFocus = clampFocusIntoCoarse(nextFocusSeed, nextCoarse, videoDuration, FOCUS_MIN_SPAN_SEC)

    setCoarseRange(nextCoarse)
    setFocusRange(nextFocus)

    if (videoPath) {
      extendRange(videoPath, videoId, 'L2', nextCoarse[0], nextCoarse[1], 10)
      loadL3(videoPath, rangeCenter(nextFocus), videoId)
    }
  }, [
    coarseRange,
    extendRange,
    focusRange,
    loadL3,
    setAnchorSec,
    videoDuration,
    videoId,
    videoPath,
  ])

  const handleCoarseRangeChange = useCallback((range: TimeRange) => {
    const nextCoarse = clampRange(range, videoDuration, FOCUS_MIN_SPAN_SEC)
    setCoarseRange(nextCoarse)
    setFocusRange(prev => clampFocusIntoCoarse(prev, nextCoarse, videoDuration, FOCUS_MIN_SPAN_SEC))
    if (videoPath) extendRange(videoPath, videoId, 'L2', nextCoarse[0], nextCoarse[1], 10)
  }, [videoDuration, videoPath, videoId, extendRange])

  const handleFocusRangeChange = useCallback((range: TimeRange) => {
    const nextFocus = clampFocusIntoCoarse(range, coarseRange, videoDuration, FOCUS_MIN_SPAN_SEC)
    setFocusRange(nextFocus)
    if (!videoPath) return
    extendRange(videoPath, videoId, 'L2', nextFocus[0], nextFocus[1], 10)
    loadL3(videoPath, rangeCenter(nextFocus), videoId)
  }, [coarseRange, videoDuration, videoPath, videoId, extendRange, loadL3])

  const handleVideoInfoUpdate = useCallback((nextVideo: VideoRegistry) => {
    setVideoInfo(nextVideo)
    setAllVideos(prev => prev.map(v => (v.id === nextVideo.id ? nextVideo : v)))
    if (!currentSession) return
    setSessions(sessions.map(s => (
      s.date === currentSession.date ? { ...s, video: nextVideo } : s
    )))
  }, [currentSession, sessions, setSessions, setVideoInfo])

  const handleRegisterVideo = useCallback(async () => {
    if (!regDate || !regPath) return
    try {
      const v = await registerVideo({
        session_date: regDate,
        session_label: regLabel,
        raw_path: regPath,
      })
      setAllVideos(prev => [v, ...prev])
      setRegDate('')
      setRegPath('')
      setRegLabel('')
    } catch (err) {
      alert(`登记失败: ${err}`)
    }
  }, [regDate, regPath, regLabel])

  // Enter 保存: AnnotationBar 通过 saveRef 暴露 handleSave
  const annotationSaveRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Space 键优先级最高：除 INPUT/TEXTAREA 外一律强制走播放控制
      // 这样即使焦点在 AnnotationBar 的 <Button> 上也不会误触按钮
      if (e.key === ' ' || e.code === 'Space') {
        if (e.target instanceof HTMLElement) {
          const tag = e.target.tagName
          if (tag === 'INPUT' || tag === 'TEXTAREA') return
        }
        if (!videoPath) return
        e.preventDefault()
        const vc = videoControlRef.current
        if (!vc) return
        if (isPlaying) {
          vc.pause()
        } else if (e.shiftKey) {
          vc.play(playbackSec)
        } else {
          vc.play(anchorSec)
        }
        return
      }

      if (isEditableTarget(e.target)) return

      // Ctrl+Z = 编辑栈 undo；Ctrl+Shift+Z = 编辑栈 redo；Alt+Z = 视窗栈 undo
      if (e.key === 'z' || e.key === 'Z') {
        if (e.altKey && !e.ctrlKey && !e.metaKey) {
          // Alt+Z: viewport undo
          e.preventDefault()
          const prev = viewportStack.undo()
          if (prev) setFocusRange(prev)
          return
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
          // Ctrl+Shift+Z: edit redo — 恢复到撤销前的新几何
          e.preventDefault()
          const entry = editStack.redo()
          if (entry) {
            void handleUpdateCapsuleGeometry(entry.capsuleId, entry.after)
          }
          return
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
          // Ctrl+Z: edit undo — 恢复胶囊旧几何，不跳视窗
          e.preventDefault()
          const entry = editStack.undo()
          if (entry) {
            void handleUpdateCapsuleGeometry(entry.capsuleId, entry.before)
          }
          return
        }
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!activeCapsule) return
        e.preventDefault()
        void handleDeleteActiveCapsule()
        return
      }

      if (e.key === 'n' || e.key === 'N') {
        if (!videoPath) return
        e.preventDefault()
        void createDefaultCapsuleAt(anchorSec)
        return
      }

      // Enter = 保存当前胶囊（通过 AnnotationBar 的 saveRef）
      if (e.key === 'Enter') {
        if (mode === 'annotate' && annotationSaveRef.current) {
          e.preventDefault()
          void annotationSaveRef.current()
        }
        return
      }

      // Alt+Down/Up = 切换 SKU
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        if (planItems.length === 0) return
        e.preventDefault()
        const currentIdx = planItems.findIndex(item => item.sku_code === currentSkuCode)
        let nextIdx: number
        if (e.key === 'ArrowDown') {
          nextIdx = currentIdx < planItems.length - 1 ? currentIdx + 1 : 0
        } else {
          nextIdx = currentIdx > 0 ? currentIdx - 1 : planItems.length - 1
        }
        handleSelectSku(planItems[nextIdx].sku_code)
        return
      }

      // [ = 设胶囊起点到白针位置；] = 设胶囊终点到白针位置
      if (e.key === '[' || e.key === ']') {
        if (!activeCapsule) return
        e.preventDefault()
        const patch = e.key === '['
          ? { start_sec: Math.min(anchorSec, activeCapsule.end_sec - 0.5) }
          : { end_sec: Math.max(anchorSec, activeCapsule.start_sec + 0.5) }
        void handleUpdateWithUndo(activeCapsule.id, patch)
        return
      }

      // F = 沉浸模式（隐藏 SessionTopBar + 视频管理区）
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        setImmersive(v => !v)
        return
      }

      // M = 切换 Minimap 展开/折叠
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        setMinimapOpen(v => !v)
        return
      }

      if (e.key !== 'Tab') return
      const switched = cycleOverlapAtAnchor(e.shiftKey)
      if (!switched) return
      e.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    activeCapsule,
    anchorSec,
    createDefaultCapsuleAt,
    currentSkuCode,
    cycleOverlapAtAnchor,
    handleDeleteActiveCapsule,
    handleSelectSku,
    handleUpdateCapsuleGeometry,
    handleUpdateWithUndo,
    editStack,
    viewportStack,
    isPlaying,
    mode,
    planItems,
    playbackSec,
    videoPath,
  ])

  return (
    <div className="flex h-full">
      <SkuPanel
        planItems={planItems}
        planLoading={planLoading}
        skuImages={skuImages}
        sessions={sessions}
        currentSkuCode={currentSkuCode}
        expandedSkuCode={expandedSkuCode}
        seekTimestamp={videoInfo?.proxy_status === 'done' ? anchorSec : 0}
        currentSession={currentSession}
        videoInfo={videoInfo}
        videoControlRef={videoControlRef}
        onSelectSession={handleSelectSessionFromTopBar}
        onVideoInfoUpdate={handleVideoInfoUpdate}
        onSelectSku={handleSelectSku}
        onToggleExpand={handleToggleExpand}
      />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {!immersive && (
          <SessionTopBar
            currentSession={currentSession}
            videoInfo={videoInfo}
            sessions={sessions}
            mode={mode}
            onModeChange={setMode}
            onSelectSession={handleSelectSessionFromTopBar}
          />
        )}
        {immersive && (
          <div
            className="h-6 shrink-0 flex items-center px-3 gap-2 border-b border-rv-border bg-rv-panel/60 text-[10px] text-muted-foreground cursor-pointer hover:bg-rv-elevated/30"
            onClick={() => setImmersive(false)}
            title="点击退出沉浸模式（或按 F 键）"
          >
            <span>沉浸模式</span>
            {currentSession && <span className="font-mono">{currentSession.date}</span>}
            <span className="ml-auto">F 退出</span>
          </div>
        )}

        {currentSkuCode && !immersive && (
          <div className="border-b border-rv-border shrink-0">
            <div
              className="px-4 py-1.5 flex items-center gap-2 cursor-pointer hover:bg-rv-elevated/30 transition-colors text-xs"
              onClick={() => setShowVideoManager(!showVideoManager)}
            >
              <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${showVideoManager ? 'rotate-180' : ''}`} />
              <span className="text-muted-foreground">视频管理</span>
            </div>
            {showVideoManager && (
              <div className="px-4 pb-3 space-y-3">
                <NasScanPanel onRegistered={() => fetchVideoRegistry().then(setAllVideos)} />

                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    手动登记单个视频...
                  </summary>
                  <div className="flex items-end gap-2 mt-2">
                    <div>
                      <label className="text-muted-foreground">日期</label>
                      <Input type="date" value={regDate} onChange={(e) => setRegDate(e.target.value)} className="h-8 text-sm w-36" />
                    </div>
                    <div>
                      <label className="text-muted-foreground">场次</label>
                      <Input placeholder="默认空" value={regLabel} onChange={(e) => setRegLabel(e.target.value)} className="h-8 text-sm w-24" />
                    </div>
                    <div className="flex-1">
                      <label className="text-muted-foreground">视频文件路径</label>
                      <Input placeholder="/Volumes/切片/衣甜/..." value={regPath} onChange={(e) => setRegPath(e.target.value)} className="h-8 text-sm font-mono" />
                    </div>
                    <Button size="sm" onClick={handleRegisterVideo} disabled={!regDate || !regPath}>
                      <Plus className="w-3 h-3" /> 登记
                    </Button>
                  </div>
                </details>

                {allVideos.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">已登记 ({allVideos.length})</p>
                    <div className="max-h-32 overflow-y-auto space-y-1">
                      {allVideos.map((v) => (
                        <div key={v.id} className="flex items-center gap-2 text-xs p-1.5 bg-background rounded border">
                          <span className="font-mono font-medium w-24 shrink-0">{v.session_date}</span>
                          <span className="text-muted-foreground w-12 shrink-0">{v.session_label || '-'}</span>
                          <span className="font-mono truncate flex-1 text-muted-foreground">{v.raw_path}</span>
                          <Badge variant={v.proxy_status === 'done' ? 'default' : v.proxy_status === 'generating' ? 'secondary' : 'outline'} className="text-[10px]">
                            {v.proxy_status}
                          </Badge>
                          <span className="text-muted-foreground">{formatDuration(v.duration_sec)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {!currentSkuCode ? (
            <p className="text-muted-foreground text-center py-12">
              从左侧选择一个 SKU 开始审核
            </p>
          ) : (
            <div className="p-4 space-y-4">
              {videoPath && (
                <>
                  <ProgressBar
                    videoDuration={videoDuration}
                    focusRange={focusRange}
                    playbackSec={playbackSec}
                    anchorSec={anchorSec}
                    capsules={capsules}
                    onClick={() => setMinimapOpen(v => !v)}
                  />
                  <MinimapPanel
                    open={minimapOpen}
                    onPinnedChange={setMinimapPinned}
                  >
                    <GlobalTimeline
                      videoPath={videoPath}
                      videoId={videoId}
                      videoDuration={videoDuration}
                      leadTimestamps={leadTimestamps}
                      currentCenter={anchorSec}
                      playbackSec={playbackSec}
                      zoomLevel={'1s'}
                      coarseRange={coarseRange}
                      focusRange={focusRange}
                      onSeek={handleTimelineSeek}
                      onCoarseRangeChange={handleCoarseRangeChange}
                      onFocusRangeChange={handleFocusRangeChange}
                      clipHotspots={clipResults.length > 0 ? clipResults.map(r => r.timestamp) : undefined}
                    />
                  </MinimapPanel>
                </>
              )}

              {videoPath && skuImages.length > 0 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleClipSearch}
                    disabled={clipSearching}
                    title="用商品图在视频中搜索相似画面"
                  >
                    {clipSearching ? <Loader2 className="w-3 h-3 animate-spin" /> : <ScanSearch className="w-3 h-3" />}
                    以图找图
                  </Button>
                  {clipResults.length > 0 && (
                    <Button variant="ghost" size="sm" className="text-xs h-8" onClick={() => clearClipResults()}>
                      清除 CLIP ({clipResults.length})
                    </Button>
                  )}
                  {capsulesLoading && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      加载胶囊...
                    </span>
                  )}
                  {capsuleDryrun && (
                    <Badge className="text-[11px] bg-orange-500/20 text-orange-300 border border-orange-500/40">
                      capsule_dryrun=1 · 本地模式不落库
                    </Badge>
                  )}
                  {capsuleInteractionState !== 'idle' && (
                    <Badge variant="outline" className="text-[11px]">
                      {capsuleInteractionState === 'dragging' ? '胶囊拖拽中' : '胶囊激活中'}
                    </Badge>
                  )}
                </div>
              )}

              {videoPath && (
                <MultiRowTimeline
                  anchorSec={anchorSec}
                  playbackSec={playbackSec}
                  displayRange={focusRange}
                  coarseRange={coarseRange}
                  focusRange={focusRange}
                  onFocusRangeChange={handleFocusRangeChange}
                  frames={timelineFrames}
                  sampleFrames={l2Frames}
                  loading={timelineLoading}
                  progress={timelineProgress}
                  capsules={capsules}
                  activeCapsuleId={activeCapsuleId}
                  onFrameSelect={handleFrameSelect}
                  onCreateCapsule={(range) => { void handleCreateCapsule(range) }}
                  onUpdateCapsule={(capsuleId, patch) => { void handleUpdateWithUndo(capsuleId, patch) }}
                  onActivateCapsule={handleActivateCapsule}
                  onInteractionStateChange={handleInteractionStateChange}
                  onViewportCapacityChange={setTimelineCapacity}
                  onEdgeHitCheck={autoExpand.checkEdgeHit}
                  onEdgeDragStop={autoExpand.stopExpand}
                  edgeGlowSide={autoExpand.glowSide}
                  edgeHitBoundary={autoExpand.hitBoundary}
                  edgePreExpand={autoExpand.preExpand}
                  edgeCurrentStep={autoExpand.currentStep}
                />
              )}

              {!videoPath && currentSession && (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-sm">该场次没有登记视频</p>
                  <p className="text-xs mt-1">请展开"视频管理"登记对应日期的视频文件</p>
                </div>
              )}

              {sessionsLoading && (
                <div className="flex items-center justify-center py-12 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                  <span className="text-sm">加载场次...</span>
                </div>
              )}
            </div>
          )}
        </div>

        {mode === 'annotate' && activeCapsule && (
          <AnnotationBar
            capsule={activeCapsule}
            currentSkuCode={currentSkuCode}
            saveRef={annotationSaveRef}
            onPatch={handlePatchActiveCapsule}
            onDelete={handleDeleteActiveCapsule}
            onClose={() => setMode('browse')}
          />
        )}

        {savedClips.length > 0 && (
          <div className="border-t border-rv-border p-3 shrink-0">
            <div className="text-xs font-semibold text-muted-foreground mb-2">
              已保存片段 ({savedClips.length})
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {savedClips.map((clip) => (
                <SavedClipCard key={clip.id} clip={clip} />
              ))}
            </div>
          </div>
        )}
      </div>

      {uiHint && (
        <div
          className={`fixed right-4 z-[120] rounded border bg-black/80 px-3 py-2 text-xs shadow-lg ${
            uiHint.variant === 'warning'
              ? 'border-red-400/40 text-red-200'
              : 'border-emerald-400/40 text-emerald-200'
          }`}
          style={{ bottom: undoDelete ? 86 : 16 }}
        >
          {uiHint.text}
        </div>
      )}

      {undoDelete && (
        <div className="fixed right-4 bottom-4 z-[121] rounded border border-yellow-500/50 bg-black/85 px-3 py-2 shadow-lg">
          <div className="text-xs text-yellow-100">
            已删除 capsule #{undoDelete.item.id}
          </div>
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => { void handleUndoDelete() }}>
              撤销（5s）
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function SavedClipCard({ clip }: { clip: VerifiedClip }) {
  return (
    <div className="shrink-0 w-36 rounded border bg-card text-xs overflow-hidden">
      {clip.thumbnail && (
        <img src={`/data/${clip.thumbnail}`} className="w-full aspect-[9/16] object-cover" loading="lazy" />
      )}
      <div className="p-2 space-y-1">
        <div className="flex items-center gap-1">
          <span className="font-mono">
            {formatSec(clip.start_sec)} - {formatSec(clip.end_sec)}
          </span>
          <span className="text-muted-foreground">({formatDuration(clip.end_sec - clip.start_sec)})</span>
        </div>
        <div className="flex items-center gap-0.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <Star
              key={n}
              className={`w-3 h-3 ${n <= clip.rating ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'}`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
