import type {
  Snapshot, ImportDiff, Product, Lead, CalendarEntry,
  VerifiedClip, Plan, VideoMeta, SkuSearchResult, DateSearchResult,
  VideoRegistry, SkuImage, EnrichedPlan, SkuSessions,
} from '@/types'

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json()
}

// ---- 导入 ----

export function uploadXlsx(file: File) {
  const form = new FormData()
  form.append('file', file)
  return request<{ snapshot_id: number; diffs: ImportDiff[] }>('/api/import/xlsx', {
    method: 'POST',
    body: form,
  })
}

export function fetchSnapshots() {
  return request<Snapshot[]>('/api/import/snapshots')
}

export function fetchDiffs(snapshotId: number) {
  return request<ImportDiff[]>(`/api/import/diffs/${snapshotId}`)
}

// ---- SKU ----

export function fetchSkus(search = '', status = '') {
  const params = new URLSearchParams()
  if (search) params.set('search', search)
  if (status) params.set('status', status)
  return request<Product[]>(`/api/skus?${params}`)
}

export function fetchSku(skuCode: string) {
  return request<Product>(`/api/skus/${skuCode}`)
}

export function uploadSkuImage(skuCode: string, file: File, imageType = 'main') {
  const form = new FormData()
  form.append('file', file)
  return request<{ id: number; image_type: string; file_path: string }>(
    `/api/skus/${skuCode}/images?image_type=${imageType}`, {
      method: 'POST',
      body: form,
    })
}

export function fetchSkuImages(skuCode: string) {
  return request<SkuImage[]>(`/api/skus/${skuCode}/images`)
}

export function deleteSkuImage(skuCode: string, imageId: number) {
  return request<void>(`/api/skus/${skuCode}/images/${imageId}`, { method: 'DELETE' })
}

export function fetchMissingImages() {
  return request<{ sku_code: string; product_name: string }[]>('/api/skus/missing-images')
}

export function fetchSkuSessions(skuCode: string) {
  return request<SkuSessions>(`/api/skus/${skuCode}/sessions`)
}

export function importDownloadedImages() {
  return request<{ imported: number; skipped: number; unmatched: string[] }>(
    '/api/skus/import-downloaded-images', { method: 'POST' }
  )
}

export function browserBatchDownload(skuCodes: string[] = [], batchSize = 10) {
  return request<{ queued: number; sku_codes: string[] }>(
    '/api/skus/image-downloads/browser-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku_codes: skuCodes, batch_size: batchSize }),
    })
}

// ---- Lead ----

export function fetchLeads(params: { sku_code?: string; year?: number; month?: number; day?: number } = {}) {
  const sp = new URLSearchParams()
  if (params.sku_code) sp.set('sku_code', params.sku_code)
  if (params.year) sp.set('year', String(params.year))
  if (params.month) sp.set('month', String(params.month))
  if (params.day) sp.set('day', String(params.day))
  return request<Lead[]>(`/api/leads?${sp}`)
}

export function fetchLeadsByDate(date: string) {
  return request<Lead[]>(`/api/leads/by-date/${date}`)
}

export function fetchLeadsCalendar() {
  return request<CalendarEntry[]>('/api/leads/calendar')
}

// ---- Verified Clips ----

export function createVerified(data: {
  sku_code: string; video_path: string; start_sec: number; end_sec: number;
  lead_id?: string; raw_video_path?: string; rating?: number; tags?: string[];
  lead_time_original?: string; offset_sec?: number; notes?: string;
}) {
  return request<VerifiedClip>('/api/verified', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export function fetchVerified(skuCode = '') {
  const params = skuCode ? `?sku_code=${skuCode}` : ''
  return request<VerifiedClip[]>(`/api/verified${params}`)
}

export function updateVerified(id: number, data: Record<string, unknown>) {
  return request<VerifiedClip>(`/api/verified/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export function deleteVerified(id: number) {
  return request<void>(`/api/verified/${id}`, { method: 'DELETE' })
}

// ---- 计划 ----

export function fetchTodayPlan() {
  return request<EnrichedPlan | null>('/api/plans/today')
}

export function createPlan(date?: string) {
  return request<Plan>('/api/plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(date ? { plan_date: date } : {}),
  })
}

export function fetchPlans(date = '') {
  const params = date ? `?date=${date}` : ''
  return request<Plan[]>(`/api/plans${params}`)
}

export function addPlanItems(planId: number, skuCodes: string[]) {
  return request<Plan>(`/api/plans/${planId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku_codes: skuCodes }),
  })
}

export function updatePlanItem(planId: number, itemId: number, data: Record<string, unknown>) {
  return request<void>(`/api/plans/${planId}/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export function deletePlanItem(planId: number, itemId: number) {
  return request<void>(`/api/plans/${planId}/items/${itemId}`, { method: 'DELETE' })
}

// ---- 视频 ----

export function fetchVideoMeta(path: string) {
  return request<VideoMeta>(`/api/video/meta?path=${encodeURIComponent(path)}`)
}

export function getVideoStreamUrl(path: string) {
  return `/api/video/stream?path=${encodeURIComponent(path)}`
}

export function getFrameUrl(path: string, t: number, w = 180, h = 320) {
  return `/api/video/frame?path=${encodeURIComponent(path)}&t=${t}&w=${w}&h=${h}`
}

export function batchFrames(data: {
  path?: string
  video_id?: number
  timestamps: number[]
  w?: number
  h?: number
}) {
  return request<{ frames: { timestamp: number; url: string }[] }>('/api/video/frames', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

// ---- 视频登记 ----

export function registerVideo(data: {
  session_date: string; session_label?: string; raw_path: string; notes?: string
}) {
  return request<VideoRegistry>('/api/video/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export function fetchVideoRegistry(date = '') {
  const params = date ? `?date=${date}` : ''
  return request<VideoRegistry[]>(`/api/video/registry${params}`)
}

export function fetchVideoRegistryById(videoId: number) {
  return request<VideoRegistry>(`/api/video/registry/${videoId}`)
}

export function fetchVideoByDate(date: string) {
  return request<VideoRegistry | null>(`/api/video/registry/by-date/${date}`)
}

export function generateProxy(videoId: number) {
  return request<{ status: string; proxy_path: string }>(`/api/video/registry/${videoId}/proxy`, {
    method: 'POST',
  })
}

// ---- NAS 视频扫描 ----

export interface ScanSession {
  session_date: string
  session_label: string
  registered: boolean
  file_count: number
  main_file: string
  main_size_mb: number
  total_size_mb: number
}

export function scanNasVideos() {
  return request<{ total: number; registered: number; unregistered: number; sessions: ScanSession[] }>(
    '/api/video/scan'
  )
}

export function registerAllScanned() {
  return request<{ registered: number; segments: number; skipped: number; errors: string[] }>(
    '/api/video/scan/register-all', { method: 'POST' }
  )
}

export function populateSegments() {
  return request<{ populated: number; errors: string[] }>(
    '/api/video/scan/populate-segments', { method: 'POST' }
  )
}

export function batchGenerateProxy(videoIds: number[] = [], allPending = false) {
  return request<{ queued: number; video_ids: number[] }>(
    '/api/video/proxy/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_ids: videoIds, all_pending: allPending }),
    })
}

export function fetchProxyStatus() {
  return request<{ total: number; none: number; queued: number; generating: number; done: number; failed: number }>(
    '/api/video/proxy/status'
  )
}

export function scanProxyDirectory() {
  return request<{ matched: number; already_done: number; unmatched: string[] }>(
    '/api/video/proxy/scan', { method: 'POST' }
  )
}

export function fetchVideoSegments(videoId: number) {
  return request<{ id: number; video_id: number; segment_index: number; raw_path: string; offset_sec: number; duration_sec: number; file_size: number }[]>(
    `/api/video/registry/${videoId}/segments`
  )
}

// ---- 搜索 ----

export function searchBySku(skuCode: string) {
  return request<SkuSearchResult>(`/api/search/by-sku/${skuCode}`)
}

export function searchByDate(date: string) {
  return request<DateSearchResult>(`/api/search/by-date/${date}`)
}

// ---- CLIP 以图找图 ----

export interface ClipSearchResult {
  timestamp: number
  similarity: number
}

export function clipSearch(data: {
  sku_image_path: string; video_path: string; video_duration: number;
  sample_interval?: number; top_k?: number;
}) {
  return request<{ results: ClipSearchResult[] }>('/api/video/clip-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

// ---- 设置 ----

export interface SettingEntry {
  value: string | number
  resolved?: string
  exists?: boolean
}

export type SettingsMap = Record<string, SettingEntry>

export interface MigrateResult {
  dry_run: boolean
  old_prefix: string
  new_prefix: string
  total_affected: number
  details: { table: string; column: string; affected: number }[]
}

export interface StorageStatEntry {
  path: string
  exists: boolean
  file_count?: number
  size_mb?: number
  total_gb?: number
  used_gb?: number
  free_gb?: number
  error?: string
}

export type StorageStats = Record<string, StorageStatEntry>

export function fetchSettings() {
  return request<SettingsMap>('/api/settings')
}

export function updateSettings(data: Record<string, string | number>) {
  return request<{ updated: string[]; settings: Record<string, unknown> }>('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export function migratePaths(oldPrefix: string, newPrefix: string, dryRun = true) {
  return request<MigrateResult>('/api/settings/migrate-paths', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_prefix: oldPrefix, new_prefix: newPrefix, dry_run: dryRun }),
  })
}

export function clearFrameCache() {
  return request<{ deleted_files: number; freed_mb: number }>('/api/settings/clear-frame-cache', {
    method: 'POST',
  })
}

export function fetchStorageStats() {
  return request<StorageStats>('/api/settings/storage-stats')
}
