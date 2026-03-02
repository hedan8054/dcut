/** 片段工具函数 */

/** 检测 clip 是否已有导出文件 */
export function hasExportFile(clip: { video_path: string }): boolean {
  return clip.video_path.includes('exports/roughcuts/')
}

/**
 * 获取导出文件的可访问 URL（通过 /data/ 静态挂载）
 *
 * 兼容三种 video_path 格式：
 * 1. 相对路径: "exports/roughcuts/xxx.mp4" → "/data/exports/roughcuts/xxx.mp4"
 * 2. 绝对路径含 /data/: "/Users/.../data/exports/roughcuts/xxx.mp4" → "/data/exports/roughcuts/xxx.mp4"
 * 3. 已是 URL 格式: "/data/..." → 原样返回
 */
export function getClipDownloadUrl(clip: { video_path: string }): string {
  const vp = clip.video_path

  // 已是可用 URL（以 /data/ 开头）
  if (vp.startsWith('/data/')) return vp

  // 绝对路径：截取 /data/ 之后的部分
  const dataIdx = vp.indexOf('/data/')
  if (dataIdx !== -1) {
    return vp.slice(dataIdx)
  }

  // 相对路径：直接拼 /data/ 前缀
  return `/data/${vp}`
}

/** 安全解析 tags_json 字符串 */
export function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}
