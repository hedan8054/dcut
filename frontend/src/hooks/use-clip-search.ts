import { useCallback, useState } from 'react'
import { clipSearch, type ClipSearchResult } from '@/api/client'
import type { VideoRegistry, SkuImage } from '@/types'

interface UseClipSearchReturn {
  results: ClipSearchResult[]
  searching: boolean
  search: () => Promise<void>
  clear: () => void
}

export function useClipSearch(
  videoInfo: VideoRegistry | null,
  skuImages: SkuImage[],
): UseClipSearchReturn {
  const [results, setResults] = useState<ClipSearchResult[]>([])
  const [searching, setSearching] = useState(false)

  const search = useCallback(async () => {
    if (!videoInfo || skuImages.length === 0) return
    setSearching(true)
    setResults([])
    try {
      const res = await clipSearch({
        sku_image_path: skuImages[0].file_path,
        video_path: videoInfo.proxy_path || videoInfo.raw_path,
        video_duration: videoInfo.duration_sec || 4 * 3600,
        sample_interval: 30,
        top_k: 12,
      })
      setResults(res.results)
    } catch (err) {
      console.error('CLIP 搜索失败:', err)
      alert(`CLIP 搜索失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setSearching(false)
    }
  }, [videoInfo, skuImages])

  const clear = useCallback(() => {
    setResults([])
  }, [])

  return { results, searching, search, clear }
}
