import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchVerified, updateVerified, deleteVerified, exportVerifiedClip } from '@/api/client'
import { hasExportFile, getClipDownloadUrl, parseTags } from '@/lib/clip-utils'
import { VideoPreviewDialog } from '@/components/review/VideoPreviewDialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Star, Download, Play, Trash2, Pencil, Loader2 } from 'lucide-react'
import { formatSec, formatDuration } from '@/lib/format'
import type { VerifiedClip } from '@/types'

export default function ClipsPage() {
  const [clips, setClips] = useState<VerifiedClip[]>([])
  const [loading, setLoading] = useState(true)
  const [skuFilter, setSkuFilter] = useState('')
  const [minRating, setMinRating] = useState(0)
  const [previewUrl, setPreviewUrl] = useState('')
  const [editClip, setEditClip] = useState<VerifiedClip | null>(null)
  const [editRating, setEditRating] = useState(0)
  const [editNotes, setEditNotes] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [exportingId, setExportingId] = useState<number | null>(null)

  const loadClips = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchVerified(skuFilter.trim())
      setClips(data)
    } catch (err) {
      console.error('加载片段失败', err)
    } finally {
      setLoading(false)
    }
  }, [skuFilter])

  useEffect(() => {
    loadClips()
  }, [loadClips])

  const filtered = useMemo(() => {
    if (minRating <= 0) return clips
    return clips.filter(c => c.rating >= minRating)
  }, [clips, minRating])

  const handleRatingChange = useCallback(async (clipId: number, newRating: number) => {
    try {
      const updated = await updateVerified(clipId, { rating: newRating })
      setClips(prev => prev.map(c => c.id === clipId ? updated : c))
    } catch (err) {
      console.error('更新评分失败', err)
    }
  }, [])

  const handleDelete = useCallback(async (clipId: number) => {
    if (!confirm('确认删除此片段？')) return
    try {
      await deleteVerified(clipId)
      setClips(prev => prev.filter(c => c.id !== clipId))
    } catch (err) {
      console.error('删除失败', err)
    }
  }, [])

  const handleExport = useCallback(async (clipId: number) => {
    setExportingId(clipId)
    try {
      const updated = await exportVerifiedClip(clipId)
      setClips(prev => prev.map(c => c.id === clipId ? updated : c))
    } catch (err) {
      console.error('导出失败', err)
    } finally {
      setExportingId(null)
    }
  }, [])

  const handleDownload = useCallback((clip: VerifiedClip) => {
    if (!hasExportFile(clip)) return
    const url = getClipDownloadUrl(clip)
    const a = document.createElement('a')
    a.href = url
    a.download = url.split('/').pop() || 'clip.mp4'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [])

  const openEdit = useCallback((clip: VerifiedClip) => {
    setEditClip(clip)
    setEditRating(clip.rating)
    setEditNotes(clip.notes)
  }, [])

  const handleEditSave = useCallback(async () => {
    if (!editClip) return
    setEditSaving(true)
    try {
      const updated = await updateVerified(editClip.id, { rating: editRating, notes: editNotes })
      setClips(prev => prev.map(c => c.id === editClip.id ? updated : c))
      setEditClip(null)
    } catch (err) {
      console.error('保存失败', err)
    } finally {
      setEditSaving(false)
    }
  }, [editClip, editRating, editNotes])

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <h1 className="text-xl font-bold">片段管理</h1>

      <div className="flex items-center gap-3 flex-wrap">
        <Input
          placeholder="按 SKU 筛选..."
          value={skuFilter}
          onChange={e => setSkuFilter(e.target.value)}
          className="w-48 h-8 text-sm"
        />
        <div className="flex items-center gap-1 text-sm">
          <span className="text-muted-foreground">最低星级:</span>
          {[0, 1, 2, 3, 4, 5].map(n => (
            <button
              key={n}
              onClick={() => setMinRating(n)}
              className={`px-2 py-0.5 rounded text-xs ${minRating === n ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}
            >
              {n === 0 ? '全部' : `${n}+`}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground ml-auto">
          {loading ? '加载中...' : `共 ${filtered.length} 条`}
        </span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          加载片段...
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-center text-muted-foreground py-12">暂无片段</p>
      ) : (
        <div className="space-y-1">
          {filtered.map(clip => {
            const tags = parseTags(clip.tags_json)
            const exported = hasExportFile(clip)

            return (
              <div key={clip.id} className="flex items-center gap-3 p-2 rounded border bg-card hover:bg-muted/30 transition-colors text-sm">
                {clip.thumbnail ? (
                  <img src={`/data/${clip.thumbnail}`} className="w-10 h-16 object-cover rounded shrink-0" loading="lazy" />
                ) : (
                  <div className="w-10 h-16 bg-muted rounded shrink-0" />
                )}

                <span className="font-mono text-xs w-20 shrink-0">{clip.sku_code}</span>

                <span className="font-mono text-xs text-muted-foreground w-32 shrink-0">
                  {formatSec(clip.start_sec)} - {formatSec(clip.end_sec)}
                  <span className="ml-1">({formatDuration(clip.end_sec - clip.start_sec)})</span>
                </span>

                <div className="flex items-center gap-0.5 shrink-0">
                  {[1, 2, 3, 4, 5].map(n => (
                    <Star
                      key={n}
                      className={`w-3.5 h-3.5 cursor-pointer ${n <= clip.rating ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground hover:text-yellow-400'}`}
                      onClick={() => handleRatingChange(clip.id, n === clip.rating ? 0 : n)}
                    />
                  ))}
                </div>

                <div className="flex gap-1 flex-1 min-w-0 overflow-hidden">
                  {tags.map(tag => (
                    <Badge key={tag} variant="outline" className="text-[10px] py-0 shrink-0">{tag}</Badge>
                  ))}
                </div>

                <span className="text-[11px] text-muted-foreground shrink-0">
                  {clip.created_at?.slice(0, 10)}
                </span>

                <div className="flex items-center gap-1 shrink-0">
                  {exported ? (
                    <>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setPreviewUrl(getClipDownloadUrl(clip))} title="预览">
                        <Play className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleDownload(clip)} title="下载">
                        <Download className="w-3.5 h-3.5" />
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => handleExport(clip.id)}
                      disabled={exportingId === clip.id}
                      title="导出粗剪"
                    >
                      {exportingId === clip.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                      导出
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => openEdit(clip)} title="编辑">
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-400 hover:text-red-300" onClick={() => handleDelete(clip.id)} title="删除">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <VideoPreviewDialog
        open={!!previewUrl}
        onOpenChange={(open) => { if (!open) setPreviewUrl('') }}
        videoUrl={previewUrl}
      />

      <Dialog open={!!editClip} onOpenChange={(open) => { if (!open) setEditClip(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">编辑片段 #{editClip?.id}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">评分</label>
              <div className="flex gap-1 mt-1">
                {[1, 2, 3, 4, 5].map(n => (
                  <Star
                    key={n}
                    className={`w-5 h-5 cursor-pointer ${n <= editRating ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground hover:text-yellow-400'}`}
                    onClick={() => setEditRating(n === editRating ? 0 : n)}
                  />
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">备注</label>
              <textarea
                value={editNotes}
                onChange={e => setEditNotes(e.target.value)}
                className="w-full mt-1 min-h-20 rounded border bg-background px-2 py-1 text-sm"
                placeholder="补充说明..."
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditClip(null)}>取消</Button>
              <Button size="sm" onClick={handleEditSave} disabled={editSaving}>
                {editSaving && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
