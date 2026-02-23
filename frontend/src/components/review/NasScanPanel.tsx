import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, Plus, Video, CheckCircle2, FolderSearch, HardDrive } from 'lucide-react'
import {
  scanNasVideos, registerAllScanned,
  populateSegments, batchGenerateProxy, fetchProxyStatus, scanProxyDirectory,
} from '@/api/client'

/** NAS 视频一键扫描 + 代理管理面板 */
export function NasScanPanel({ onRegistered }: { onRegistered: () => void }) {
  const [scanning, setScanning] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [populating, setPopulating] = useState(false)
  const [proxyGenerating, setProxyGenerating] = useState(false)
  const [scanResult, setScanResult] = useState<{ total: number; registered: number; unregistered: number } | null>(null)
  const [regResult, setRegResult] = useState<string>('')
  const [proxyStatus, setProxyStatus] = useState<{ total: number; none: number; queued: number; generating: number; done: number; failed: number } | null>(null)

  const handleScan = async () => {
    setScanning(true)
    setScanResult(null)
    setRegResult('')
    try {
      const res = await scanNasVideos()
      setScanResult({ total: res.total, registered: res.registered, unregistered: res.unregistered })
    } catch (err) {
      alert(`扫描失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setScanning(false)
    }
  }

  const handleRegisterAll = async () => {
    setRegistering(true)
    try {
      const res = await registerAllScanned()
      setRegResult(`登记 ${res.registered} 个, 分段 ${res.segments} 条`)
      onRegistered()
      const scan = await scanNasVideos()
      setScanResult({ total: scan.total, registered: scan.registered, unregistered: scan.unregistered })
    } catch (err) {
      alert(`登记失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setRegistering(false)
    }
  }

  const handlePopulateSegments = async () => {
    setPopulating(true)
    try {
      const res = await populateSegments()
      setRegResult(`补充分段 ${res.populated} 个`)
    } catch (err) {
      alert(`补充分段失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setPopulating(false)
    }
  }

  const handleCheckProxy = async () => {
    try {
      const res = await fetchProxyStatus()
      setProxyStatus(res)
    } catch (err) {
      alert(`查询失败: ${err instanceof Error ? err.message : err}`)
    }
  }

  const handleBatchProxy = async () => {
    setProxyGenerating(true)
    try {
      const res = await batchGenerateProxy([], true)
      setRegResult(`已排队 ${res.queued} 个代理生成任务`)
      handleCheckProxy()
    } catch (err) {
      alert(`代理生成失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setProxyGenerating(false)
    }
  }

  return (
    <div className="space-y-2">
      {/* 扫描 + 登记 */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="outline" size="sm" onClick={handleScan} disabled={scanning}>
          {scanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderSearch className="w-3 h-3" />}
          扫描 NAS
        </Button>

        {scanResult && (
          <>
            <div className="flex items-center gap-2 text-xs">
              <HardDrive className="w-3 h-3 text-muted-foreground" />
              <span>{scanResult.total} 个场次</span>
              <span className="text-green-500">{scanResult.registered} 已登记</span>
              {scanResult.unregistered > 0 && (
                <span className="text-orange-500">{scanResult.unregistered} 未登记</span>
              )}
            </div>

            {scanResult.unregistered > 0 && (
              <Button size="sm" onClick={handleRegisterAll} disabled={registering}>
                {registering ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                一键登记 {scanResult.unregistered} 个
              </Button>
            )}
          </>
        )}

        {regResult && (
          <Badge variant="default" className="text-xs">
            <CheckCircle2 className="w-3 h-3" />
            {regResult}
          </Badge>
        )}
      </div>

      {/* 分段 + 代理 */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="outline" size="sm" onClick={handlePopulateSegments} disabled={populating}>
          {populating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Video className="w-3 h-3" />}
          补充分段信息
        </Button>

        <Button variant="outline" size="sm" onClick={handleCheckProxy}>
          查看代理状态
        </Button>

        <Button variant="outline" size="sm" onClick={async () => {
          try {
            const res = await scanProxyDirectory()
            setRegResult(`扫描代理: 匹配 ${res.matched} 个${res.unmatched.length > 0 ? `, ${res.unmatched.length} 个未匹配` : ''}`)
            handleCheckProxy()
          } catch (err) {
            alert(`扫描代理失败: ${err instanceof Error ? err.message : err}`)
          }
        }}>
          <FolderSearch className="w-3 h-3" />
          扫描代理目录
        </Button>

        {proxyStatus && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-green-500">{proxyStatus.done} 已完成</span>
            {proxyStatus.generating > 0 && <span className="text-blue-500">{proxyStatus.generating} 生成中</span>}
            {proxyStatus.queued > 0 && <span className="text-amber-500">{proxyStatus.queued} 排队</span>}
            <span className="text-muted-foreground">{proxyStatus.none} 待生成</span>
            {proxyStatus.failed > 0 && <span className="text-red-500">{proxyStatus.failed} 失败</span>}
          </div>
        )}

        {proxyStatus && (proxyStatus.none > 0 || proxyStatus.failed > 0) && (
          <Button size="sm" onClick={handleBatchProxy} disabled={proxyGenerating}>
            {proxyGenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Video className="w-3 h-3" />}
            批量生成代理 ({proxyStatus.none + proxyStatus.failed})
          </Button>
        )}
      </div>
    </div>
  )
}
