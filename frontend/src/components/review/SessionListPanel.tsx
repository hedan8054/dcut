import { useState } from 'react'
import { ChevronDown, ChevronUp, Clock, Video, CheckCircle2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { formatDuration } from '@/lib/format'
import type { SessionGroup } from '@/types'

interface Props {
  sessions: SessionGroup[]
  currentSession: SessionGroup | null
  onSelectSession: (session: SessionGroup) => void
}

/**
 * 场次列表浮动面板: 默认收起只显示当前场次，
 * 点击展开显示全部场次，选择后自动收起
 */
export function SessionListPanel({ sessions, currentSession, onSelectSession }: Props) {
  const [expanded, setExpanded] = useState(false)

  if (sessions.length === 0) return null

  const handleSelect = (session: SessionGroup) => {
    onSelectSession(session)
    setExpanded(false)
  }

  // 解析 lead 的时间点用于展示
  const getTimePoints = (session: SessionGroup): string[] => {
    const points: string[] = []
    for (const lead of session.leads) {
      try {
        const parsed: string[] = JSON.parse(lead.time_points_json)
        points.push(...parsed)
      } catch { /* ignore */ }
    }
    return points
  }

  return (
    <div className="rounded-lg border border-rv-border overflow-hidden">
      {/* Header: 点击展开/收起 */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-rv-elevated/30 transition-colors bg-rv-surface"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-sm font-semibold">场次列表</span>
        <Badge variant="outline" className="text-[11px] py-0">{sessions.length} 场</Badge>
        {currentSession && !expanded && (
          <span className="text-[11px] text-muted-foreground font-mono ml-1">
            当前: {currentSession.date}
            {currentSession.leads[0]?.session_label ? ` · ${currentSession.leads[0].session_label}` : ''}
          </span>
        )}
        <div className="flex-1" />
        {expanded
          ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
          : <ChevronDown className="w-4 h-4 text-muted-foreground" />
        }
      </div>

      {/* 展开: 场次行列表 */}
      {expanded && (
        <div className="border-t border-rv-border">
          {sessions.map((session, i) => {
            const isCurrent = currentSession?.date === session.date
              && currentSession?.leads[0]?.session_label === session.leads[0]?.session_label
            const hasVideo = session.video !== null
            const timePoints = getTimePoints(session)

            return (
              <div
                key={`${session.date}-${i}`}
                className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors border-b border-rv-border last:border-b-0 ${
                  isCurrent
                    ? 'bg-rv-elevated border-l-2 border-l-rv-accent'
                    : 'hover:bg-rv-elevated/30'
                }`}
                onClick={() => handleSelect(session)}
              >
                {/* 日期 */}
                <span className="font-mono text-[13px] font-medium w-24 shrink-0">
                  {session.date}
                </span>

                {/* 场次标签 */}
                {session.leads[0]?.session_label && (
                  <span className="text-[12px] text-muted-foreground w-10 shrink-0">
                    {session.leads[0].session_label}
                  </span>
                )}

                {/* 时间点 */}
                {timePoints.length > 0 && (
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1 shrink-0">
                    <Clock className="w-3 h-3" />
                    {timePoints.slice(0, 3).join(', ')}
                    {timePoints.length > 3 && ` +${timePoints.length - 3}`}
                  </span>
                )}

                {/* 时长 */}
                {session.video && (
                  <span className="text-[11px] text-muted-foreground shrink-0">
                    时长 {formatDuration(session.video.duration_sec)}
                  </span>
                )}

                <div className="flex-1" />

                {/* 视频状态 */}
                {hasVideo ? (
                  <Badge className="bg-green-500/20 text-green-400 text-[10px] py-0 gap-1 shrink-0">
                    <Video className="w-3 h-3" /> 有视频
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] py-0 text-muted-foreground shrink-0">
                    无视频
                  </Badge>
                )}

                {/* 标注状态 */}
                {session.verified_count > 0 ? (
                  <span className="text-[10px] text-green-400 flex items-center gap-0.5 shrink-0">
                    <CheckCircle2 className="w-3 h-3" /> {session.verified_count} 条
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
  )
}
