import { Calendar } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { formatDuration } from '@/lib/format'
import type { VideoRegistry, SessionGroup } from '@/types'

type ReviewMode = 'browse' | 'annotate'

interface Props {
  currentSession: SessionGroup | null
  videoInfo: VideoRegistry | null
  mode: ReviewMode
  onModeChange: (mode: ReviewMode) => void
}

export function SessionTopBar({
  currentSession, videoInfo, mode, onModeChange,
}: Props) {
  if (!currentSession) {
    return (
      <div className="h-10 border-b border-rv-border flex items-center px-4 shrink-0 bg-rv-surface">
        <span className="text-sm text-muted-foreground">选择 SKU 后自动加载场次</span>
      </div>
    )
  }

  return (
    <div className="h-10 border-b border-rv-border flex items-center gap-3 px-4 shrink-0 bg-rv-surface">
      {/* 左: 日期 + 时长概要 */}
      <Badge className="bg-rv-accent text-black text-xs font-mono gap-1 shrink-0 py-0">
        <Calendar className="w-3 h-3" />
        {currentSession.date}
      </Badge>

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
