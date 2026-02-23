import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Loader2, ZoomIn, ZoomOut, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { FrameData } from '@/hooks/use-multi-res-frames'
import { formatSec } from '@/lib/format'

type LocalZoom = 'L2' | 'L3'  // 5s 或 1s

interface Props {
  anchorSec: number
  videoDuration: number
  viewRange: [number, number]
  onViewRangeChange: (range: [number, number]) => void
  onFrameSelect: (timestamp: number) => void
  // 帧数据由父组件通过 hook 获取后传入
  l2Frames: FrameData[]
  l3Frames: FrameData[]
  l2Loading: boolean
  l3Loading: boolean
  l2Progress: [number, number]
  l3Progress: [number, number]
  // L3 按需加载回调
  onRequestL3: (centerSec: number) => void
  // CLIP 匹配
  clipTimestamps?: number[]
}

const FRAME_W = 90
const FRAME_H = 160   // 9:16 竖屏
const PAN_STEP = 5 * 60

/**
 * 局部 filmstrip — FlexBox 换行布局
 *
 * L2 (5s/帧) 默认 | L3 (1s/帧) 放大
 * 触摸板 pinch 切换 | 左右箭头平移
 * 单击帧 → 进入 fine 步骤
 */
export function CoarseGrid({
  anchorSec,
  videoDuration,
  viewRange,
  onViewRangeChange,
  onFrameSelect,
  l2Frames,
  l3Frames,
  l2Loading,
  l3Loading,
  l2Progress,
  l3Progress,
  onRequestL3,
  clipTimestamps,
}: Props) {
  const [zoom, setZoom] = useState<LocalZoom>('L2')
  const containerRef = useRef<HTMLDivElement>(null)
  const [framesPerRow, setFramesPerRow] = useState(10)

  // CLIP 匹配快查集合
  const clipSet5 = useMemo(
    () => new Set(clipTimestamps?.map(t => Math.round(t / 5) * 5) ?? []),
    [clipTimestamps],
  )
  const clipSet1 = useMemo(
    () => new Set(clipTimestamps?.map(t => Math.round(t)) ?? []),
    [clipTimestamps],
  )

  // --- ResizeObserver: 计算每行帧数 ---
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 800
      setFramesPerRow(Math.max(3, Math.floor(w / FRAME_W)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 当前显示的帧
  const frames = zoom === 'L2' ? l2Frames : l3Frames
  const loading = zoom === 'L2' ? l2Loading : l3Loading
  const prog = zoom === 'L2' ? l2Progress : l3Progress

  // --- 缩放（trackpad pinch） ---
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let lastZoomTime = 0

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()

      // 防抖：macOS 双指缩放一次手势产生很多 wheel 事件
      const now = Date.now()
      if (now - lastZoomTime < 200) return
      lastZoomTime = now

      if (e.deltaY < 0 && zoom === 'L2') {
        // pinch out → zoom in → L2 → L3
        setZoom('L3')
        // 缩窗到 ±2min
        const center = (viewRange[0] + viewRange[1]) / 2
        const newRange: [number, number] = [
          Math.max(0, center - 2 * 60),
          Math.min(videoDuration, center + 2 * 60),
        ]
        onViewRangeChange(newRange)
        onRequestL3(center)
      } else if (e.deltaY > 0 && zoom === 'L3') {
        // pinch in → zoom out → L3 → L2
        setZoom('L2')
        // 扩窗到 ±10min
        const center = (viewRange[0] + viewRange[1]) / 2
        onViewRangeChange([
          Math.max(0, center - 10 * 60),
          Math.min(videoDuration, center + 10 * 60),
        ])
      }
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [zoom, viewRange, videoDuration, onViewRangeChange, onRequestL3])

  // --- 平移 ---
  const panLeft = useCallback(() => {
    const span = viewRange[1] - viewRange[0]
    const s = Math.max(0, viewRange[0] - PAN_STEP)
    onViewRangeChange([s, s + span])
  }, [viewRange, onViewRangeChange])

  const panRight = useCallback(() => {
    const span = viewRange[1] - viewRange[0]
    const e = Math.min(videoDuration, viewRange[1] + PAN_STEP)
    onViewRangeChange([e - span, e])
  }, [viewRange, videoDuration, onViewRangeChange])

  // --- CLIP 匹配判断 ---
  const isClipMatch = useCallback((ts: number): boolean => {
    if (!clipTimestamps?.length) return false
    if (zoom === 'L2') return clipSet5.has(Math.round(ts / 5) * 5)
    return clipSet1.has(Math.round(ts))
  }, [clipTimestamps, clipSet5, clipSet1, zoom])

  const zoomLabel = zoom === 'L2' ? '5s/帧' : '1s/帧'

  return (
    <div className="space-y-2" ref={containerRef}>
      {/* 视觉连线标记 — 指示"这是上方全局时间轴高亮区域的放大" */}
      <div className="flex items-center gap-2">
        <div className="w-4 border-t-2 border-primary/40" />
        <span className="text-[10px] text-muted-foreground">
          局部放大: {formatSec(viewRange[0])} ~ {formatSec(viewRange[1])}
        </span>
        <div className="flex-1 border-t border-dashed border-primary/20" />
      </div>

      {/* 控制栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-sm font-semibold">局部帧</h3>
        <Badge variant="secondary" className="text-xs">{zoomLabel}</Badge>
        <Badge variant="outline" className="text-xs">
          锚点: {formatSec(anchorSec)}
        </Badge>
        <div className="flex-1" />
        {zoom === 'L2' ? (
          <Button variant="outline" size="xs" onClick={() => {
            setZoom('L3')
            const c = (viewRange[0] + viewRange[1]) / 2
            onViewRangeChange([Math.max(0, c - 2 * 60), Math.min(videoDuration, c + 2 * 60)])
            onRequestL3(c)
          }}>
            <ZoomIn className="w-3 h-3" /> 放大到 1s
          </Button>
        ) : (
          <Button variant="outline" size="xs" onClick={() => {
            setZoom('L2')
            const c = (viewRange[0] + viewRange[1]) / 2
            onViewRangeChange([Math.max(0, c - 10 * 60), Math.min(videoDuration, c + 10 * 60)])
          }}>
            <ZoomOut className="w-3 h-3" /> 缩小到 5s
          </Button>
        )}
        <Button variant="outline" size="icon" className="h-7 w-7" onClick={panLeft} disabled={viewRange[0] <= 0}>
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <Button variant="outline" size="icon" className="h-7 w-7" onClick={panRight} disabled={viewRange[1] >= videoDuration}>
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      {/* 加载进度 */}
      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>{zoom} 加载中 {prog[0]}/{prog[1]}</span>
          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: prog[1] > 0 ? `${(prog[0] / prog[1]) * 100}%` : '0%' }}
            />
          </div>
        </div>
      )}

      {/* FlexBox 换行帧网格 */}
      {frames.length === 0 && loading ? (
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: Math.min(framesPerRow * 3, 30) }, (_, i) => (
            <div
              key={i}
              className="shrink-0 bg-muted rounded animate-pulse"
              style={{ width: FRAME_W, height: FRAME_H }}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {frames.map(frame => {
            const clipMatch = isClipMatch(frame.timestamp)
            return (
              <div
                key={frame.timestamp}
                className={`shrink-0 relative cursor-pointer rounded overflow-hidden transition-all
                  ${clipMatch
                    ? 'ring-2 ring-blue-500/60 border border-blue-500'
                    : 'border border-transparent hover:border-primary hover:ring-2 hover:ring-primary/30'
                  }`}
                style={{ width: FRAME_W, height: FRAME_H }}
                onClick={() => onFrameSelect(frame.timestamp)}
              >
                <img
                  src={frame.url}
                  className="w-full h-full object-cover"
                  loading="lazy"
                  draggable={false}
                />
                <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5 text-[10px] text-white font-mono flex justify-between">
                  <span>{formatSec(frame.timestamp)}</span>
                  {clipMatch && <span className="text-blue-300">CLIP</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        点击帧直接进入预览标注 | 触摸板双指缩放 5s/1s | 左右箭头扩大范围
      </p>
    </div>
  )
}
