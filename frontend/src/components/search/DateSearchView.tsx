import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Plus, Eye } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { searchByDate, fetchTodayPlan, createPlan, addPlanItems } from '@/api/client'
import { ClickableImage } from '@/components/ui/image-preview'
import type { DateSearchResult } from '@/types'

function localDateISO(): string {
  // 使用本地日期（而非 UTC toISOString）避免跨零点时“今天”偏到昨天
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

export function DateSearchView() {
  const [date, setDate] = useState(localDateISO)
  const [result, setResult] = useState<DateSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [addedSkus, setAddedSkus] = useState<Set<string>>(new Set())
  const navigate = useNavigate()

  // 加入今日计划
  const handleAddToPlan = useCallback(async (skuCode: string) => {
    const todayPlan = await fetchTodayPlan()
    let planId = todayPlan?.id
    if (!planId) {
      const plan = await createPlan()
      planId = plan.id
    }
    await addPlanItems(planId, [skuCode])
    setAddedSkus((prev) => new Set(prev).add(skuCode))
  }, [])

  const handleSearch = useCallback(async () => {
    if (!date) return
    setLoading(true)
    try {
      const r = await searchByDate(date)
      setResult(r)
    } catch (err) {
      console.error(err)
      setResult(null)
    } finally {
      setLoading(false)
    }
  }, [date])

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <Button onClick={handleSearch} disabled={loading}>
          <Search className="w-4 h-4" />
          查询
        </Button>
      </div>

      {result && (
        <ScrollArea className="h-[calc(100vh-220px)]">
          <div className="space-y-3">
            <p className="text-sm font-semibold">
              {result.date} 共 {result.skus.length} 个 SKU
            </p>

            {result.skus.map((entry) => {
              const timePointsAll = entry.leads.flatMap((l) => {
                try { return JSON.parse(l.time_points_json) as string[] } catch { return [] }
              })

              return (
                <div key={entry.sku_code} className="p-3 rounded-lg bg-card border">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded bg-muted shrink-0 overflow-hidden">
                      {entry.image_path ? (
                        <ClickableImage src={`/data/${entry.image_path}`} className="w-full h-full object-cover" />
                      ) : null}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium">{entry.sku_code}</span>
                        <Badge variant="secondary" className="text-xs">
                          {entry.leads.length} 线索
                        </Badge>
                        {entry.verified_count > 0 && (
                          <Badge variant="default" className="text-xs">
                            {entry.verified_count} 真值
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {entry.product_name || '(未命名)'}
                      </p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Button
                        variant="outline" size="sm" className="text-xs h-7"
                        disabled={addedSkus.has(entry.sku_code)}
                        onClick={() => handleAddToPlan(entry.sku_code)}
                      >
                        <Plus className="w-3 h-3" />
                        {addedSkus.has(entry.sku_code) ? '已加入' : '计划'}
                      </Button>
                      <Button
                        variant="ghost" size="sm" className="text-xs h-7"
                        onClick={() => navigate(`/review?sku=${entry.sku_code}`)}
                      >
                        <Eye className="w-3 h-3" /> 审核
                      </Button>
                    </div>
                  </div>

                  {timePointsAll.length > 0 && (
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {timePointsAll.map((tp, i) => (
                        <Badge key={i} variant="outline" className="text-xs font-mono">{tp}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

            {result.skus.length === 0 && (
              <p className="text-muted-foreground text-sm text-center py-8">
                当天无线索记录
              </p>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
