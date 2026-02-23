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
  batchGenerateProxy,
  fetchVideoRegistryById,
} from '@/api/client'
import type { EnrichedPlanItem, SkuImage, SessionGroup, VideoRegistry } from '@/types'
import { formatDuration } from '@/lib/format'

type PreviewState = 'idle' | 'loading' | 'playable' | 'error' | 'generating_proxy'
type SourceType = 'raw' | 'proxy' | null

interface Props {
  item: EnrichedPlanItem
  isSelected: boolean
  isExpanded: boolean
  skuImages: SkuImage[]
  sessions: SessionGroup[]
  seekTimestamp: number
  currentSession: SessionGroup | null
  videoInfo: VideoRegistry | null
  onSelectSession: (session: SessionGroup) => void
  onVideoInfoUpdate: (video: VideoRegistry) => void
  onSelect: (code: string) => void
  onToggleExpand: (code: string) => void
}

export function SkuPanelItem({
  item, isSelected, isExpanded, skuImages, sessions, seekTimestamp,
  currentSession, videoInfo, onSelectSession, onVideoInfoUpdate,
  onSelect, onToggleExpand,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const pollTimerRef = useRef<number | null>(null)
  const loadTimeoutRef = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [hasFrame, setHasFrame] = useState(false) // 是否已解码出至少一帧
  const [sourceType, setSourceType] = useState<SourceType>(null)
  const [sourcePath, setSourcePath] = useState('')
  const [previewState, setPreviewState] = useState<PreviewState>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const canPreciseSeek = sourceType === 'proxy'

  const totalRecordings = sessions.length
  const totalVerified = sessions.reduce((s, g) => s + g.verified_count, 0)
  const totalDuration = sessions.reduce((s, g) => s + (g.video?.duration_sec ?? 0), 0)
  const mainImage = skuImages.find(i => i.image_type === 'main') ?? skuImages[0]

  const clearPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const clearLoadTimeout = useCallback(() => {
    if (loadTimeoutRef.current !== null) {
      window.clearTimeout(loadTimeoutRef.current)
      loadTimeoutRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      clearPolling()
      clearLoadTimeout()
    }
  }, [clearLoadTimeout, clearPolling])

  useEffect(() => {
    if (!isExpanded) return
    setPlaying(false)
    setErrorMessage('')

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
      if (sourceType === 'raw' && switchToProxy()) return
      const ext = sourcePath.split('.').pop()?.toLowerCase() || ''
      if (ext === 'ts' || ext === 'mkv' || ext === 'flv') {
        setErrorMessage('原始视频格式兼容性较差，建议点击“生成代理”后预览')
      } else {
        setErrorMessage('视频加载超时，请重试或生成代理')
      }
      setPreviewState('error')
    }, 8000)
    return () => clearLoadTimeout()
  }, [clearLoadTimeout, previewState, sourcePath, sourceType, switchToProxy])

  const onVideoError = useCallback(() => {
    setPlaying(false)
    setHasFrame(false)
    if (sourceType === 'raw' && switchToProxy()) return
    setPreviewState('error')
    setErrorMessage('当前视频源不可播放，可尝试生成代理后重试')
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
            setErrorMessage('当前浏览器不支持该视频格式，请点击“生成代理”后预览')
          } else {
            setErrorMessage('播放启动失败，请检查视频源')
          }
        })
    } else {
      vid.pause()
      setPlaying(false)
    }
  }, [previewState, sourceType, switchToProxy])

  const startProxyPolling = useCallback((videoId: number) => {
    clearPolling()
    let tries = 0
    pollTimerRef.current = window.setInterval(async () => {
      tries += 1
      try {
        const latest = await fetchVideoRegistryById(videoId)
        onVideoInfoUpdate(latest)
        if (latest.proxy_status === 'done' && latest.proxy_path) {
          clearPolling()
          setSourceType('proxy')
          setSourcePath(latest.proxy_path)
          setPreviewState('loading')
          setErrorMessage('')
          return
        }
        if (latest.proxy_status === 'failed') {
          clearPolling()
          setPreviewState('error')
          setErrorMessage('代理生成失败，请检查原始视频后重试')
          return
        }
      } catch {
        // keep polling
      }
      if (tries >= 60) {
        clearPolling()
        setPreviewState('error')
        setErrorMessage('代理生成超时，请稍后刷新重试')
      }
    }, 2000)
  }, [clearPolling, onVideoInfoUpdate])

  const handleGenerateProxy = useCallback(async () => {
    if (!videoInfo?.id) return
    setPreviewState('generating_proxy')
    setErrorMessage('')
    setPlaying(false)
    try {
      await batchGenerateProxy([videoInfo.id], false)
      startProxyPolling(videoInfo.id)
    } catch (err) {
      setPreviewState('error')
      setErrorMessage(`生成代理失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [videoInfo, startProxyPolling])

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
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  onClick={handleGenerateProxy}
                  disabled={previewState === 'generating_proxy'}
                >
                  {previewState === 'generating_proxy' && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                  生成代理
                </Button>
              )}
            </div>

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
                    onTimeUpdate={() => { if (!hasFrame) setHasFrame(true) }}
                    onEnded={() => setPlaying(false)}
                    onPause={() => setPlaying(false)}
                    onPlay={() => setPlaying(true)}
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
