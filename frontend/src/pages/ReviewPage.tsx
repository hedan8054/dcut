import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useReviewStore } from '@/stores/reviewStore'
import {
  fetchTodayPlan, fetchVerified, createVerified,
  fetchVideoRegistry, registerVideo, fetchSkuImages,
  fetchSkuSessions, clipSearch, type ClipSearchResult,
} from '@/api/client'
import { SkuPanel } from '@/components/review/SkuPanel'
import { SessionTopBar } from '@/components/review/SessionTopBar'
import { GlobalTimeline } from '@/components/review/GlobalTimeline'
import { MultiRowTimeline, type ZoomLevel } from '@/components/review/MultiRowTimeline'
import { AnnotationBar } from '@/components/review/AnnotationBar'
import { NasScanPanel } from '@/components/review/NasScanPanel'
import { useMultiResFrames } from '@/hooks/use-multi-res-frames'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Star, ChevronDown, Plus, Loader2, ScanSearch,
} from 'lucide-react'
import { formatSec, formatDuration } from '@/lib/format'
import {
  clampFocusIntoCoarse,
  clampRange,
  makeCenteredRange,
  rangeCenter,
  rangeSpan,
  type TimeRange,
} from '@/lib/timeline-range'
import type { Lead, VerifiedClip, VideoRegistry, SkuImage, EnrichedPlanItem, SessionGroup } from '@/types'

const COARSE_SPAN_SEC = 20 * 60
const FOCUS_DEFAULT_SPAN_SEC = 4 * 60
const FOCUS_MIN_SPAN_SEC = 20
const ZOOM_INTERVAL_SEC: Record<ZoomLevel, number> = {
  '1s': 1,
  '10s': 10,
  '60s': 60,
  '2min': 120,
}

function parseLeadTimestamps(leads: Lead[]): number[] {
  const result: number[] = []
  for (const lead of leads) {
    try {
      const points: string[] = JSON.parse(lead.time_points_json)
      for (const pt of points) {
        const parts = pt.split(':').map(Number)
        if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
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
    currentSkuCode, setCurrentSkuCode,
    currentLead, setCurrentLead,
    savedClips, setSavedClips,
    mode, setMode,
    sessions, setSessions, sessionsLoading, setSessionsLoading,
    currentSession, setCurrentSession,
    videoInfo, setVideoInfo,
    anchorSec, setAnchorSec,
    setViewRange,
    hitTimestamp, setHitTimestamp,
    expandedSkuCode, setExpandedSkuCode,
  } = store

  const [planItems, setPlanItems] = useState<EnrichedPlanItem[]>([])
  const [planLoading, setPlanLoading] = useState(true)
  const [sessionLeads, setSessionLeads] = useState<Lead[]>([])
  const [skuImages, setSkuImages] = useState<SkuImage[]>([])
  const [clipResults, setClipResults] = useState<ClipSearchResult[]>([])
  const [clipSearching, setClipSearching] = useState(false)
  const [allVideos, setAllVideos] = useState<VideoRegistry[]>([])
  const [showVideoManager, setShowVideoManager] = useState(false)
  const [regDate, setRegDate] = useState('')
  const [regPath, setRegPath] = useState('')
  const [regLabel, setRegLabel] = useState('')
  const [selectionStart, setSelectionStart] = useState(0)
  const [selectionEnd, setSelectionEnd] = useState(0)

  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>('60s')
  const [coarseRange, setCoarseRange] = useState<TimeRange>([0, 0])
  const [focusRange, setFocusRange] = useState<TimeRange>([0, 0])
  const [, setTimelineCapacity] = useState(40)

  const videoPath = useMemo(() => {
    if (!videoInfo) return ''
    return videoInfo.proxy_path || videoInfo.raw_path
  }, [videoInfo])
  const videoId = videoInfo?.id
  const videoDuration = videoInfo?.duration_sec || 4 * 3600
  const leadTimestamps = useMemo(() => parseLeadTimestamps(sessionLeads), [sessionLeads])
  // 1s 模式只显示聚焦范围，其余模式始终显示全视频（可滚动）
  const activeRange: TimeRange = useMemo(() => {
    if (zoomLevel === '1s') return focusRange
    return [0, videoDuration]
  }, [focusRange, videoDuration, zoomLevel])

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
  const zoomInterval = ZOOM_INTERVAL_SEC[zoomLevel]
  // 1s zoom 下用 coarseRange 读 L2，让压缩袋之外的帧也可见
  const l2ReadRange: TimeRange = zoomLevel === '1s' ? coarseRange : activeRange
  const l2Frames = useMemo(
    () => getFrames('L2', l2ReadRange[0], l2ReadRange[1], zoomLevel !== '1s' ? zoomInterval : undefined),
    [getFrames, l2ReadRange, frameVersion, zoomLevel, zoomInterval],
  )
  // L3 也用 coarseRange 读取，配合渐进式加载覆盖更大范围
  const l3Frames = useMemo(
    () => getFrames('L3', coarseRange[0], coarseRange[1]),
    [getFrames, coarseRange, frameVersion],
  )

  useEffect(() => {
    setViewRange(activeRange)
  }, [activeRange, setViewRange])

  useEffect(() => {
    if (!videoPath || zoomLevel === '1s') return
    // 按当前 zoom 级别的间隔加载帧，避免 60s 视图按 10s 间隔抽帧浪费
    extendRange(videoPath, videoId, 'L2', activeRange[0], activeRange[1], zoomInterval)
  }, [activeRange, extendRange, videoId, videoPath, zoomLevel, zoomInterval])

  useEffect(() => {
    fetchTodayPlan()
      .then(ep => setPlanItems(ep?.items ?? []))
      .catch(console.error)
      .finally(() => setPlanLoading(false))
  }, [])

  useEffect(() => {
    fetchVideoRegistry().then(setAllVideos).catch(console.error)
  }, [])

  const bootstrapRanges = useCallback((anchor: number, duration: number) => {
    const coarse = makeCenteredRange(anchor, COARSE_SPAN_SEC, duration)
    const focusSeed = makeCenteredRange(anchor, FOCUS_DEFAULT_SPAN_SEC, duration)
    const focus = clampFocusIntoCoarse(focusSeed, coarse, duration, FOCUS_MIN_SPAN_SEC)
    setCoarseRange(coarse)
    setFocusRange(focus)
    setZoomLevel('60s')
    return { coarse, focus }
  }, [])

  const selectSession = useCallback((session: SessionGroup) => {
    setCurrentSession(session)
    setSessionLeads(session.leads)
    const video = session.video
    setVideoInfo(video)
    setMode('browse')
    resetFrames()

    const dur = video?.duration_sec || 4 * 3600
    const timestamps = parseLeadTimestamps(session.leads)
    const anchor = timestamps.length > 0 ? timestamps[0] : 0
    setAnchorSec(anchor)
    if (session.leads.length > 0) setCurrentLead(session.leads[0])
    const { coarse } = bootstrapRanges(anchor, dur)

    if (video) {
      const vPath = video.proxy_path || video.raw_path
      startPreload(vPath, anchor, video.id)
      // 初始 zoom 是 60s，按 60s 间隔加载
      extendRange(vPath, video.id, 'L2', coarse[0], coarse[1], ZOOM_INTERVAL_SEC['60s'])
    }
    setClipResults([])
  }, [
    bootstrapRanges,
    extendRange,
    resetFrames,
    setAnchorSec,
    setCurrentLead,
    setCurrentSession,
    setMode,
    startPreload,
    setVideoInfo,
  ])

  // 用 ref 持有 selectSession 最新引用，避免 useEffect 因其变化重复触发
  const selectSessionRef = useRef(selectSession)
  selectSessionRef.current = selectSession

  useEffect(() => {
    if (!currentSkuCode) {
      setSkuImages([])
      setSessions([])
      setCurrentSession(null)
      setVideoInfo(null)
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
    setVideoInfo,
  ])

  const [searchParams] = useSearchParams()
  useEffect(() => {
    const skuParam = searchParams.get('sku')
    if (skuParam && !planLoading) setCurrentSkuCode(skuParam.toUpperCase())
  }, [searchParams, planLoading, setCurrentSkuCode])

  const handleSelectSku = useCallback((code: string) => {
    setCurrentSkuCode(code)
    setExpandedSkuCode(code)
    setCurrentLead(null)
    setVideoInfo(null)
    setSessionLeads([])
    setClipResults([])
    setMode('browse')
    setSelectionStart(0)
    setSelectionEnd(0)
  }, [setCurrentSkuCode, setExpandedSkuCode, setCurrentLead, setVideoInfo, setMode])

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
      extendRange(videoPath, videoId, 'L2', nextCoarse[0], nextCoarse[1], zoomInterval)
      if (zoomLevel === '1s') {
        extendRange(videoPath, videoId, 'L2', nextFocus[0], nextFocus[1])
        loadL3(videoPath, rangeCenter(nextFocus), videoId)
      }
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
    zoomLevel,
    zoomInterval,
  ])

  const handleCoarseRangeChange = useCallback((range: TimeRange) => {
    const nextCoarse = clampRange(range, videoDuration, FOCUS_MIN_SPAN_SEC)
    setCoarseRange(nextCoarse)
    setFocusRange(prev => clampFocusIntoCoarse(prev, nextCoarse, videoDuration, FOCUS_MIN_SPAN_SEC))
    if (videoPath) extendRange(videoPath, videoId, 'L2', nextCoarse[0], nextCoarse[1], zoomInterval)
  }, [videoDuration, videoPath, videoId, extendRange, zoomInterval])

  const handleFocusRangeChange = useCallback((range: TimeRange) => {
    const nextFocus = clampFocusIntoCoarse(range, coarseRange, videoDuration, FOCUS_MIN_SPAN_SEC)
    setFocusRange(nextFocus)
    if (!videoPath) return
    extendRange(videoPath, videoId, 'L2', nextFocus[0], nextFocus[1], zoomInterval)
    if (zoomLevel === '1s') loadL3(videoPath, rangeCenter(nextFocus), videoId)
  }, [coarseRange, videoDuration, videoPath, videoId, extendRange, loadL3, zoomLevel, zoomInterval])

  const handleZoomChange = useCallback((zoom: ZoomLevel) => {
    setZoomLevel(zoom)
    if (!videoPath) return
    // 切换 zoom 时按新的间隔补帧
    const newInterval = ZOOM_INTERVAL_SEC[zoom]
    extendRange(videoPath, videoId, 'L2', activeRange[0], activeRange[1], newInterval)
    if (zoom === '1s') {
      loadL3(videoPath, rangeCenter(focusRange), videoId)
    }
  }, [videoPath, videoId, extendRange, loadL3, focusRange, activeRange])

  const handleRequestL3 = useCallback((centerSec: number) => {
    if (videoPath) loadL3(videoPath, centerSec, videoId)
  }, [videoPath, videoId, loadL3])

  const handleClipSearch = useCallback(async () => {
    if (!videoInfo || skuImages.length === 0) return
    setClipSearching(true)
    setClipResults([])
    try {
      const res = await clipSearch({
        sku_image_path: skuImages[0].file_path,
        video_path: videoInfo.proxy_path || videoInfo.raw_path,
        video_duration: videoInfo.duration_sec || 4 * 3600,
        sample_interval: 30,
        top_k: 12,
      })
      setClipResults(res.results)
    } catch (err) {
      console.error('CLIP 搜索失败:', err)
      alert(`CLIP 搜索失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setClipSearching(false)
    }
  }, [videoInfo, skuImages])

  const handleSelectionRangeChange = useCallback((range: [number, number]) => {
    setSelectionStart(range[0])
    setSelectionEnd(range[1])
  }, [])

  /** 点帧 → 切 1s zoom + L3 加载 + 进入标注模式 */
  const handleFrameSelect = useCallback((timestamp: number) => {
    setHitTimestamp(timestamp)
    setSelectionStart(Math.max(0, timestamp - 5))
    setSelectionEnd(Math.min(videoDuration, timestamp + 5))
    setMode('annotate')
    // 自动切到 1s 精查 + 触发 L3 加载
    if (zoomLevel !== '1s') setZoomLevel('1s')
    if (videoPath) loadL3(videoPath, timestamp, videoId)
  }, [setHitTimestamp, setMode, videoDuration, zoomLevel, videoPath, videoId, loadL3])

  const handleVideoInfoUpdate = useCallback((nextVideo: VideoRegistry) => {
    setVideoInfo(nextVideo)
    setAllVideos(prev => prev.map(v => (v.id === nextVideo.id ? nextVideo : v)))
    if (!currentSession) return
    setSessions(sessions.map(s => (
      s.date === currentSession.date ? { ...s, video: nextVideo } : s
    )))
  }, [currentSession, sessions, setSessions, setVideoInfo])

  const handleSave = useCallback(async (data: {
    start_sec: number
    end_sec: number
    rating: number
    tags: string[]
  }) => {
    if (!currentSkuCode || !currentLead || !videoInfo) return

    await createVerified({
      sku_code: currentSkuCode,
      lead_id: currentLead.id,
      video_path: videoInfo.proxy_path || videoInfo.raw_path,
      raw_video_path: videoInfo.raw_path,
      start_sec: data.start_sec,
      end_sec: data.end_sec,
      rating: data.rating,
      tags: data.tags,
      lead_time_original: currentLead.time_points_json,
      offset_sec: data.start_sec - anchorSec,
    })

    const clips = await fetchVerified(currentSkuCode)
    setSavedClips(clips)

    const currentIdx = sessionLeads.findIndex(l => l.id === currentLead.id)
    if (currentIdx >= 0 && currentIdx < sessionLeads.length - 1) {
      const nextLead = sessionLeads[currentIdx + 1]
      setCurrentLead(nextLead)
      const timestamps = parseLeadTimestamps([nextLead])
      if (timestamps.length > 0) {
        const nextAnchor = timestamps[0]
        setAnchorSec(nextAnchor)
        const nextCoarse = makeCenteredRange(nextAnchor, COARSE_SPAN_SEC, videoDuration)
        const nextFocus = clampFocusIntoCoarse(
          makeCenteredRange(nextAnchor, FOCUS_DEFAULT_SPAN_SEC, videoDuration),
          nextCoarse,
          videoDuration,
          FOCUS_MIN_SPAN_SEC,
        )
        setCoarseRange(nextCoarse)
        setFocusRange(nextFocus)
        setZoomLevel('60s')
        if (videoPath) extendRange(videoPath, videoId, 'L2', nextCoarse[0], nextCoarse[1], ZOOM_INTERVAL_SEC['60s'])
      }
    }
    setMode('browse')
    setSelectionStart(0)
    setSelectionEnd(0)
  }, [
    currentSkuCode,
    currentLead,
    videoInfo,
    anchorSec,
    setSavedClips,
    sessionLeads,
    setCurrentLead,
    setAnchorSec,
    setMode,
    videoDuration,
    videoPath,
    videoId,
    extendRange,
  ])

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

  return (
    <div className="flex h-full">
      <SkuPanel
        planItems={planItems}
        planLoading={planLoading}
        skuImages={skuImages}
        sessions={sessions}
        currentSkuCode={currentSkuCode}
        expandedSkuCode={expandedSkuCode}
        seekTimestamp={
          mode === 'annotate'
            ? hitTimestamp
            : (videoInfo?.proxy_status === 'done' ? anchorSec : 0)
        }
        currentSession={currentSession}
        videoInfo={videoInfo}
        onSelectSession={handleSelectSessionFromTopBar}
        onVideoInfoUpdate={handleVideoInfoUpdate}
        onSelectSku={handleSelectSku}
        onToggleExpand={handleToggleExpand}
      />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <SessionTopBar
          currentSession={currentSession}
          videoInfo={videoInfo}
          sessions={sessions}
          mode={mode}
          onModeChange={setMode}
          onSelectSession={handleSelectSessionFromTopBar}
        />

        {currentSkuCode && (
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
                <GlobalTimeline
                  videoPath={videoPath}
                  videoId={videoId}
                  videoDuration={videoDuration}
                  leadTimestamps={leadTimestamps}
                  currentCenter={anchorSec}
                  zoomLevel={zoomLevel}
                  coarseRange={coarseRange}
                  focusRange={focusRange}
                  onSeek={handleTimelineSeek}
                  onCoarseRangeChange={handleCoarseRangeChange}
                  onFocusRangeChange={handleFocusRangeChange}
                  clipHotspots={clipResults.length > 0 ? clipResults.map(r => r.timestamp) : undefined}
                />
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
                    <Button variant="ghost" size="sm" className="text-xs h-8" onClick={() => setClipResults([])}>
                      清除 CLIP ({clipResults.length})
                    </Button>
                  )}
                </div>
              )}

              {videoPath && (
                <MultiRowTimeline
                  anchorSec={anchorSec}
                  videoDuration={videoDuration}
                  zoomLevel={zoomLevel}
                  onZoomChange={handleZoomChange}
                  displayRange={activeRange}
                  coarseRange={coarseRange}
                  focusRange={focusRange}
                  onFocusRangeChange={handleFocusRangeChange}
                  onFrameSelect={handleFrameSelect}
                  l2Frames={l2Frames}
                  l3Frames={l3Frames}
                  l2Loading={frameLoading.L2}
                  l3Loading={frameLoading.L3}
                  l2Progress={frameProgress.L2}
                  l3Progress={frameProgress.L3}
                  onRequestL3={handleRequestL3}
                  onViewportCapacityChange={setTimelineCapacity}
                  clipTimestamps={clipResults.length > 0 ? clipResults.map(r => r.timestamp) : undefined}
                  selectionRange={mode === 'annotate' ? [selectionStart, selectionEnd] : null}
                  playheadSec={mode === 'annotate' ? hitTimestamp : null}
                  onSelectionRangeChange={handleSelectionRangeChange}
                  hitTimestamp={hitTimestamp}
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

        {mode === 'annotate' && videoPath && (
          <AnnotationBar
            hitTimestamp={hitTimestamp}
            startSec={selectionStart}
            endSec={selectionEnd}
            onStartChange={setSelectionStart}
            onEndChange={setSelectionEnd}
            onSave={handleSave}
            onCancel={() => {
              setMode('browse')
              setSelectionStart(0)
              setSelectionEnd(0)
            }}
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
