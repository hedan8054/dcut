import { useEffect, useRef, useState } from 'react'
import { Calendar, ChevronDown, Clock, Video, CheckCircle2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { formatDuration } from '@/lib/format'
import type { VideoRegistry, SessionGroup } from '@/types'

type ReviewMode = 'browse' | 'annotate'

interface Props {
  currentSession: SessionGroup | null
  videoInfo: VideoRegistry | null
  sessions: SessionGroup[]
  mode: ReviewMode
  onModeChange: (mode: ReviewMode) => void
  onSelectSession: (session: SessionGroup) => void
}

/** 解析 lead 的时间点用于展示 */
function getTimePoints(session: SessionGroup): string[] {
  const points: string[] = []
  for (const lead of session.leads) {
    try {
      const parsed: string[] = JSON.parse(lead.time_points_json)
      points.push(...parsed)
    } catch { /* ignore */ }
  }
  return points
}

export function SessionTopBar({
  currentSession, videoInfo, sessions, mode, onModeChange, onSelectSession,
}: Props) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭下拉
  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  if (!currentSession) {
    return (
      <div className="h-10 border-b border-rv-border flex items-center px-4 shrink-0 bg-rv-surface">
        <span className="text-sm text-muted-foreground">选择 SKU 后自动加载场次</span>
      </div>
    )
  }

  const handleSelect = (session: SessionGroup) => {
    onSelectSession(session)
    setDropdownOpen(false)
  }

  return (
    <div className="h-10 border-b border-rv-border flex items-center gap-3 px-4 shrink-0 bg-rv-surface relative">
      {/* 左: 场次选择器 */}
      <div ref={dropdownRef} className="relative">
        <button
          className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-rv-elevated/40 transition-colors"
          onClick={() => setDropdownOpen(!dropdownOpen)}
        >
          <Badge className="bg-rv-accent text-black text-xs font-mono gap-1 shrink-0 py-0 pointer-events-none">
            <Calendar className="w-3 h-3" />
            {currentSession.date}
          </Badge>
          {currentSession.leads[0]?.session_label && (
            <span className="text-xs text-muted-foreground">
              {currentSession.leads[0].session_label}
            </span>
          )}
          <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
        </button>

        {/* 下拉列表 */}
        {dropdownOpen && sessions.length > 0 && (
          <div className="absolute top-full left-0 mt-1 w-[480px] max-h-[400px] overflow-y-auto rounded-lg border border-rv-border bg-rv-panel shadow-lg z-50">
            <div className="px-3 py-2 border-b border-rv-border text-xs text-muted-foreground">
              {sessions.length} 个场次
            </div>
            {sessions.map((session, i) => {
              const isCurrent = currentSession?.date === session.date
                && currentSession?.leads[0]?.session_label === session.leads[0]?.session_label
              const hasVideo = session.video !== null
              const timePoints = getTimePoints(session)

              return (
                <div
                  key={`${session.date}-${i}`}
                  className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors border-b border-rv-border/50 last:border-b-0 ${
                    isCurrent
                      ? 'bg-rv-elevated border-l-2 border-l-rv-accent'
                      : 'hover:bg-rv-elevated/30'
                  }`}
                  onClick={() => handleSelect(session)}
                >
                  <span className="font-mono text-[13px] font-medium w-24 shrink-0">
                    {session.date}
                  </span>

                  {session.leads[0]?.session_label && (
                    <span className="text-[12px] text-muted-foreground w-10 shrink-0">
                      {session.leads[0].session_label}
                    </span>
                  )}

                  {timePoints.length > 0 && (
                    <span className="text-[11px] text-muted-foreground flex items-center gap-1 shrink-0">
                      <Clock className="w-3 h-3" />
                      {timePoints.slice(0, 3).join(', ')}
                      {timePoints.length > 3 && ` +${timePoints.length - 3}`}
                    </span>
                  )}

                  {session.video && (
                    <span className="text-[11px] text-muted-foreground shrink-0">
                      {formatDuration(session.video.duration_sec)}
                    </span>
                  )}

                  <div className="flex-1" />

                  {hasVideo ? (
                    <Badge className="bg-green-500/20 text-green-400 text-[10px] py-0 gap-1 shrink-0">
                      <Video className="w-3 h-3" /> 有视频
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] py-0 text-muted-foreground shrink-0">
                      无视频
                    </Badge>
                  )}

                  {session.verified_count > 0 ? (
                    <span className="text-[10px] text-green-400 flex items-center gap-0.5 shrink-0">
                      <CheckCircle2 className="w-3 h-3" /> {session.verified_count}
                    </span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground shrink-0">未标注</span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {videoInfo && (
        <span className="text-xs text-muted-foreground font-mono">
          {formatDuration(videoInfo.duration_sec)}
        </span>
      )}

      <div className="flex-1" />

      {/* 右: 模式切换 pills */}
      <div className="flex rounded-md border border-rv-border overflow-hidden text-xs">
        <button
          className={`px-3 py-1 transition-colors ${
            mode === 'browse'
              ? 'bg-rv-accent text-black font-medium'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => onModeChange('browse')}
        >
          场次浏览
        </button>
        <button
          className={`px-3 py-1 transition-colors ${
            mode === 'annotate'
              ? 'bg-rv-accent text-black font-medium'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => onModeChange('annotate')}
        >
          预览标注
        </button>
      </div>
    </div>
  )
}
