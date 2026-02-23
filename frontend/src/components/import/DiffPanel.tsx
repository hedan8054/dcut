import { useMemo } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ImportDiff } from '@/types'

interface Props {
  diffs: ImportDiff[]
}

const DIFF_TABS = [
  { value: 'new_sku', label: '新增SKU' },
  { value: 'new_lead', label: '新增线索' },
  { value: 'status_change', label: '状态变更' },
  { value: 'listing_change', label: '链接变更' },
] as const

export function DiffPanel({ diffs }: Props) {
  const grouped = useMemo(() => {
    const map: Record<string, ImportDiff[]> = {
      new_sku: [], new_lead: [], status_change: [], listing_change: [],
    }
    for (const d of diffs) {
      if (map[d.diff_type]) map[d.diff_type].push(d)
    }
    return map
  }, [diffs])

  if (diffs.length === 0) {
    return (
      <p className="text-muted-foreground text-sm py-4">
        暂无变更记录。上传 xlsx 文件后将显示变更明细。
      </p>
    )
  }

  return (
    <Tabs defaultValue="new_sku">
      <TabsList>
        {DIFF_TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} className="gap-1.5">
            {tab.label}
            {grouped[tab.value].length > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-xs">
                {grouped[tab.value].length}
              </Badge>
            )}
          </TabsTrigger>
        ))}
      </TabsList>

      {DIFF_TABS.map((tab) => (
        <TabsContent key={tab.value} value={tab.value}>
          <ScrollArea className="h-[400px]">
            {grouped[tab.value].length === 0 ? (
              <p className="text-muted-foreground text-sm py-4">无{tab.label}</p>
            ) : (
              <div className="space-y-2">
                {grouped[tab.value].map((d) => (
                  <DiffItem key={d.id} diff={d} />
                ))}
              </div>
            )}
          </ScrollArea>
        </TabsContent>
      ))}
    </Tabs>
  )
}

function DiffItem({ diff }: { diff: ImportDiff }) {
  const detail = useMemo(() => {
    try { return JSON.parse(diff.detail_json) }
    catch { return {} }
  }, [diff.detail_json])

  return (
    <div className="flex items-start gap-3 p-3 rounded-md bg-card border">
      <Badge variant="outline" className="shrink-0 font-mono text-xs">
        {diff.sku_code}
      </Badge>
      <div className="text-sm space-y-0.5">
        {diff.diff_type === 'new_sku' && (
          <>
            <p>{detail.product_name || '(未命名)'}</p>
            {detail.price != null && (
              <p className="text-muted-foreground">价格: ¥{detail.price}</p>
            )}
          </>
        )}
        {diff.diff_type === 'new_lead' && (
          <>
            <p>{detail.date || '(无日期)'} {detail.time_points?.join(', ') || ''}</p>
            <p className="text-muted-foreground text-xs">{detail.raw_fragment}</p>
            <Badge variant={
              detail.confidence === 'HIGH' ? 'default' :
              detail.confidence === 'MEDIUM' ? 'secondary' : 'outline'
            } className="text-xs">
              {detail.confidence}
            </Badge>
          </>
        )}
        {diff.diff_type === 'status_change' && (
          <p>
            <span className="text-muted-foreground">{detail.old_status || '(空)'}</span>
            {' → '}
            <span className="font-medium">{detail.new_status || '(空)'}</span>
          </p>
        )}
        {diff.diff_type === 'listing_change' && (
          <p className="text-xs text-muted-foreground break-all">
            链接变更
          </p>
        )}
      </div>
    </div>
  )
}
