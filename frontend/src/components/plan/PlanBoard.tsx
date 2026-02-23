import { X, GripVertical, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { PlanItem } from '@/types'

interface Props {
  items: PlanItem[]
  onRemove: (itemId: number) => void
  onStatusChange: (itemId: number, status: string) => void
  onReview?: (skuCode: string) => void
}

const STATUS_COLORS: Record<string, 'outline' | 'secondary' | 'default'> = {
  pending: 'outline',
  in_progress: 'secondary',
  done: 'default',
}

const STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  in_progress: '进行中',
  done: '已完成',
}

export function PlanBoard({ items, onRemove, onStatusChange, onReview }: Props) {
  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm border-2 border-dashed rounded-lg">
        从左侧选择 SKU 加入计划
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {items.map((item, _idx) => (
        <div
          key={item.id}
          className="flex items-center gap-2 p-3 rounded-md bg-card border group"
        >
          <GripVertical className="w-4 h-4 text-muted-foreground cursor-grab" />

          <span className="font-mono text-sm font-medium flex-1">{item.sku_code}</span>

          <Badge
            variant={STATUS_COLORS[item.status] || 'outline'}
            className="cursor-pointer text-xs"
            onClick={() => {
              const next = item.status === 'pending' ? 'in_progress'
                : item.status === 'in_progress' ? 'done' : 'pending'
              onStatusChange(item.id, next)
            }}
          >
            {STATUS_LABELS[item.status] || item.status}
          </Badge>

          {onReview && (
            <Button
              variant="ghost"
              size="sm"
              className="opacity-0 group-hover:opacity-100 transition-opacity text-xs h-6 px-2"
              onClick={() => onReview(item.sku_code)}
            >
              <Eye className="w-3 h-3" /> 审核
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => onRemove(item.id)}
          >
            <X className="w-3 h-3" />
          </Button>
        </div>
      ))}
    </div>
  )
}
