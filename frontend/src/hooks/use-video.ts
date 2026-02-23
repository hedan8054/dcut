import { useState, useCallback } from 'react'
import { fetchVideoMeta, getVideoStreamUrl } from '@/api/client'
import type { VideoMeta } from '@/types'

/**
 * 视频元数据 + 流地址 hook
 */
export function useVideo() {
  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [streamUrl, setStreamUrl] = useState('')
  const [loading, setLoading] = useState(false)

  const loadVideo = useCallback(async (path: string) => {
    setLoading(true)
    try {
      const m = await fetchVideoMeta(path)
      setMeta(m)
      setStreamUrl(getVideoStreamUrl(path))
    } catch (err) {
      console.error('加载视频元数据失败:', err)
      setMeta(null)
      setStreamUrl('')
    } finally {
      setLoading(false)
    }
  }, [])

  return { meta, streamUrl, loading, loadVideo }
}
