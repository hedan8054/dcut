import { useState, useCallback } from 'react'
import { batchFrames } from '@/api/client'

export interface FrameData {
  timestamp: number
  url: string
  error?: string
}

/**
 * 批量抽帧 hook
 * 给定视频路径和时间戳数组，返回帧 URL 列表
 */
export function useFrames() {
  const [frames, setFrames] = useState<FrameData[]>([])
  const [loading, setLoading] = useState(false)

  const loadFrames = useCallback(async (
    path: string,
    timestamps: number[],
    w = 180,
    h = 320,
  ) => {
    setLoading(true)
    try {
      const result = await batchFrames({ path, timestamps, w, h })
      setFrames(result.frames)
    } catch (err) {
      console.error('批量抽帧失败:', err)
      setFrames([])
    } finally {
      setLoading(false)
    }
  }, [])

  const clearFrames = useCallback(() => {
    setFrames([])
  }, [])

  return { frames, loading, loadFrames, clearFrames }
}
