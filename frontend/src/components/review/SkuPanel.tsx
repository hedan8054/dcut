import { useCallback, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SkuPanelItem } from './SkuPanelItem'
import type { EnrichedPlanItem, SkuImage, SessionGroup, VideoControl, VideoRegistry } from '@/types'

interface Props {
  planItems: EnrichedPlanItem[]
  planLoading: boolean
  skuImages: SkuImage[]
  sessions: SessionGroup[]
  currentSkuCode: string
  expandedSkuCode: string
  /** 点帧后自动 seek 到的秒数 */
  seekTimestamp: number
  /** 当前选中的场次 */
  currentSession: SessionGroup | null
  /** 当前视频信息 */
  videoInfo: VideoRegistry | null
  /** 切换场次 */
  onSelectSession: (session: SessionGroup) => void
  /** 视频控制 ref — 暴露 play/pause 给 ReviewPage */
  videoControlRef?: React.MutableRefObject<VideoControl | null>
  /** 更新当前视频信息（如代理生成后） */
  onVideoInfoUpdate: (video: VideoRegistry) => void
  onSelectSku: (code: string) => void
  onToggleExpand: (code: string) => void
}

const MIN_WIDTH = 240
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 300
const LS_KEY = 'review-panel-width'

function getSavedWidth(): number {
  try {
    const v = localStorage.getItem(LS_KEY)
    if (v) {
      const n = Number(v)
      if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n
    }
  } catch { /* ignore */ }
  return DEFAULT_WIDTH
}

export function SkuPanel({
  planItems, planLoading, skuImages, sessions,
  currentSkuCode, expandedSkuCode, seekTimestamp,
  currentSession, videoInfo, videoControlRef, onSelectSession,
  onVideoInfoUpdate,
  onSelectSku, onToggleExpand,
}: Props) {
  const [width, setWidth] = useState(getSavedWidth)
  const draggingRef = useRef(false)

  // 拖拽调整宽度
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    const startX = e.clientX
    const startW = width

    const onMove = (ev: MouseEvent) => {
      const newW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + (ev.clientX - startX)))
      setWidth(newW)
    }
    const onUp = () => {
      draggingRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      // 持久化
      setWidth(w => {
        localStorage.setItem(LS_KEY, String(w))
        return w
      })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [width])

  // 展开时只显示展开的那个 SKU
  const isExpanded = !!expandedSkuCode
  const visibleItems = isExpanded
    ? planItems.filter(item => item.sku_code === expandedSkuCode)
    : planItems

  return (
    <div
      className="relative flex shrink-0 border-r border-rv-border bg-rv-panel"
      style={{ width }}
    >
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header: 展开时隐藏 */}
        {!isExpanded && (
          <div className="p-3 border-b border-rv-border">
            <h2 className="text-sm font-semibold">今日计划</h2>
            <p className="text-[11px] text-muted-foreground">
              {planItems.length > 0
                ? `${planItems.length} 个 SKU · 点击展开编辑`
                : '未创建'}
            </p>
          </div>
        )}

        {/* SKU 列表 */}
        {planLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : planItems.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground text-center">
            今日计划为空，请先在选品页创建计划
          </div>
        ) : isExpanded ? (
          /* 展开态: 单个 item 占满面板 */
          <div className="flex-1 flex flex-col min-h-0">
            {visibleItems.map((item) => (
              <SkuPanelItem
                key={item.id}
                item={item}
                isSelected={true}
                isExpanded={true}
                skuImages={skuImages}
                sessions={sessions}
                seekTimestamp={seekTimestamp}
                currentSession={currentSession}
                videoInfo={videoInfo}
                videoControlRef={videoControlRef}
                onSelectSession={onSelectSession}
                onVideoInfoUpdate={onVideoInfoUpdate}
                onSelect={onSelectSku}
                onToggleExpand={onToggleExpand}
              />
            ))}
          </div>
        ) : (
          /* 折叠态: 可滚动列表 */
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {visibleItems.map((item) => (
                <SkuPanelItem
                  key={item.id}
                  item={item}
                  isSelected={currentSkuCode === item.sku_code}
                  isExpanded={false}
                  skuImages={[]}
                  sessions={[]}
                  seekTimestamp={0}
                  currentSession={null}
                  videoInfo={null}
                  onSelectSession={() => {}}
                  onVideoInfoUpdate={() => {}}
                  onSelect={onSelectSku}
                  onToggleExpand={onToggleExpand}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* 拖拽手柄 */}
      <div
        className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-rv-accent/40 active:bg-rv-accent/60 transition-colors z-10"
        onMouseDown={handleMouseDown}
      />
    </div>
  )
}
