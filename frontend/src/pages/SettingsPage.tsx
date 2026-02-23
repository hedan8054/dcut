import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Save, FolderSearch, ArrowRightLeft, Trash2, HardDrive,
  Loader2, CheckCircle, XCircle, AlertTriangle,
} from 'lucide-react'
import {
  fetchSettings, updateSettings, migratePaths, clearFrameCache,
  fetchStorageStats,
  type SettingsMap, type MigrateResult, type StorageStats,
} from '@/api/client'

// ---- 路径配置项的显示名 ----
const PATH_LABELS: Record<string, string> = {
  raw_video_root: '原始视频目录 (NAS)',
  proxy_video_root: '代理视频目录',
  downloaded_pic_dir: '油猴下载图片目录',
  frame_cache_dir: '帧缓存目录',
  sku_image_dir: '商品图目录',
}

const NUMERIC_LABELS: Record<string, { label: string; hint: string }> = {
  frame_semaphore_limit: { label: '抽帧并发数', hint: '同时提取帧的最大数量' },
  stream_chunk_size: { label: '流媒体块大小', hint: '字节，默认 2MB' },
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsMap | null>(null)
  const [edits, setEdits] = useState<Record<string, string | number>>({})
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  // 搬家
  const [oldPrefix, setOldPrefix] = useState('')
  const [newPrefix, setNewPrefix] = useState('')
  const [migrateResult, setMigrateResult] = useState<MigrateResult | null>(null)
  const [migrating, setMigrating] = useState(false)

  // 缓存
  const [clearing, setClearing] = useState(false)
  const [clearResult, setClearResult] = useState<{ deleted_files: number; freed_mb: number } | null>(null)

  // 存储统计
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [loadingStats, setLoadingStats] = useState(false)

  const load = useCallback(async () => {
    try {
      const s = await fetchSettings()
      setSettings(s)
      // 初始化编辑值
      const init: Record<string, string | number> = {}
      for (const [k, v] of Object.entries(s)) {
        init[k] = v.value
      }
      setEdits(init)
    } catch (e) {
      console.error('加载设置失败', e)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // ---- 保存设置 ----
  const handleSave = async () => {
    setSaving(true)
    setSaveMsg('')
    try {
      await updateSettings(edits)
      setSaveMsg('已保存')
      await load()
      setTimeout(() => setSaveMsg(''), 3000)
    } catch (e: any) {
      setSaveMsg(`保存失败: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  // ---- 路径搬家 ----
  const handleMigrate = async (dryRun: boolean) => {
    setMigrating(true)
    try {
      const res = await migratePaths(oldPrefix, newPrefix, dryRun)
      setMigrateResult(res)
    } catch (e: any) {
      alert(`搬家失败: ${e.message}`)
    } finally {
      setMigrating(false)
    }
  }

  // ---- 清空帧缓存 ----
  const handleClearCache = async () => {
    if (!confirm('确认清空所有帧缓存？此操作不可恢复。')) return
    setClearing(true)
    try {
      const res = await clearFrameCache()
      setClearResult(res)
    } catch (e: any) {
      alert(`清空失败: ${e.message}`)
    } finally {
      setClearing(false)
    }
  }

  // ---- 加载存储统计 ----
  const handleLoadStats = async () => {
    setLoadingStats(true)
    try {
      const s = await fetchStorageStats()
      setStats(s)
    } catch (e: any) {
      alert(`加载统计失败: ${e.message}`)
    } finally {
      setLoadingStats(false)
    }
  }

  if (!settings) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">加载中...</div>
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-8">
      <h1 className="text-xl font-bold">高级设置</h1>

      {/* ======== 1. 存储路径 ======== */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <FolderSearch className="w-5 h-5" />
          存储路径
        </h2>
        <div className="space-y-3">
          {Object.entries(PATH_LABELS).map(([key, label]) => {
            const entry = settings[key]
            return (
              <div key={key} className="space-y-1">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium w-44 shrink-0">{label}</label>
                  <Input
                    value={String(edits[key] ?? '')}
                    onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
                    className="font-mono text-sm"
                  />
                  {entry?.exists !== undefined && (
                    entry.exists
                      ? <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
                      : <XCircle className="w-4 h-4 text-red-500 shrink-0" />
                  )}
                </div>
                {entry?.resolved && entry.resolved !== String(entry.value) && (
                  <p className="text-xs text-muted-foreground ml-44 pl-2">
                    解析为: {entry.resolved}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        {/* 数值配置 */}
        <div className="space-y-3 pt-2 border-t border-border">
          {Object.entries(NUMERIC_LABELS).map(([key, { label, hint }]) => (
            <div key={key} className="flex items-center gap-2">
              <label className="text-sm font-medium w-44 shrink-0">{label}</label>
              <Input
                type="number"
                value={String(edits[key] ?? '')}
                onChange={(e) => setEdits({ ...edits, [key]: Number(e.target.value) })}
                className="w-40 font-mono text-sm"
              />
              <span className="text-xs text-muted-foreground">{hint}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            保存设置
          </Button>
          {saveMsg && (
            <span className={`text-sm ${saveMsg.includes('失败') ? 'text-red-500' : 'text-green-600'}`}>
              {saveMsg}
            </span>
          )}
        </div>
      </section>

      {/* ======== 2. 路径搬家 ======== */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <ArrowRightLeft className="w-5 h-5" />
          路径搬家
        </h2>
        <p className="text-sm text-muted-foreground">
          批量替换数据库中的旧路径前缀为新前缀（如 NAS 换 IP、硬盘换盘符）
        </p>
        <div className="flex items-center gap-2">
          <Input
            placeholder="旧前缀，如 /Volumes/切片/衣甜"
            value={oldPrefix}
            onChange={(e) => setOldPrefix(e.target.value)}
            className="font-mono text-sm"
          />
          <span className="text-muted-foreground shrink-0">&rarr;</span>
          <Input
            placeholder="新前缀，如 /Volumes/新NAS/衣甜"
            value={newPrefix}
            onChange={(e) => setNewPrefix(e.target.value)}
            className="font-mono text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => handleMigrate(true)}
            disabled={migrating || !oldPrefix || !newPrefix}
            className="gap-1.5"
          >
            {migrating ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderSearch className="w-4 h-4" />}
            预览影响
          </Button>
          <Button
            variant="destructive"
            onClick={() => handleMigrate(false)}
            disabled={migrating || !oldPrefix || !newPrefix}
            className="gap-1.5"
          >
            执行搬家
          </Button>
        </div>

        {migrateResult && (
          <div className="rounded-lg border border-border p-4 space-y-2 text-sm">
            <div className="flex items-center gap-2">
              {migrateResult.dry_run ? (
                <Badge variant="secondary">预览模式</Badge>
              ) : (
                <Badge variant="destructive">已执行</Badge>
              )}
              <span>共影响 <strong>{migrateResult.total_affected}</strong> 条记录</span>
            </div>
            {migrateResult.details.length > 0 && (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-1">表</th>
                    <th className="text-left py-1">列</th>
                    <th className="text-right py-1">影响行数</th>
                  </tr>
                </thead>
                <tbody>
                  {migrateResult.details.map((d, i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-1 font-mono">{d.table}</td>
                      <td className="py-1 font-mono">{d.column}</td>
                      <td className="py-1 text-right">{d.affected}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      {/* ======== 3. 缓存管理 ======== */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Trash2 className="w-5 h-5" />
          缓存管理
        </h2>
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={handleClearCache} disabled={clearing} className="gap-1.5">
            {clearing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            清空帧缓存
          </Button>
          {clearResult && (
            <span className="text-sm text-muted-foreground">
              已删除 {clearResult.deleted_files} 个文件，释放 {clearResult.freed_mb} MB
            </span>
          )}
        </div>
      </section>

      {/* ======== 4. 存储统计 ======== */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <HardDrive className="w-5 h-5" />
          存储统计
        </h2>
        <Button variant="secondary" onClick={handleLoadStats} disabled={loadingStats} className="gap-1.5">
          {loadingStats ? <Loader2 className="w-4 h-4 animate-spin" /> : <HardDrive className="w-4 h-4" />}
          加载统计
        </Button>

        {stats && (
          <div className="grid gap-3">
            {Object.entries(stats).map(([key, s]) => (
              <div key={key} className="rounded-lg border border-border p-3 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{PATH_LABELS[key] || key}</span>
                  {s.exists ? (
                    <Badge variant="secondary" className="text-xs">可访问</Badge>
                  ) : (
                    <Badge variant="destructive" className="text-xs">不可访问</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground font-mono">{s.path}</p>
                {s.exists && (
                  <div className="text-xs text-muted-foreground">
                    {s.file_count !== undefined && <span>文件数: {s.file_count} | </span>}
                    {s.size_mb !== undefined && <span>占用: {s.size_mb} MB</span>}
                    {s.total_gb !== undefined && (
                      <span>
                        磁盘: {s.used_gb} / {s.total_gb} GB（剩余 {s.free_gb} GB）
                      </span>
                    )}
                  </div>
                )}
                {s.error && (
                  <div className="flex items-center gap-1 text-xs text-yellow-600">
                    <AlertTriangle className="w-3 h-3" />
                    {s.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
