import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { XlsxDropZone } from '@/components/import/XlsxDropZone'
import { DiffPanel } from '@/components/import/DiffPanel'
import { useImportStore } from '@/stores/importStore'
import { uploadXlsx, fetchSnapshots, fetchDiffs, fetchMissingImages, importDownloadedImages, browserBatchDownload } from '@/api/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChevronDown, ChevronRight, AlertTriangle, FolderInput, Loader2, Globe } from 'lucide-react'
import type { ImportDiff, Snapshot } from '@/types'

export default function ImportPage() {
  const { snapshots, setSnapshots, currentDiffs, setCurrentDiffs, uploading, setUploading } = useImportStore()
  const [showHistory, setShowHistory] = useState(false)
  const [missingSkus, setMissingSkus] = useState<{ sku_code: string; product_name: string }[]>([])
  const [showMissing, setShowMissing] = useState(false)
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; unmatched: string[] } | null>(null)
  const [importing, setImporting] = useState(false)
  const [browserResult, setBrowserResult] = useState<{ queued: number; sku_codes: string[] } | null>(null)
  const [openingBrowser, setOpeningBrowser] = useState(false)
  const navigate = useNavigate()

  // 初始加载快照列表 + 缺图 SKU
  useEffect(() => {
    fetchSnapshots().then(setSnapshots).catch(console.error)
    fetchMissingImages().then(setMissingSkus).catch(console.error)
  }, [setSnapshots])

  const handleImportDownloaded = useCallback(async () => {
    setImporting(true)
    setImportResult(null)
    try {
      const res = await importDownloadedImages()
      setImportResult(res)
      // 刷新缺图列表
      const missing = await fetchMissingImages().catch(() => [])
      setMissingSkus(missing)
    } catch (err) {
      alert(`导入失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setImporting(false)
    }
  }, [])

  const handleBrowserBatch = useCallback(async () => {
    setOpeningBrowser(true)
    setBrowserResult(null)
    try {
      const res = await browserBatchDownload([], 10)
      setBrowserResult(res)
    } catch (err) {
      alert(`打开浏览器失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setOpeningBrowser(false)
    }
  }, [])

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true)
    try {
      const result = await uploadXlsx(file)
      setCurrentDiffs(result.diffs as unknown as ImportDiff[])
      // 刷新快照列表
      const snaps = await fetchSnapshots()
      setSnapshots(snaps)
      // 检查缺图 SKU
      const missing = await fetchMissingImages().catch(() => [])
      setMissingSkus(missing)
      if (missing.length > 0) setShowMissing(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '上传失败'
      alert(msg)
    } finally {
      setUploading(false)
    }
  }, [setCurrentDiffs, setSnapshots, setUploading])

  const handleViewSnapshot = useCallback(async (snapshot: Snapshot) => {
    const diffs = await fetchDiffs(snapshot.id)
    setCurrentDiffs(diffs)
  }, [setCurrentDiffs])

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <h1 className="text-xl font-bold">XLSX 导入</h1>

      <XlsxDropZone onUpload={handleUpload} uploading={uploading} />

      <div>
        <h2 className="text-lg font-semibold mb-3">变更明细</h2>
        <DiffPanel diffs={currentDiffs} />
      </div>

      {/* 缺图提醒 + 导入操作 */}
      <div className="rounded-lg border border-orange-300 bg-orange-50 dark:bg-orange-950/30 p-3 space-y-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-orange-500" />
          <span className="text-sm font-medium text-orange-700 dark:text-orange-400">
            {missingSkus.length > 0
              ? `有 ${missingSkus.length} 个 SKU 缺少商品图`
              : '所有 SKU 均有商品图'}
          </span>
          {missingSkus.length > 0 && (
            <Button
              variant="ghost" size="sm"
              className="text-orange-600 text-xs"
              onClick={() => setShowMissing(!showMissing)}
            >
              {showMissing ? '收起' : '查看'}
            </Button>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline" size="sm"
            onClick={handleImportDownloaded}
            disabled={importing}
          >
            {importing ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderInput className="w-3 h-3" />}
            导入已下载图片
          </Button>
          {missingSkus.length > 0 && (
            <Button
              variant="outline" size="sm"
              onClick={handleBrowserBatch}
              disabled={openingBrowser}
            >
              {openingBrowser ? <Loader2 className="w-3 h-3 animate-spin" /> : <Globe className="w-3 h-3" />}
              批量打开浏览器下载 (10)
            </Button>
          )}
        </div>

        {/* 导入结果 */}
        {importResult && (
          <div className="text-xs space-y-1 p-2 rounded bg-background border">
            <p>
              导入 <strong>{importResult.imported}</strong> 张，
              跳过 <strong>{importResult.skipped}</strong> 张（已存在）
              {importResult.unmatched.length > 0 && (
                <span>，未匹配 <strong>{importResult.unmatched.length}</strong> 个文件</span>
              )}
            </p>
            {importResult.unmatched.length > 0 && (
              <p className="text-muted-foreground truncate">
                未匹配: {importResult.unmatched.slice(0, 5).join(', ')}
                {importResult.unmatched.length > 5 && ` ...等${importResult.unmatched.length}个`}
              </p>
            )}
          </div>
        )}

        {/* 浏览器批量结果 */}
        {browserResult && (
          <div className="text-xs p-2 rounded bg-background border">
            <p>已打开 <strong>{browserResult.queued}</strong> 个标签页，油猴脚本将自动下载图片</p>
            <p className="text-muted-foreground mt-1">下载完成后点击"导入已下载图片"即可入库</p>
          </div>
        )}

        {/* 缺图 SKU 列表 */}
        {showMissing && missingSkus.length > 0 && (
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {missingSkus.map((s) => (
              <div key={s.sku_code} className="flex items-center gap-2 text-xs p-1.5 rounded bg-background border">
                <span className="font-mono font-medium">{s.sku_code}</span>
                <span className="text-muted-foreground truncate flex-1">{s.product_name || '(未命名)'}</span>
                <Button
                  variant="outline" size="sm" className="text-xs h-6 px-2"
                  onClick={() => navigate(`/search?sku=${s.sku_code}`)}
                >
                  去上传
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowHistory(!showHistory)}
          className="gap-1"
        >
          {showHistory ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          历史导入 ({snapshots.length})
        </Button>

        {showHistory && (
          <ScrollArea className="h-[300px] mt-2">
            <div className="space-y-2">
              {snapshots.map((snap) => (
                <div
                  key={snap.id}
                  className="flex items-center gap-3 p-3 rounded-md bg-card border cursor-pointer hover:bg-accent/50"
                  onClick={() => handleViewSnapshot(snap)}
                >
                  <Badge variant="outline" className="text-xs">#{snap.id}</Badge>
                  <span className="text-sm font-medium flex-1 truncate">{snap.file_name}</span>
                  <span className="text-xs text-muted-foreground">{snap.row_count} 行</span>
                  <span className="text-xs text-muted-foreground">{snap.imported_at}</span>
                </div>
              ))}
              {snapshots.length === 0 && (
                <p className="text-muted-foreground text-sm py-4">暂无导入记录</p>
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  )
}
