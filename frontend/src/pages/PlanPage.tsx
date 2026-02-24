import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlanStore } from '@/stores/planStore'
import {
  fetchAllPlansEnriched,
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
  Plus,
  Trash2,
} from 'lucide-react'
import type { EnrichedPlan, EnrichedPlanItem } from '@/types'
import { localToday } from '@/lib/format'

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

/** 计算计划的完成进度 */
function planProgress(plan: EnrichedPlan) {
  if (plan.items.length === 0) return { done: 0, total: 0, pct: 0 }
  const done = plan.items.filter((i) => i.status === 'done').length
  return { done, total: plan.items.length, pct: Math.round((done / plan.items.length) * 100) }
}

/** 格式化日期为简短形式 */
function shortDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00')
  const month = d.getMonth() + 1
  const day = d.getDate()
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  const wd = weekdays[d.getDay()]
  return { display: `${month}.${day}`, weekday: `周${wd}`, full: dateStr }
}

/** 判断是否是今天 */
function isToday(dateStr: string) {
  return dateStr === localToday()
}

export default function PlanPage() {
  const { setPlan } = usePlanStore()
  const navigate = useNavigate()

  // 所有历史计划
  const [allPlans, setAllPlans] = useState<EnrichedPlan[]>([])
  // 当前选中的计划
  const [activePlan, setActivePlan] = useState<EnrichedPlan | null>(null)
  const [skuText, setSkuText] = useState('')
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)

  // 加载所有计划
  const loadAllPlans = useCallback(async () => {
    try {
      const plans = await fetchAllPlansEnriched()
      setAllPlans(plans)
      return plans
    } catch (err) {
      console.error('加载计划列表失败', err)
      return []
    }
  }, [])

  // 加载某个计划的最新数据（通过重新拉全部列表）
  const refreshAndSelect = useCallback(async (planId?: number) => {
    const plans = await loadAllPlans()
    if (planId) {
      const target = plans.find((p) => p.id === planId)
      if (target) {
        setActivePlan(target)
        setPlan({ id: target.id, plan_date: target.plan_date, status: target.status, items: target.items })
        return
      }
    }
    // 默认选中今日，没有今日则选第一个
    const today = localToday()
    const todayPlan = plans.find((p) => p.plan_date === today)
    const selected = todayPlan ?? plans[0] ?? null
    setActivePlan(selected)
    if (selected) {
      setPlan({ id: selected.id, plan_date: selected.plan_date, status: selected.status, items: selected.items })
    }
  }, [loadAllPlans, setPlan])

  // 初始化
  useEffect(() => {
    refreshAndSelect().finally(() => setInitialLoading(false))
  }, [refreshAndSelect])

  // 批量添加 SKU（到今日计划）
  const handleBatchAdd = useCallback(async () => {
    const codes = parseSkuInput(skuText)
    if (codes.length === 0) return

    setLoading(true)
    try {
      // 确保今日计划存在
      const today = localToday()
      let todayPlan = allPlans.find((p) => p.plan_date === today)
      let planId = todayPlan?.id
      if (!planId) {
        const newPlan = await createPlan()
        planId = newPlan.id
      }

      await addPlanItems(planId, codes)
      await refreshAndSelect(planId)
      setSkuText('')
    } catch (err) {
      console.error('添加失败', err)
      alert(`添加失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setLoading(false)
    }
  }, [skuText, allPlans, refreshAndSelect])

  // 切换状态
  const handleCycleStatus = useCallback(
    async (item: EnrichedPlanItem) => {
      if (!activePlan) return
      const next = nextStatus(item.status)
      try {
        await updatePlanItem(activePlan.id, item.id, { status: next })
        await refreshAndSelect(activePlan.id)
      } catch (err) {
        console.error('更新状态失败', err)
      }
    },
    [activePlan, refreshAndSelect],
  )

  // 删除项目
  const handleRemove = useCallback(
    async (itemId: number) => {
      if (!activePlan) return
      try {
        await deletePlanItem(activePlan.id, itemId)
        await refreshAndSelect(activePlan.id)
      } catch (err) {
        console.error('删除失败', err)
      }
    },
    [activePlan, refreshAndSelect],
  )

  // 批量下载缺图
  const handleBatchDownloadImages = useCallback(async () => {
    const allItems = activePlan?.items ?? []
    const missingSkus = allItems
      .filter((i) => !i.image_path && i.promo_link)
      .map((i) => i.sku_code)
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
  }, [activePlan])

  // 导入已下载的图片
  const handleImportImages = useCallback(async () => {
    setLoading(true)
    try {
      const res = await importDownloadedImages()
      alert(`导入 ${res.imported} 张，跳过 ${res.skipped} 张`)
      if (activePlan) await refreshAndSelect(activePlan.id)
    } catch (err) {
      alert(`导入失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setLoading(false)
    }
  }, [activePlan, refreshAndSelect])

  const items = activePlan?.items ?? []
  const missingImageCount = items.filter((i) => !i.image_path).length
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
    <div className="flex h-[calc(100vh-3rem)] overflow-hidden">
      {/* ===== 左侧：计划列表 ===== */}
      <div className="w-56 shrink-0 border-r flex flex-col bg-muted/20">
        <div className="p-3 border-b">
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <CalendarDays className="w-4 h-4" />
            全部计划
          </h2>
        </div>
        <div className="flex-1 overflow-y-auto">
          {allPlans.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground text-center">暂无计划</div>
          ) : (
            allPlans.map((plan) => {
              const { display, weekday } = shortDate(plan.plan_date)
              const { total, pct } = planProgress(plan)
              const isActive = activePlan?.id === plan.id
              const today = isToday(plan.plan_date)
              return (
                <button
                  key={plan.id}
                  className={`w-full text-left px-3 py-2.5 border-b border-border/50 transition-colors hover:bg-muted/60 ${
                    isActive ? 'bg-muted border-l-2 border-l-primary' : ''
                  }`}
                  onClick={() => {
                    setActivePlan(plan)
                    setPlan({ id: plan.id, plan_date: plan.plan_date, status: plan.status, items: plan.items })
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm font-medium">
                      {display}
                      <span className="text-muted-foreground font-normal ml-1 text-xs">{weekday}</span>
                    </span>
                    {today && (
                      <Badge variant="default" className="text-[10px] px-1.5 py-0">今天</Badge>
                    )}
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-muted-foreground">{total} 个 SKU</span>
                    <span className="text-xs text-muted-foreground">
                      {total > 0 ? `${pct}%` : '—'}
                    </span>
                  </div>
                  {/* 进度条 */}
                  {total > 0 && (
                    <div className="mt-1.5 h-1 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* ===== 右侧：计划详情 ===== */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-6 space-y-6">
          {/* 标题 + 操作按钮 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">
                {activePlan ? (
                  <>
                    {activePlan.plan_date}
                    {isToday(activePlan.plan_date) && (
                      <Badge variant="default" className="ml-2 text-xs">今天</Badge>
                    )}
                    <span className="text-muted-foreground font-normal ml-2 text-sm">
                      {items.length} 个 SKU
                    </span>
                  </>
                ) : (
                  '选择一个计划'
                )}
              </h1>
            </div>
            <div className="flex items-center gap-2">
              {activePlan && missingImageCount > 0 && (
                <>
                  <Button variant="outline" size="sm" onClick={handleBatchDownloadImages} disabled={loading}>
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    下载缺图 ({missingImageCount})
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleImportImages} disabled={loading}>
                    导入已下载图片
                  </Button>
                </>
              )}
              {items.length > 0 && (
                <Button size="sm" onClick={() => navigate('/review')}>
                  <Play className="w-4 h-4" />
                  开始审核
                </Button>
              )}
            </div>
          </div>

          {/* 批量输入区（始终显示，添加到今日计划） */}
          <div className="space-y-3 rounded-lg border p-4 bg-muted/30">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <Plus className="w-4 h-4" />
              批量添加 SKU 到今日计划
            </label>
            <textarea
              className="w-full min-h-[80px] rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
              placeholder={"粘贴款号，支持逗号、中文逗号、换行、空格分隔\n例如: YT001, YT002, YT003"}
              value={skuText}
              onChange={(e) => setSkuText(e.target.value)}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {parsedCount > 0 ? `已识别 ${parsedCount} 个款号` : '输入款号后点击按钮添加'}
              </span>
              <Button size="sm" onClick={handleBatchAdd} disabled={parsedCount === 0 || loading}>
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                创建/更新今日计划
              </Button>
            </div>
          </div>

          {/* 计划项列表 */}
          {!activePlan ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <ClipboardList className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">从左侧选择一个计划查看</p>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <ClipboardList className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">该计划为空</p>
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

                    {/* 删除按钮（仅今日计划可删） */}
                    {isToday(activePlan.plan_date) && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => handleRemove(item.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
