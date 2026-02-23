// ---- XLSX 导入 ----

export interface Snapshot {
  id: number
  file_name: string
  file_hash: string
  row_count: number
  imported_at: string
}

export interface ImportDiff {
  id: number
  snapshot_id: number
  diff_type: 'new_sku' | 'new_lead' | 'status_change' | 'listing_change'
  sku_code: string
  detail_json: string
  created_at: string
}

// ---- 商品 / SKU ----

export interface Product {
  sku_code: string
  product_id: string
  product_name: string
  price: number | null
  shop_name: string
  commission_rate: number | null
  promo_link: string
  launch_date: string | null
  product_status: string
  abnormal_note: string
  image_path: string
  lead_count: number
  latest_lead_date: string | null
}

export interface ProductBrief {
  sku_code: string
  product_name: string
  price: number | null
  image_path: string
  lead_count: number
  latest_lead_date: string | null
}

// ---- Lead 线索 ----

export interface Lead {
  id: string
  sku_code: string
  material_year: number
  raw_fragment: string
  normalized_fragment: string
  material_month: number | null
  material_day: number | null
  session_label: string | null
  host_label: string | null
  time_points_json: string
  parse_confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  created_at: string
}

export interface CalendarEntry {
  date: string
  sku_count: number
}

// ---- Verified Clips ----

export interface VerifiedClip {
  id: number
  sku_code: string
  lead_id: string | null
  video_path: string
  raw_video_path: string
  start_sec: number
  end_sec: number
  rating: number
  tags_json: string
  thumbnail: string
  lead_time_original: string
  offset_sec: number
  notes: string
  created_at: string
}

// ---- 发布计划 ----

export interface Plan {
  id: number
  plan_date: string
  status: string
  items: PlanItem[]
}

export interface PlanItem {
  id: number
  sku_code: string
  sort_order: number
  status: string
}

export interface EnrichedPlan {
  id: number
  plan_date: string
  status: string
  items: EnrichedPlanItem[]
}

export interface EnrichedPlanItem {
  id: number
  sku_code: string
  sort_order: number
  status: string
  product_name: string | null
  image_path: string | null
  price: number | null
  shop_name: string | null
  promo_link: string | null
  lead_count: number
  verified_count: number
}

// ---- 场次总览 ----

export interface SkuSessions {
  sku_code: string
  sessions: SessionGroup[]
}

export interface SessionGroup {
  date: string
  leads: Lead[]
  video: VideoRegistry | null
  verified_count: number
}

// ---- 视频 ----

export interface VideoMeta {
  video_path: string
  proxy_path: string
  duration_sec: number
  width: number | null
  height: number | null
  file_size: number | null
}

export interface VideoRegistry {
  id: number
  session_date: string
  session_label: string
  raw_path: string
  proxy_path: string
  duration_sec: number
  width: number
  height: number
  file_size: number
  proxy_status: string
  notes: string
  created_at: string
}

export interface SkuImage {
  id: number
  image_type: 'main' | 'ref' | 'cover'
  file_path: string
  source_url: string
  sort_order: number
}

// ---- 搜索 ----

export interface SkuSearchResult {
  product: Product
  leads: Lead[]
  verified_clips: VerifiedClip[]
}

export interface DateSearchResult {
  date: string
  skus: DateSkuEntry[]
}

export interface DateSkuEntry {
  sku_code: string
  product_name: string
  image_path: string
  leads: Lead[]
  verified_count: number
}
