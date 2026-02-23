import { useSearchStore } from '@/stores/searchStore'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { SkuSearchView } from '@/components/search/SkuSearchView'
import { DateSearchView } from '@/components/search/DateSearchView'

export default function SearchPage() {
  const { mode, setMode } = useSearchStore()

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-xl font-bold mb-4">检索</h1>

      <Tabs value={mode} onValueChange={(v) => setMode(v as 'sku' | 'date')}>
        <TabsList>
          <TabsTrigger value="sku">按 SKU</TabsTrigger>
          <TabsTrigger value="date">按日期</TabsTrigger>
        </TabsList>

        <TabsContent value="sku">
          <SkuSearchView />
        </TabsContent>

        <TabsContent value="date">
          <DateSearchView />
        </TabsContent>
      </Tabs>
    </div>
  )
}
