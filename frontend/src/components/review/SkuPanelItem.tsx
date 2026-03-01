import { useRef, useState, useEffect, useCallback } from 'react'
import {
  ChevronRight, ChevronUp, Play, Calendar, Video, AlertCircle, Loader2,
} from 'lucide-react'
import { ClickableImage } from '@/components/ui/image-preview'
import { ImageOff, CheckCircle2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  getVideoStreamUrl,
  generateProxy,
  fetchVideoRegistryById,
  fetchProxyProgress,
  auditProxyHealth,
} from '@/api/client'
import type { ProxyProgress } from '@/api/client'
import { useReviewStore } from '@/stores/reviewStore'
import type { EnrichedPlanItem, SkuImage, SessionGroup, VideoControl, VideoRegistry } from '@/types'
import { formatDuration } from '@/lib/format'

type PreviewState = 'idle' | 'loading' | 'playable' | 'error' | 'generating_proxy'
type SourceType = 'raw' | 'proxy' | null
type ProxyToolLevel = 'ok' | 'warn' | 'error'

interface Props {
  item: EnrichedPlanItem
  isSelected: boolean
  isExpanded: boolean
  skuImages: SkuImage[]
  sessions: SessionGroup[]
  seekTimestamp: number
  currentSession: SessionGroup | null
  videoInfo: VideoRegistry | null
  videoControlRef?: React.MutableRefObject<VideoControl | null>
  onSelectSession: (session: SessionGroup) => void
  onVideoInfoUpdate: (video: VideoRegistry) => void
  onSelect: (code: string) => void
  onToggleExpand: (code: string) => void
}

export function SkuPanelItem({
  item, isSelected, isExpanded, skuImages, sessions, seekTimestamp,
  currentSession, videoInfo, videoControlRef, onSelectSession, onVideoInfoUpdate,
  onSelect, onToggleExpand,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const loadTimeoutRef = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [hasFrame, setHasFrame] = useState(false) // 是否已解码出至少一帧
  const [sourceType, setSourceType] = useState<SourceType>(null)
  const [sourcePath, setSourcePath] = useState('')
  const [previewState, setPreviewState] = useState<PreviewState>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [proxyToolBusy, setProxyToolBusy] = useState<'' | 'audit' | 'fix'>('')
  const [proxyToolNote, setProxyToolNote] = useState<{ level: ProxyToolLevel; text: string } | null>(null)
  const [proxyProgress, setProxyProgress] = useState<ProxyProgress | null>(null)
  const progressTimerRef = useRef<number | null>(null)
  const canPreciseSeek = sourceType === 'proxy'

  const totalRecordings = sessions.length
  const totalVerified = sessions.reduce((s, g) => s + g.verified_count, 0)
  const totalDuration = sessions.reduce((s, g) => s + (g.video?.duration_sec ?? 0), 0)
  const mainImage = skuImages.find(i => i.image_type === 'main') ?? skuImages[0]

  const clearLoadTimeout = useCallback(() => {
    if (loadTimeoutRef.current !== null) {
      window.clearTimeout(loadTimeoutRef.current)
      loadTimeoutRef.current = null
    }
  }, [])

  const clearProgressPolling = useCallback(() => {
    if (progressTimerRef.current !== null) {
      window.clearInterval(progressTimerRef.current)
      progressTimerRef.current = null
    }
  }, [])

  const startProgressPolling = useCallback((videoId: number) => {
    clearProgressPolling()
    const poll = async () => {
      try {
        const p = await fetchProxyProgress(videoId)
        setProxyProgress(p)
        // 轮询驱动终态: done → 刷新视频源; failed → 显示错误
        if (p.phase === 'done') {
          clearProgressPolling()
          setProxyToolBusy('')
          setPreviewState('loading')
          try {
            const latest = await fetchVideoRegistryById(videoId)
            onVideoInfoUpdate(latest)
            if (latest.proxy_status === 'done' && latest.proxy_path) {
              setSourceType('proxy')
              setSourcePath(latest.proxy_path)
              setProxyToolNote({ level: 'ok', text: '修复完成，代理已就绪' })
            }
          } catch { /* 刷新失败不致命 */ }
          setTimeout(() => setProxyProgress(null), 3000)
        } else if (p.phase === 'failed') {
          clearProgressPolling()
          setProxyToolBusy('')
          setPreviewState('error')
          setErrorMessage(`修复代理失败: ${p.message || '未知原因'}`)
        }
      } catch {
        // 网络错误 → 优雅降级，继续轮询
        setProxyProgress({ phase: 'generating', percent: -1, message: '修复中（无进度）', updated_at: 0 })
      }
    }
    poll()
    progressTimerRef.current = window.setInterval(poll, 1500)
  }, [clearProgressPolling, onVideoInfoUpdate])

  useEffect(() => {
    return () => {
      clearLoadTimeout()
      clearProgressPolling()
    }
  }, [clearLoadTimeout, clearProgressPolling])

  // 暴露视频控制接口给 ReviewPage（通过 ref）
  const setPlaybackSec = useReviewStore(s => s.setPlaybackSec)
  const setIsPlayingStore = useReviewStore(s => s.setIsPlaying)

  useEffect(() => {
    if (!videoControlRef) return
    videoControlRef.current = {
      play(fromSec?: number) {
        const vid = videoRef.current
        if (!vid) return
        if (fromSec != null) vid.currentTime = fromSec
        vid.play().catch(() => {})
      },
      pause() {
        videoRef.current?.pause()
      },
      seek(sec: number) {
        const vid = videoRef.current
        if (!vid) return
        vid.currentTime = sec
      },
      getCurrentTime() {
        return videoRef.current?.currentTime ?? 0
      },
    }
    return () => { if (videoControlRef) videoControlRef.current = null }
  }, [videoControlRef, sourcePath])

  useEffect(() => {
    if (!isExpanded) return
    setPlaying(false)
    setErrorMessage('')
    setProxyToolNote(null)

    // proxy 优先（.mp4 容器音画同步好），raw .ts 作为 fallback
    if (videoInfo?.proxy_status === 'done' && videoInfo.proxy_path) {
      setSourceType('proxy')
      setSourcePath(videoInfo.proxy_path)
      setPreviewState('loading')
      return
    }
    if (videoInfo?.raw_path) {
      setSourceType('raw')
      setSourcePath(videoInfo.raw_path)
      setPreviewState('loading')
      return
    }

    setSourceType(null)
    setSourcePath('')
    setPreviewState('idle')
  }, [videoInfo, isExpanded])

  useEffect(() => {
    const vid = videoRef.current
    if (!vid || !sourcePath) return
    setPlaying(false)
    setHasFrame(false)
    vid.load()
  }, [sourcePath])

  useEffect(() => {
    const vid = videoRef.current
    if (vid && seekTimestamp > 0 && isExpanded && canPreciseSeek) {
      try {
        vid.currentTime = seekTimestamp
      } catch {
        // ignore seek errors before metadata ready
      }
    }
  }, [seekTimestamp, isExpanded, sourcePath, canPreciseSeek])

  const switchToProxy = useCallback(() => {
    // 必须 proxy_status=done 才切换，避免加载已知失败/半截的代理
    if (!videoInfo?.proxy_path || videoInfo.proxy_status !== 'done') return false
    setSourceType('proxy')
    setSourcePath(videoInfo.proxy_path)
    setPreviewState('loading')
    setErrorMessage('')
    return true
  }, [videoInfo])

  useEffect(() => {
    if (previewState !== 'loading') {
      clearLoadTimeout()
      return
    }
    clearLoadTimeout()
    loadTimeoutRef.current = window.setTimeout(() => {
      // 视频已有帧输出（onTimeUpdate 至少触发过一次），不是真超时
      if (hasFrame) return
      if (sourceType === 'raw' && switchToProxy()) return
      const ext = sourcePath.split('.').pop()?.toLowerCase() || ''
      if (ext === 'ts' || ext === 'mkv' || ext === 'flv') {
        setErrorMessage('原始视频格式兼容性较差，建议点击"修复代理"后预览')
      } else {
        setErrorMessage('视频加载超时，请重试或点击"修复代理"')
      }
      setPreviewState('error')
    }, 8000)
    return () => clearLoadTimeout()
  }, [clearLoadTimeout, hasFrame, previewState, sourcePath, sourceType, switchToProxy])

  const onVideoError = useCallback(() => {
    setPlaying(false)
    setHasFrame(false)
    if (sourceType === 'raw' && switchToProxy()) return
    setPreviewState('error')
    setErrorMessage('当前视频源不可播放，可尝试"修复代理"后重试')
  }, [sourceType, switchToProxy])

  const togglePlay = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const vid = videoRef.current
    if (!vid || previewState === 'generating_proxy') return
    // 媒体仍在加载中时不强行 play，避免把 AbortError 误判成致命播放失败
    if (previewState === 'loading') return
    if (vid.paused) {
      vid.play()
        .then(() => setPlaying(true))
        .catch((err: unknown) => {
          const errName = err instanceof DOMException ? err.name : ''
          if (errName === 'AbortError') return
          if (sourceType === 'raw' && switchToProxy()) return
          setPlaying(false)
          setPreviewState('error')
          if (errName === 'NotSupportedError') {
            setErrorMessage('当前浏览器不支持该视频格式，请点击"修复代理"后预览')
          } else {
            setErrorMessage('播放启动失败，请检查视频源')
          }
        })
    } else {
      vid.pause()
      setPlaying(false)
    }
  }, [previewState, sourceType, switchToProxy])

  const handleFixProxy = useCallback(async () => {
    if (!videoInfo?.id) return
    setProxyToolBusy('fix')
    setProxyToolNote(null)
    setProxyProgress(null)
    setErrorMessage('')
    setPlaying(false)
    setPreviewState('generating_proxy')

    try {
      // POST 立即返回 accepted，不等转码完成
      await generateProxy(videoInfo.id)
    } catch (err) {
      // 只有 POST 本身失败才报错（如 409 重复/404 不存在）
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('409')) {
        // 任务已在运行，直接开始轮询
      } else {
        setPreviewState('error')
        setErrorMessage(`启动修复失败: ${msg}`)
        setProxyToolBusy('')
        return
      }
    }
    // 纯轮询驱动：完成/失败由轮询回调处理
    startProgressPolling(videoInfo.id)
  }, [videoInfo, startProgressPolling])

  const handleAuditProxy = useCallback(async () => {
    if (!videoInfo?.id) return
    setProxyToolBusy('audit')
    setProxyToolNote(null)
    try {
      const res = await auditProxyHealth([videoInfo.id], 0)
      const bad = res.bad.find(item => item.video_id === videoInfo.id)
      if (!bad) {
        setProxyToolNote({ level: 'ok', text: '检测通过：未发现代理音画异常' })
      } else {
        const reasons = bad.reasons?.join(', ') || 'unknown'
        setProxyToolNote({
          level: 'warn',
          text: `检测异常：${reasons}（v=${bad.video_duration?.toFixed(1) ?? '-'}s, a=${bad.audio_duration?.toFixed(1) ?? '-'}s）`,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('404') && msg.includes('Not Found')) {
        setProxyToolNote({ level: 'error', text: '检测失败：后端缺少新接口（/proxy/audit）。请重启后端服务后重试。' })
      } else {
        setProxyToolNote({ level: 'error', text: `检测失败: ${msg}` })
      }
    } finally {
      setProxyToolBusy('')
    }
  }, [videoInfo?.id])


  if (isExpanded) {
    return (
      <div className="flex flex-col h-full">
        <div
          className="flex items-center gap-2 p-2 cursor-pointer border-b border-rv-border"
          onClick={() => onToggleExpand(item.sku_code)}
        >
          <div className="w-8 h-14 shrink-0 rounded overflow-hidden bg-muted aspect-[9/16]">
            {item.image_path ? (
              <ClickableImage
                src={`/data/${item.image_path}`}
                alt={item.sku_code}
                className="w-full h-full object-cover"
                fallback={<div className="w-full h-full flex items-center justify-center"><ImageOff className="w-3 h-3 text-muted-foreground" /></div>}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center"><ImageOff className="w-3 h-3 text-muted-foreground" /></div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <span className="font-mono text-[13px] font-medium">{item.sku_code}</span>
            </div>
            <p className="text-[11px] text-muted-foreground truncate">{item.product_name || '(未命名)'}</p>
            <span className="text-[12px] text-rv-accent font-medium">录制 {item.lead_count} 条</span>
          </div>
          <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
        </div>

        {currentSession && (
          <div className="flex items-center gap-2 flex-wrap px-3 py-2 border-b border-rv-border text-xs">
            <Badge className="bg-rv-accent text-black text-[11px] font-mono gap-1 shrink-0 py-0">
              <Calendar className="w-3 h-3" />
              {currentSession.date}
            </Badge>
            {currentSession.leads[0]?.session_label && (
              <span className="text-foreground">{currentSession.leads[0].session_label}</span>
            )}
            {videoInfo ? (
              <>
                <Video className="w-3 h-3 text-green-500" />
                <span className="text-muted-foreground">{formatDuration(videoInfo.duration_sec)}</span>
                <span className="text-muted-foreground">· 当前源 {sourceType ?? '-'}</span>
              </>
            ) : (
              <span className="text-orange-500 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> 无视频
              </span>
            )}
            {sessions.length > 1 && (
              <select
                className="text-[11px] bg-transparent border border-rv-border rounded px-1 py-0.5 text-muted-foreground"
                value={currentSession.date}
                onChange={(e) => {
                  e.stopPropagation()
                  const target = sessions.find(s => s.date === e.target.value)
                  if (target) onSelectSession(target)
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {sessions.map(s => (
                  <option key={`${s.date}-${s.leads[0]?.session_label ?? ''}`} value={s.date}>
                    {s.date} {s.leads[0]?.session_label ?? ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        <div className="flex-1 overflow-auto px-3 py-2 space-y-2">
          <div className="flex gap-3">
            <div className="w-[60px] h-[60px] shrink-0 rounded bg-white flex items-center justify-center overflow-hidden">
              {mainImage ? (
                <ClickableImage
                  src={`/data/${mainImage.file_path}`}
                  alt={item.sku_code}
                  className="w-full h-full object-contain"
                  fallback={<ImageOff className="w-5 h-5 text-muted-foreground" />}
                />
              ) : (
                <ImageOff className="w-5 h-5 text-muted-foreground" />
              )}
            </div>
            <div className="flex-1 text-[12px] space-y-0.5">
              <div className="flex justify-between">
                <span className="text-muted-foreground">录制条数</span>
                <span className="font-mono">{totalRecordings}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">已选中</span>
                <span className="font-mono text-rv-accent">{totalVerified}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">总时长</span>
                <span className="font-mono">{formatDuration(totalDuration)}</span>
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-[11px] text-muted-foreground">竖幅预览</p>
              {videoInfo?.id && (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={handleAuditProxy}
                    disabled={previewState === 'generating_proxy' || proxyToolBusy !== ''}
                  >
                    {proxyToolBusy === 'audit' && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                    检测代理
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={handleFixProxy}
                    disabled={previewState === 'generating_proxy' || proxyToolBusy !== ''}
                  >
                    {(previewState === 'generating_proxy' || proxyToolBusy === 'fix') && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                    修复代理
                  </Button>
                </div>
              )}
            </div>

            {proxyProgress && (
              <div className="mb-1">
                <div className="flex items-center justify-between text-[10px] mb-0.5">
                  <span className={
                    proxyProgress.phase === 'failed' ? 'text-red-400'
                      : proxyProgress.phase === 'done' ? 'text-emerald-300'
                        : 'text-amber-300'
                  }>
                    {proxyProgress.phase === 'queued' ? '排队中'
                      : proxyProgress.phase === 'generating' ? (proxyProgress.percent >= 0 ? `转码中 ${proxyProgress.percent}%` : '修复中（无进度）')
                        : proxyProgress.phase === 'validating' ? '验收中'
                          : proxyProgress.phase === 'done' ? '修复完成'
                            : proxyProgress.phase === 'failed' ? '修复失败'
                              : proxyProgress.message || proxyProgress.phase}
                  </span>
                  {proxyProgress.percent >= 0 && proxyProgress.phase !== 'done' && proxyProgress.phase !== 'failed' && (
                    <span className="text-muted-foreground font-mono">{proxyProgress.percent}%</span>
                  )}
                </div>
                {proxyProgress.percent >= 0 ? (
                  <div className="h-1 bg-rv-border rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        proxyProgress.phase === 'failed' ? 'bg-red-500'
                          : proxyProgress.phase === 'done' ? 'bg-emerald-400'
                            : 'bg-amber-400'
                      }`}
                      style={{ width: `${Math.max(2, proxyProgress.percent)}%` }}
                    />
                  </div>
                ) : (
                  <div className="h-1 bg-rv-border rounded-full overflow-hidden">
                    <div className="h-full w-1/3 bg-amber-400/60 rounded-full animate-pulse" />
                  </div>
                )}
              </div>
            )}

            {proxyToolNote && (
              <div className={`mb-1 text-[11px] ${
                proxyToolNote.level === 'error'
                  ? 'text-red-400'
                  : proxyToolNote.level === 'warn'
                    ? 'text-amber-300'
                    : 'text-emerald-300'
              }`}>
                {proxyToolNote.text}
              </div>
            )}

            <div className="w-full aspect-[9/16] bg-black rounded overflow-hidden relative">
              {sourcePath ? (
                <>
                  <video
                    ref={videoRef}
                    src={getVideoStreamUrl(sourcePath)}
                    className="w-full h-full object-contain"
                    preload="metadata"
                    controls
                    playsInline
                    onLoadStart={() => setPreviewState('loading')}
                    onLoadedMetadata={() => {
                      setPreviewState('playable')
                      if (seekTimestamp > 0 && canPreciseSeek) {
                        try {
                          const vid = videoRef.current
                          if (vid) {
                            const maxSeek = Number.isFinite(vid.duration) && vid.duration > 1
                              ? Math.max(0, vid.duration - 1)
                              : seekTimestamp
                            vid.currentTime = Math.min(seekTimestamp, maxSeek)
                          }
                        } catch {
                          // ignore seek errors
                        }
                      }
                      const vid = videoRef.current
                      if (vid) {
                        vid.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
                      }
                    }}
                    onCanPlay={() => setPreviewState('playable')}
                    onLoadedData={() => {
                      setHasFrame(true)
                      setErrorMessage('')
                    }}
                    onTimeUpdate={() => {
                      if (!hasFrame) setHasFrame(true)
                      const vid = videoRef.current
                      if (vid) setPlaybackSec(vid.currentTime)
                    }}
                    onEnded={() => { setPlaying(false); setIsPlayingStore(false) }}
                    onPause={() => { setPlaying(false); setIsPlayingStore(false) }}
                    onPlay={() => { setPlaying(true); setIsPlayingStore(true) }}
                    onError={onVideoError}
                  />
                  <div
                    className="absolute inset-0 flex items-center justify-center transition-colors"
                    style={{ background: (playing && hasFrame) ? 'transparent' : 'rgba(0,0,0,0.2)' }}
                    onClick={togglePlay}
                  >
                    {previewState === 'loading' || previewState === 'generating_proxy' || (playing && !hasFrame) ? (
                      <Loader2 className="w-6 h-6 text-white animate-spin" />
                    ) : (!playing && previewState !== 'error') && (
                      <div className="w-12 h-12 rounded-full bg-black/50 flex items-center justify-center">
                        <Play className="w-6 h-6 text-white ml-0.5" />
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Play className="w-8 h-8 text-muted-foreground/40" />
                </div>
              )}

              {previewState === 'error' && (
                <div className="absolute inset-x-2 bottom-2 text-[11px] bg-black/70 text-white rounded px-2 py-1.5">
                  {errorMessage || '预览播放失败'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors ${
        isSelected
          ? 'bg-rv-elevated border border-rv-accent/50'
          : 'hover:bg-rv-elevated/50 border border-transparent'
      }`}
      onClick={() => onSelect(item.sku_code)}
    >
      <div className="w-8 h-14 shrink-0 rounded overflow-hidden bg-muted aspect-[9/16]">
        {item.image_path ? (
          <ClickableImage
            src={`/data/${item.image_path}`}
            alt={item.sku_code}
            className="w-full h-full object-cover"
            fallback={<div className="w-full h-full flex items-center justify-center"><ImageOff className="w-3 h-3 text-muted-foreground" /></div>}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center"><ImageOff className="w-3 h-3 text-muted-foreground" /></div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="font-mono text-[13px] font-medium">{item.sku_code}</span>
          {item.verified_count > 0 && <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />}
        </div>
        <p className="text-[11px] text-muted-foreground truncate">{item.product_name || '(未命名)'}</p>
        <span className="text-[12px] text-rv-accent font-medium">{item.lead_count} 线索</span>
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
    </div>
  )
}
