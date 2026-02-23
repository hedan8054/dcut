import { useState, useCallback, useRef } from 'react'
import { Search, Star, Upload, X, Image } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { searchBySku, uploadSkuImage, fetchSkuImages, deleteSkuImage } from '@/api/client'
import { ClickableImage } from '@/components/ui/image-preview'
import { formatSec, formatDuration } from '@/lib/format'
import type { SkuSearchResult, SkuImage } from '@/types'

export function SkuSearchView() {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SkuSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [images, setImages] = useState<SkuImage[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadType, setUploadType] = useState<'main' | 'ref' | 'cover'>('main')

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return
    setLoading(true)
    setError('')
    try {
      const code = query.trim().toUpperCase()
      const r = await searchBySku(code)
      setResult(r)
      const imgs = await fetchSkuImages(code).catch(() => [])
      setImages(imgs)
    } catch (err) {
      setError(err instanceof Error ? err.message : '搜索失败')
      setResult(null)
      setImages([])
    } finally {
      setLoading(false)
    }
  }, [query])

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !result) return
    try {
      await uploadSkuImage(result.product.sku_code, file, uploadType)
      const imgs = await fetchSkuImages(result.product.sku_code)
      setImages(imgs)
    } catch (err) {
      alert(`上传失败: ${err}`)
    }
    // 清空 input 允许重复上传
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [result, uploadType])

  const handleDeleteImage = useCallback(async (imageId: number) => {
    if (!result) return
    await deleteSkuImage(result.product.sku_code, imageId)
    setImages((prev) => prev.filter((i) => i.id !== imageId))
  }, [result])

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input
          placeholder="输入款号或品名..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <Button onClick={handleSearch} disabled={loading}>
          <Search className="w-4 h-4" />
          搜索
        </Button>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {result && (
        <ScrollArea className="h-[calc(100vh-220px)]">
          <div className="space-y-6">
            {/* 商品信息 + 图片管理 */}
            <div className="p-4 rounded-lg bg-card border space-y-3">
              <div className="flex items-start gap-4">
                <div className="w-20 h-20 rounded bg-muted shrink-0 overflow-hidden">
                  {result.product.image_path ? (
                    <ClickableImage
                      src={`/data/${result.product.image_path}`}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">无图</div>
                  )}
                </div>
                <div className="space-y-1 flex-1">
                  <p className="font-mono text-lg font-bold">{result.product.sku_code}</p>
                  <p className="text-sm">{result.product.product_name || '(未命名)'}</p>
                  <div className="flex gap-2 text-xs text-muted-foreground">
                    {result.product.price != null && <span>¥{result.product.price}</span>}
                    {result.product.shop_name && <span>{result.product.shop_name}</span>}
                    {result.product.product_status && (
                      <Badge variant="outline" className="text-xs">{result.product.product_status}</Badge>
                    )}
                  </div>
                </div>
              </div>

              {/* 图片管理区域 */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Image className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs font-semibold text-muted-foreground">
                    图片 ({images.length})
                  </span>
                  <div className="flex-1" />
                  <select
                    className="text-xs border rounded px-1.5 py-0.5"
                    value={uploadType}
                    onChange={(e) => setUploadType(e.target.value as typeof uploadType)}
                  >
                    <option value="main">主图</option>
                    <option value="ref">参考图</option>
                    <option value="cover">封面图</option>
                  </select>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleUpload}
                  />
                  <Button
                    variant="outline" size="sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="w-3 h-3" /> 上传
                  </Button>
                </div>
                {images.length > 0 ? (
                  <div className="flex gap-2 flex-wrap">
                    {images.map((img) => (
                      <div key={img.id} className="relative group w-16 h-16 rounded border overflow-hidden">
                        <ClickableImage src={`/data/${img.file_path}`} className="w-full h-full object-cover" />
                        <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] text-white text-center">
                          {img.image_type}
                        </div>
                        <button
                          className="absolute top-0 right-0 bg-red-500 text-white rounded-bl p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => handleDeleteImage(img.id)}
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    暂无图片，请在导入页面使用"导入已下载图片"或手动上传
                  </p>
                )}
              </div>
            </div>

            {/* Lead 时间线 */}
            <div>
              <h3 className="text-sm font-semibold mb-2">线索时间线 ({result.leads.length})</h3>
              <div className="space-y-1">
                {result.leads.map((lead) => {
                  const timePoints: string[] = (() => {
                    try { return JSON.parse(lead.time_points_json) } catch { return [] }
                  })()
                  return (
                    <div key={lead.id} className="flex items-center gap-2 text-sm p-2 rounded bg-card border">
                      <span className="font-medium w-24">
                        {lead.material_year}/{lead.material_month || '?'}/{lead.material_day || '?'}
                      </span>
                      {timePoints.map((tp) => (
                        <Badge key={tp} variant="secondary" className="text-xs font-mono">{tp}</Badge>
                      ))}
                      <Badge variant={
                        lead.parse_confidence === 'HIGH' ? 'default' :
                        lead.parse_confidence === 'MEDIUM' ? 'secondary' : 'outline'
                      } className="text-[10px]">
                        {lead.parse_confidence}
                      </Badge>
                    </div>
                  )
                })}
                {result.leads.length === 0 && (
                  <p className="text-muted-foreground text-sm">无线索记录</p>
                )}
              </div>
            </div>

            {/* 真值片段 */}
            <div>
              <h3 className="text-sm font-semibold mb-2">
                真值片段 ({result.verified_clips.length})
              </h3>
              <div className="space-y-2">
                {result.verified_clips.map((clip) => (
                  <div key={clip.id} className="flex items-center gap-3 p-3 rounded bg-card border">
                    <div className="flex gap-0.5">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <Star
                          key={n}
                          className={`w-3.5 h-3.5 ${
                            n <= clip.rating ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'
                          }`}
                        />
                      ))}
                    </div>
                    <span className="font-mono text-sm">
                      {formatSec(clip.start_sec)} - {formatSec(clip.end_sec)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      ({formatDuration(clip.end_sec - clip.start_sec)})
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {clip.created_at?.slice(0, 10)}
                    </span>
                  </div>
                ))}
                {result.verified_clips.length === 0 && (
                  <p className="text-muted-foreground text-sm">无真值片段</p>
                )}
              </div>
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
