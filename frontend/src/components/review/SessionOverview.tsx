import { useState, useEffect, type ReactNode } from 'react'
import { Video, CheckCircle2, Clock, AlertCircle, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { fetchSkuSessions } from '@/api/client'
import { formatDuration } from '@/lib/format'
import type { Lead, VideoRegistry, SessionGroup } from '@/types'

interface Props {
  skuCode: string
  onSelectSession: (leads: Lead[], video: VideoRegistry | null, sessionKey: string) => void
  expandedSessionKey?: string | null
  expandedContent?: ReactNode
}

/**
 * 场次总览：按日期分组展示某 SKU 的所有直播场次
 * 替代 review 页面的平铺 lead 列表
 */
export function SessionOverview({ skuCode, onSelectSession, expandedSessionKey, expandedContent }: Props) {
  const [sessions, setSessions] = useState<SessionGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // skuCode 变化时重新拉取场次数据
  useEffect(() => {
    if (!skuCode) {
      setSessions([])
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    fetchSkuSessions(skuCode)
      .then((data) => {
        if (!cancelled) setSessions(data.sessions)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? '加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [skuCode])

  // 从 lead 的 time_points_json 中提取时间点（格式 "H:MM" 或 "HH:MM"）
  function extractTimePoints(leads: Lead[]): string[] {
    const points: string[] = []
    for (const lead of leads) {
      try {
        const parsed = JSON.parse(lead.time_points_json) as string[]
        for (const pt of parsed) {
          points.push(pt)
        }
      } catch {
        // time_points_json 解析失败则跳过
      }
    }
    return points
  }

  // 格式化日期 "2026-02-19" -> "2026/2/19"
  function formatDate(dateStr: string): string {
    const [y, m, d] = dateStr.split('-')
    return `${y}/${Number(m)}/${Number(d)}`
  }

  // 加载中
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        <span className="text-sm">加载场次...</span>
      </div>
    )
  }

  // 错误
  if (error) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-destructive">
        <AlertCircle className="w-4 h-4" />
        <span className="text-sm">{error}</span>
      </div>
    )
  }

  // 无数据
  if (sessions.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-8">
        暂无场次数据
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-1 p-1">
        {sessions.map((session) => {
          const sessionKey = `${session.date}-${session.video?.session_label ?? 'default'}`
          const timePoints = extractTimePoints(session.leads)
          const hasVideo = session.video !== null
          const isExpanded = sessionKey === expandedSessionKey

          return (
            <div key={sessionKey}>
              <div
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors
                  ${isExpanded
                    ? 'bg-accent/50 border-primary/50 rounded-b-none'
                    : 'hover:bg-accent/50 hover:border-primary/30'
                  }`}
                onClick={() => onSelectSession(session.leads, session.video, sessionKey)}
              >
                {/* 左侧：日期 + 场次标签 */}
                <div className="shrink-0 min-w-[80px]">
                  <div className="text-sm font-medium">{formatDate(session.date)}</div>
                  {session.leads[0]?.session_label && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {session.leads[0].session_label}
                    </div>
                  )}
                </div>

                {/* 中间：时间点 + 视频时长 */}
                <div className="flex-1 min-w-0 space-y-1">
                  {timePoints.length > 0 && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="w-3 h-3 shrink-0" />
                      <span className="truncate">{timePoints.join(', ')}</span>
                    </div>
                  )}
                  {hasVideo && session.video!.duration_sec > 0 && (
                    <div className="text-xs text-muted-foreground">
                      时长 {formatDuration(session.video!.duration_sec)}
                    </div>
                  )}
                </div>

                {/* 右侧：状态 badges */}
                <div className="shrink-0 flex flex-col items-end gap-1">
                  {hasVideo ? (
                    <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/20 text-[11px] px-1.5 py-0">
                      <Video className="w-3 h-3 mr-0.5" />
                      有视频
                    </Badge>
                  ) : (
                    <Badge className="bg-orange-500/15 text-orange-600 border-orange-500/20 text-[11px] px-1.5 py-0">
                      <AlertCircle className="w-3 h-3 mr-0.5" />
                      无视频
                    </Badge>
                  )}

                  {session.verified_count > 0 ? (
                    <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/20 text-[11px] px-1.5 py-0">
                      <CheckCircle2 className="w-3 h-3 mr-0.5" />
                      已标注 {session.verified_count} 段
                    </Badge>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">未标注</span>
                  )}
                </div>
              </div>

              {/* 展开：filmstrip 内容 */}
              {isExpanded && expandedContent && (
                <div className="border-x border-b border-primary/50 rounded-b-lg px-3 pb-3 pt-2 space-y-3 bg-card">
                  {expandedContent}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
