import { useState, useCallback, useEffect } from 'react'
import { Star, Save, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatSec, formatDuration } from '@/lib/format'

const PRESET_TAGS = ['远景', '细节', '试穿', '讲得顺', '情绪好', '商品全屏']

interface Props {
  hitTimestamp: number
  startSec: number
  endSec: number
  onStartChange: (sec: number) => void
  onEndChange: (sec: number) => void
  onSave: (data: {
    start_sec: number
    end_sec: number
    rating: number
    tags: string[]
  }) => Promise<void>
  onCancel: () => void
}

/**
 * 紧凑标注栏: 显示在时间轴下方
 * 起止时间 + 评分 + 标签 + 保存/取消
 */
export function AnnotationBar({
  hitTimestamp, startSec, endSec,
  onStartChange, onEndChange,
  onSave, onCancel,
}: Props) {
  const [rating, setRating] = useState(0)
  const [tags, setTags] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const toggleTag = useCallback((tag: string) => {
    setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag])
  }, [])

  const handleSave = useCallback(async () => {
    if (endSec <= startSec) return
    setSaving(true)
    try {
      await onSave({ start_sec: startSec, end_sec: endSec, rating, tags })
      // 保存成功后重置
      setRating(0)
      setTags([])
    } finally {
      setSaving(false)
    }
  }, [startSec, endSec, rating, tags, onSave])

  // 键盘快捷键: [ 设起点, ] 设终点, ←→ ±1s, Enter 保存, Esc 取消
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === '[') {
        e.preventDefault()
        onStartChange(hitTimestamp)
      } else if (e.key === ']') {
        e.preventDefault()
        onEndChange(hitTimestamp)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        onStartChange(startSec - 1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        onEndChange(endSec + 1)
      } else if (e.key === 'Enter' && !saving && endSec > startSec) {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [hitTimestamp, startSec, endSec, onStartChange, onEndChange, saving, handleSave, onCancel])

  return (
    <div className="border-t border-rv-border bg-rv-surface px-4 py-3 space-y-2">
      {/* 第一行: 时间范围 + 评分 + 操作 */}
      <div className="flex items-center gap-4 flex-wrap">
        <span className="text-xs font-mono">
          <span className="text-rv-accent">{formatSec(startSec)}</span>
          {' - '}
          <span className="text-rv-accent">{formatSec(endSec)}</span>
          <span className="text-muted-foreground ml-1">
            ({formatDuration(endSec - startSec)})
          </span>
        </span>

        {/* 评分 */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">评分:</span>
          <div className="flex gap-0.5">
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} onClick={() => setRating(n === rating ? 0 : n)} className="p-0">
                <Star className={`w-4 h-4 ${n <= rating ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'}`} />
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1" />

        <span className="text-[11px] text-muted-foreground">
          [ 起点 ] 终点 ←→ ±1s Enter 保存 Esc 取消
        </span>

        <Button size="sm" onClick={handleSave} disabled={saving || endSec <= startSec}>
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          保存片段
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="w-3 h-3" />
          取消
        </Button>
      </div>

      {/* 第二行: 标签 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-muted-foreground">标签:</span>
        {PRESET_TAGS.map(tag => (
          <Badge
            key={tag}
            variant={tags.includes(tag) ? 'default' : 'outline'}
            className="cursor-pointer text-[11px] py-0"
            onClick={() => toggleTag(tag)}
          >
            {tag}
          </Badge>
        ))}
      </div>
    </div>
  )
}
