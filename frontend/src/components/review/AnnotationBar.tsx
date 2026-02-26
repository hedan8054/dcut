import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, Save, Star, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { formatSec, formatDuration } from '@/lib/format'
import type { ReviewCapsule } from '@/types'

const PRESET_TAGS = ['远景', '细节', '试穿', '讲得顺', '情绪好', '商品全屏']

interface Props {
  capsule: ReviewCapsule
  currentSkuCode?: string
  /** 外部可通过此 ref 调用 handleSave（Enter 快捷键） */
  saveRef?: React.MutableRefObject<(() => Promise<void>) | null>
  onPatch: (patch: {
    sku_code?: string | null
    sku_label?: string | null
    rating?: number
    tags?: string[]
    notes?: string
    status?: 'draft' | 'bound' | 'final'
  }) => Promise<void>
  onDelete: () => Promise<void>
  onClose: () => void
}

export function AnnotationBar({ capsule, currentSkuCode, saveRef, onPatch, onDelete, onClose }: Props) {
  const [skuCode, setSkuCode] = useState(capsule.sku_code ?? '')
  const [skuLabel, setSkuLabel] = useState(capsule.sku_label ?? '')
  const [rating, setRating] = useState(capsule.rating)
  const [tags, setTags] = useState<string[]>([])
  const [notes, setNotes] = useState(capsule.notes)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    setSkuCode(capsule.sku_code ?? currentSkuCode ?? '')
    setSkuLabel(capsule.sku_label ?? '')
    setRating(capsule.rating)
    setNotes(capsule.notes)
    setDetailsOpen(false)
    try {
      const parsed = JSON.parse(capsule.tags_json)
      setTags(Array.isArray(parsed) ? parsed.map(String) : [])
    } catch {
      setTags([])
    }
  }, [capsule, currentSkuCode])

  const toggleTag = useCallback((tag: string) => {
    setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag])
  }, [])

  const effectiveSkuCode = useMemo(() => {
    return skuCode.trim() || currentSkuCode?.trim() || ''
  }, [currentSkuCode, skuCode])

  const status = useMemo(() => {
    if (effectiveSkuCode) return 'bound' as const
    return 'draft' as const
  }, [effectiveSkuCode])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await onPatch({
        sku_code: effectiveSkuCode || null,
        sku_label: skuLabel.trim() || null,
        rating,
        tags,
        notes,
        status,
      })
    } finally {
      setSaving(false)
    }
  }, [effectiveSkuCode, notes, onPatch, rating, skuLabel, status, tags])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await onDelete()
    } finally {
      setDeleting(false)
    }
  }, [onDelete])

  // 暴露 handleSave 给外部（ReviewPage 通过 Enter 键调用）
  useEffect(() => {
    if (saveRef) saveRef.current = handleSave
    return () => { if (saveRef) saveRef.current = null }
  }, [handleSave, saveRef])

  // debounced 自动保存: 评分或标签变化后 800ms 自动保存
  const autoSaveTimerRef = useRef<number | null>(null)
  const initialSyncRef = useRef(true)

  useEffect(() => {
    // 跳过首次同步（capsule 切换时 useEffect 设置初始值）
    if (initialSyncRef.current) {
      initialSyncRef.current = false
      return
    }

    if (autoSaveTimerRef.current != null) {
      window.clearTimeout(autoSaveTimerRef.current)
    }
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null
      void onPatch({
        sku_code: effectiveSkuCode || null,
        sku_label: skuLabel.trim() || null,
        rating,
        tags,
        notes,
        status,
      })
    }, 800)

    return () => {
      if (autoSaveTimerRef.current != null) {
        window.clearTimeout(autoSaveTimerRef.current)
      }
    }
  }, [rating, tags]) // eslint-disable-line react-hooks/exhaustive-deps -- 仅在评分/标签变化时自动保存

  // capsule 切换时重置 initialSync flag
  useEffect(() => {
    initialSyncRef.current = true
  }, [capsule.id])

  return (
    <div className="border-t border-rv-border bg-rv-surface px-4 py-3 space-y-3 shrink-0">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs font-mono">
          <span className="text-rv-accent">{formatSec(capsule.start_sec)}</span>
          {' - '}
          <span className="text-rv-accent">{formatSec(capsule.end_sec)}</span>
          <span className="text-muted-foreground ml-1">
            ({formatDuration(capsule.end_sec - capsule.start_sec)})
          </span>
        </span>

        <Badge variant="outline" className="text-[11px]">capsule #{capsule.id}</Badge>
        <Badge className="text-[11px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
          {effectiveSkuCode ? `已绑定 SKU: ${effectiveSkuCode}` : 'SKU 未绑定'}
        </Badge>

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
        <span className="text-[11px] text-muted-foreground">Enter 保存 · [ ] 设起止 · Del 删除 · Alt+↑↓ 切款 · F 沉浸</span>
        <Button variant="ghost" size="sm" onClick={() => setDetailsOpen(v => !v)} disabled={saving || deleting}>
          {detailsOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {detailsOpen ? '收起详情' : '展开详情'}
        </Button>

        <Button size="sm" onClick={handleSave} disabled={saving || deleting}>
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          保存胶囊
        </Button>
        <Button variant="outline" size="sm" onClick={handleDelete} disabled={saving || deleting}>
          {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
          删除
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={saving || deleting}>
          <X className="w-3 h-3" />
          关闭
        </Button>
      </div>

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

      {detailsOpen && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div>
              <label className="text-[11px] text-muted-foreground">SKU 编码（可空）</label>
              <Input value={skuCode} onChange={(e) => setSkuCode(e.target.value)} placeholder="例如 511181" className="h-8 text-xs font-mono" />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">SKU 标签（可空）</label>
              <Input value={skuLabel} onChange={(e) => setSkuLabel(e.target.value)} placeholder="例如 TT-VEGETABLES" className="h-8 text-xs" />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">状态</label>
              <div className="h-8 flex items-center px-2 rounded border border-rv-border text-xs font-mono">
                {status}
              </div>
            </div>
          </div>

          <div>
            <label className="text-[11px] text-muted-foreground">备注</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full mt-1 min-h-16 rounded border border-rv-border bg-background px-2 py-1 text-xs"
              placeholder="补充说明，可选"
            />
          </div>
        </>
      )}
    </div>
  )
}
