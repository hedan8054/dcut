import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlanStore } from '@/stores/planStore'
import {
  fetchTodayPlan,
  createPlan,
  addPlanItems,
  updatePlanItem,
  deletePlanItem,
  browserBatchDownload,
  importDownloadedImages,
} from '@/api/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ClickableImage } from '@/components/ui/image-preview'
import {
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Download,
  ExternalLink,
  ImageOff,
  Loader2,
  Play,
  Trash2,
} from 'lucide-react'
import type { EnrichedPlan, EnrichedPlanItem } from '@/types'

/** 将用户粘贴的文本解析为 SKU 列表（支持逗号、中文逗号、换行、空格分隔） */
function parseSkuInput(raw: string): string[] {
  return raw
    .split(/[,，\n\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
}

/** 状态流转顺序 */
const STATUS_CYCLE = ['pending', 'in_progress', 'done'] as const
type ItemStatus = (typeof STATUS_CYCLE)[number]

function nextStatus(current: string): ItemStatus {
  const idx = STATUS_CYCLE.indexOf(current as ItemStatus)
  return STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]
}

/** 状态对应的 badge 样式 */
function statusBadge(status: string) {
  switch (status) {
    case 'pending':
      return { label: '待处理', variant: 'outline' as const }
    case 'in_progress':
      return { label: '进行中', variant: 'secondary' as const }
    case 'done':
      return { label: '已完成', variant: 'default' as const }
    default:
      return { label: status, variant: 'outline' as const }
  }
}

export default function PlanPage() {
  const { plan, setPlan } = usePlanStore()
  const [skuText, setSkuText] = useState('')
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const navigate = useNavigate()

  // 类型适配：store 里存的是 Plan，但 fetchTodayPlan 返回 EnrichedPlan
  // 这里用 enrichedPlan 单独维护带详情的计划
  const [enrichedPlan, setEnrichedPlan] = useState<EnrichedPlan | null>(null)

  // 加载今日计划
  const loadPlan = useCallback(async () => {
    try {
      const ep = await fetchTodayPlan()
      setEnrichedPlan(ep)
      if (ep) {
        setPlan({ id: ep.id, plan_date: ep.plan_date, status: ep.status, items: ep.items })
      } else {
        setPlan(null)
      }
    } catch (err) {
      console.error('加载计划失败', err)
    } finally {
      setInitialLoading(false)
    }
  }, [setPlan])

  useEffect(() => {
    loadPlan()
  }, [loadPlan])

  // 批量添加 SKU
  const handleBatchAdd = useCallback(async () => {
    const codes = parseSkuInput(skuText)
    if (codes.length === 0) return

    setLoading(true)
    try {
      // 确保今日计划存在
      let planId = enrichedPlan?.id
      if (!planId) {
        const newPlan = await createPlan()
        planId = newPlan.id
      }

      // 批量添加
      await addPlanItems(planId, codes)

      // 重新拉取带详情的计划
      await loadPlan()

      // 清空输入
      setSkuText('')
    } catch (err) {
      console.error('添加失败', err)
      alert(`添加失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setLoading(false)
    }
  }, [skuText, enrichedPlan, loadPlan])

  // 切换状态
  const handleCycleStatus = useCallback(
    async (item: EnrichedPlanItem) => {
      if (!enrichedPlan) return
      const next = nextStatus(item.status)
      try {
        await updatePlanItem(enrichedPlan.id, item.id, { status: next })
        await loadPlan()
      } catch (err) {
        console.error('更新状态失败', err)
      }
    },
    [enrichedPlan, loadPlan],
  )

  // 删除项目
  const handleRemove = useCallback(
    async (itemId: number) => {
      if (!enrichedPlan) return
      try {
        await deletePlanItem(enrichedPlan.id, itemId)
        await loadPlan()
      } catch (err) {
        console.error('删除失败', err)
      }
    },
    [enrichedPlan, loadPlan],
  )

  // 批量下载缺图 SKU 的商品图（只下载计划中缺图的）
  const handleBatchDownloadImages = useCallback(async () => {
    const allItems = enrichedPlan?.items ?? []
    const missingSkus = allItems
      .filter(i => !i.image_path && i.promo_link)
      .map(i => i.sku_code)
    if (missingSkus.length === 0) {
      alert('没有需要下载图片的 SKU（都有图或没有推广链接）')
      return
    }
    setLoading(true)
    try {
      const res = await browserBatchDownload(missingSkus)
      alert(`已打开 ${res.queued} 个标签页，等待油猴脚本下载图片...\n下载完成后点击"导入已下载图片"`)
    } catch (err) {
      alert(`下载失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setLoading(false)
    }
  }, [enrichedPlan])

  // 导入已下载的图片
  const handleImportImages = useCallback(async () => {
    setLoading(true)
    try {
      const res = await importDownloadedImages()
      alert(`导入 ${res.imported} 张，跳过 ${res.skipped} 张`)
      await loadPlan()
    } catch (err) {
      alert(`导入失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setLoading(false)
    }
  }, [loadPlan])

  const items = enrichedPlan?.items ?? []
  const missingImageCount = items.filter(i => !i.image_path).length
  const parsedCount = parseSkuInput(skuText).length

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        加载中...
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      {/* 标题 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-5 h-5" />
          <h1 className="text-lg font-semibold">
            今日计划
            {enrichedPlan && (
              <span className="text-muted-foreground font-normal ml-2 text-sm">
                {enrichedPlan.plan_date} · {items.length} 个 SKU
              </span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {missingImageCount > 0 && (
            <>
              <Button variant="outline" onClick={handleBatchDownloadImages} disabled={loading}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                下载缺图 ({missingImageCount})
              </Button>
              <Button variant="outline" onClick={handleImportImages} disabled={loading}>
                导入已下载图片
              </Button>
            </>
          )}
          {items.length > 0 && (
            <Button onClick={() => navigate('/review')}>
              <Play className="w-4 h-4" />
              开始审核
            </Button>
          )}
        </div>
      </div>

      {/* 批量输入区 */}
      <div className="space-y-3 rounded-lg border p-4 bg-muted/30">
        <label className="text-sm font-medium">批量添加 SKU</label>
        <textarea
          className="w-full min-h-[100px] rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
          placeholder={"粘贴款号，支持逗号、中文逗号、换行、空格分隔\n例如: YT001, YT002, YT003\n或每行一个:\nYT001\nYT002"}
          value={skuText}
          onChange={(e) => setSkuText(e.target.value)}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {parsedCount > 0 ? `已识别 ${parsedCount} 个款号` : '输入款号后点击按钮添加'}
          </span>
          <Button
            onClick={handleBatchAdd}
            disabled={parsedCount === 0 || loading}
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            创建/更新今日计划
          </Button>
        </div>
      </div>

      {/* 计划列表 */}
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <ClipboardList className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">今日计划为空，请在上方粘贴款号创建计划</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const badge = statusBadge(item.status)
            return (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/40 transition-colors"
              >
                {/* 缩略图 */}
                <div className="w-12 h-12 shrink-0 rounded overflow-hidden bg-muted">
                  {item.image_path ? (
                    <ClickableImage
                      src={`/data/${item.image_path}`}
                      alt={item.product_name ?? item.sku_code}
                      className="w-12 h-12 object-cover"
                      fallback={
                        <div className="w-12 h-12 flex items-center justify-center text-muted-foreground">
                          <ImageOff className="w-5 h-5" />
                        </div>
                      }
                    />
                  ) : (
                    <div className="w-12 h-12 flex items-center justify-center text-muted-foreground">
                      <ImageOff className="w-5 h-5" />
                    </div>
                  )}
                </div>

                {/* SKU 信息 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium">{item.sku_code}</span>
                    {item.product_name && (
                      <span className="text-sm text-muted-foreground truncate">
                        {item.product_name}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                    <span>线索 {item.lead_count}</span>
                    <span className="flex items-center gap-0.5">
                      {item.verified_count > 0 && (
                        <CheckCircle2 className="w-3 h-3 text-green-500" />
                      )}
                      已审 {item.verified_count}
                    </span>
                    {item.price != null && <span>¥{item.price}</span>}
                  </div>
                </div>

                {/* 推广链接 */}
                {item.promo_link && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-blue-500 shrink-0"
                    onClick={() => window.open(item.promo_link!, '_blank')}
                    title="打开商品页面"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </Button>
                )}

                {/* 状态 badge — 点击切换 */}
                <Badge
                  variant={badge.variant}
                  className="cursor-pointer select-none"
                  onClick={() => handleCycleStatus(item)}
                >
                  {badge.label}
                </Badge>

                {/* 删除按钮 */}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => handleRemove(item.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
