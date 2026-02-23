import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { Product } from '@/types'
import { ClickableImage } from '@/components/ui/image-preview'

interface Props {
  product: Product
  onAdd: (skuCode: string) => void
  disabled?: boolean
}

export function SkuCard({ product, onAdd, disabled }: Props) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-md bg-card border hover:bg-accent/30 transition-colors">
      {/* SKU 图片 */}
      <div className="w-12 h-12 rounded bg-muted flex items-center justify-center shrink-0 overflow-hidden">
        {product.image_path ? (
          <ClickableImage
            src={`/data/${product.image_path}`}
            alt={product.sku_code}
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="text-xs text-muted-foreground">无图</span>
        )}
      </div>

      {/* 信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium">{product.sku_code}</span>
          {product.lead_count > 0 && (
            <Badge variant="secondary" className="text-xs h-5">
              {product.lead_count} 线索
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {product.product_name || '(未命名)'}
        </p>
      </div>

      {/* 添加按钮 */}
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => onAdd(product.sku_code)}
        disabled={disabled}
      >
        <Plus className="w-4 h-4" />
      </Button>
    </div>
  )
}
