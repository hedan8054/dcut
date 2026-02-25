import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createReviewCapsule,
  deleteReviewCapsule,
  fetchReviewCapsules,
  patchReviewCapsule,
} from '@/api/client'
import { formatSec } from '@/lib/format'
import { useUndoDelete } from './use-undo-delete'
import type { CapsuleInteractionState, ReviewCapsule, VideoRegistry } from '@/types'

const CAPSULE_MIN_SPAN_SEC = 2
const CAPSULE_DEFAULT_SPAN_SEC = 10

function sortCapsulesByZ(capsules: ReviewCapsule[]): ReviewCapsule[] {
  return [...capsules].sort((a, b) => (a.z_index - b.z_index) || (a.id - b.id))
}

function parseCapsuleTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function normalizeCapsuleRange(startSec: number, endSec: number, duration: number): [number, number] {
  const s = Math.max(0, Math.min(startSec, endSec))
  const e = Math.max(startSec, endSec)
  const clampedEnd = Math.min(duration, Math.max(e, s + CAPSULE_MIN_SPAN_SEC))
  if (clampedEnd - s >= CAPSULE_MIN_SPAN_SEC) {
    return [s, clampedEnd]
  }
  const fixedStart = Math.max(0, clampedEnd - CAPSULE_MIN_SPAN_SEC)
  return [fixedStart, clampedEnd]
}

export interface CapsulePatch {
  sku_code?: string | null
  sku_label?: string | null
  rating?: number
  tags?: string[]
  notes?: string
  status?: 'draft' | 'bound' | 'final'
}

interface Options {
  videoInfo: VideoRegistry | null
  videoPath: string
  videoId: number | undefined
  videoDuration: number
  anchorSec: number
  setAnchorSec: (sec: number) => void
  currentSkuCode: string
  setMode: (mode: 'browse' | 'annotate') => void
  dryrun: boolean
  showUiHint: (text: string, durationMs?: number) => void
}

export function useCapsuleManager({
  videoInfo,
  videoPath,
  videoId,
  videoDuration,
  anchorSec,
  setAnchorSec,
  currentSkuCode,
  setMode,
  dryrun,
  showUiHint,
}: Options) {
  const [capsules, setCapsules] = useState<ReviewCapsule[]>([])
  const [capsulesLoading, setCapsulesLoading] = useState(false)
  const [activeCapsuleId, setActiveCapsuleId] = useState<number | null>(null)
  const [interactionState, setInteractionState] = useState<CapsuleInteractionState>('idle')
  const deleteBusyRef = useRef(false)
  const dryrunCapsuleIdRef = useRef(-1)
  const {
    pending: undoPending,
    stage: stageUndoDelete,
    clear: clearUndoDelete,
    consume: consumeUndoDelete,
  } = useUndoDelete<ReviewCapsule>(5000)

  const activeCapsule = useMemo(
    () => capsules.find(c => c.id === activeCapsuleId) ?? null,
    [capsules, activeCapsuleId],
  )

  useEffect(() => {
    clearUndoDelete()
    if (!videoInfo || !videoPath) {
      setCapsules([])
      setActiveCapsuleId(null)
      dryrunCapsuleIdRef.current = -1
      return
    }

    let cancelled = false
    setCapsulesLoading(true)
    dryrunCapsuleIdRef.current = -1

    fetchReviewCapsules(videoInfo.id, videoPath)
      .then((rows) => {
        if (cancelled) return
        const sorted = sortCapsulesByZ(rows)
        setCapsules(sorted)
        setActiveCapsuleId(prev => {
          if (prev && sorted.some(c => c.id === prev)) return prev
          return sorted.length > 0 ? sorted[sorted.length - 1].id : null
        })
      })
      .catch((err) => {
        if (cancelled) return
        console.error('加载胶囊失败:', err)
        setCapsules([])
        setActiveCapsuleId(null)
      })
      .finally(() => {
        if (!cancelled) setCapsulesLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [clearUndoDelete, videoInfo, videoPath])

  const createCapsule = useCallback(async (range: { start_sec: number; end_sec: number }) => {
    if (!videoPath) return
    const [startSec, endSec] = normalizeCapsuleRange(range.start_sec, range.end_sec, videoDuration)
    const topZ = capsules.reduce((acc, c) => Math.max(acc, c.z_index), 0)
    clearUndoDelete()

    if (dryrun) {
      const now = new Date().toISOString()
      const localCapsule: ReviewCapsule = {
        id: dryrunCapsuleIdRef.current--,
        video_id: videoId ?? null,
        video_path: videoPath,
        start_sec: startSec,
        end_sec: endSec,
        display_mode: 'compressed',
        compression_ratio: 0.5,
        sample_interval_sec: 10,
        sku_code: currentSkuCode || null,
        sku_label: null,
        rating: 0,
        tags_json: '[]',
        notes: '',
        z_index: topZ + 1,
        status: currentSkuCode ? 'bound' : 'draft',
        created_at: now,
        updated_at: now,
      }
      setCapsules(prev => sortCapsulesByZ([...prev, localCapsule]))
      setActiveCapsuleId(localCapsule.id)
      setMode('annotate')
      showUiHint(`已创建 capsule #${Math.abs(localCapsule.id)}（dry-run）`)
      return
    }

    try {
      const created = await createReviewCapsule({
        video_id: videoId,
        video_path: videoPath,
        start_sec: startSec,
        end_sec: endSec,
        display_mode: 'compressed',
        compression_ratio: 0.5,
        sample_interval_sec: 10,
        sku_code: currentSkuCode || null,
        sku_label: null,
        rating: 0,
        tags: [],
        notes: '',
        z_index: topZ + 1,
        status: currentSkuCode ? 'bound' : 'draft',
      })

      setCapsules(prev => sortCapsulesByZ([...prev, created]))
      setActiveCapsuleId(created.id)
      setMode('annotate')
      showUiHint(`已创建 capsule #${created.id}`)
    } catch (err) {
      console.error('创建胶囊失败:', err)
      alert(`创建胶囊失败: ${err instanceof Error ? err.message : err}`)
    }
  }, [capsules, clearUndoDelete, currentSkuCode, dryrun, showUiHint, videoDuration, videoId, videoPath, setMode])

  const createDefaultCapsuleAt = useCallback(async (timestamp: number) => {
    const start = Math.max(0, Math.min(timestamp - 1, videoDuration - CAPSULE_MIN_SPAN_SEC))
    const end = Math.min(videoDuration, start + CAPSULE_DEFAULT_SPAN_SEC)
    await createCapsule({ start_sec: start, end_sec: end })
    showUiHint(`已按锚点创建 10 秒胶囊 ${formatSec(start)} - ${formatSec(end)}`, 1200)
  }, [createCapsule, showUiHint, videoDuration])

  const updateGeometry = useCallback(async (
    capsuleId: number,
    patch: { start_sec?: number; end_sec?: number },
  ) => {
    const current = capsules.find(c => c.id === capsuleId)
    if (!current) return

    const nextStart = patch.start_sec ?? current.start_sec
    const nextEnd = patch.end_sec ?? current.end_sec
    const [startSec, endSec] = normalizeCapsuleRange(nextStart, nextEnd, videoDuration)

    setCapsules(prev => prev.map(c => (
      c.id === capsuleId
        ? { ...c, start_sec: startSec, end_sec: endSec }
        : c
    )))

    if (dryrun) {
      showUiHint(`范围已更新 ${formatSec(startSec)} - ${formatSec(endSec)}（dry-run）`)
      return
    }

    try {
      const updated = await patchReviewCapsule(capsuleId, {
        start_sec: startSec,
        end_sec: endSec,
      })
      setCapsules(prev => prev.map(c => (c.id === capsuleId ? updated : c)))
      showUiHint(`范围已更新 ${formatSec(updated.start_sec)} - ${formatSec(updated.end_sec)}`)
    } catch (err) {
      console.error('更新胶囊范围失败:', err)
      const refreshed = await fetchReviewCapsules(videoId, videoPath)
      setCapsules(sortCapsulesByZ(refreshed))
    }
  }, [capsules, dryrun, showUiHint, videoDuration, videoId, videoPath])

  const activateCapsule = useCallback((capsuleId: number) => {
    const target = capsules.find(c => c.id === capsuleId)
    if (!target) return

    const changed = activeCapsuleId !== capsuleId
    setActiveCapsuleId(capsuleId)
    setMode('annotate')
    if (changed) showUiHint(`已激活 capsule #${capsuleId}`, 900)

    const topZ = capsules.reduce((acc, c) => Math.max(acc, c.z_index), 0)
    if (target.z_index >= topZ) return

    const liftedZ = topZ + 1
    setCapsules(prev => prev.map(c => (c.id === capsuleId ? { ...c, z_index: liftedZ } : c)))

    if (dryrun) return

    patchReviewCapsule(capsuleId, { z_index: liftedZ })
      .then((updated) => {
        setCapsules(prev => prev.map(c => (c.id === capsuleId ? updated : c)))
      })
      .catch((err) => {
        console.error('提升胶囊层级失败:', err)
      })
  }, [activeCapsuleId, capsules, dryrun, setMode, showUiHint])

  const handleFrameSelect = useCallback((timestamp: number) => {
    // 无论是否命中胶囊，总是设置白针（锚点）
    setAnchorSec(timestamp)

    const hit = [...capsules]
      .filter(c => timestamp >= c.start_sec && timestamp <= c.end_sec)
      .sort((a, b) => b.z_index - a.z_index)[0]

    if (hit) {
      activateCapsule(hit.id)
      return
    }

    showUiHint('该位置无胶囊，按 N 键快速创建 10 秒胶囊', 1200)
  }, [activateCapsule, capsules, setAnchorSec, showUiHint])

  const patchActive = useCallback(async (patch: CapsulePatch) => {
    if (!activeCapsule) return

    if (dryrun) {
      setCapsules(prev => prev.map(c => {
        if (c.id !== activeCapsule.id) return c
        return {
          ...c,
          sku_code: patch.sku_code !== undefined ? patch.sku_code : c.sku_code,
          sku_label: patch.sku_label !== undefined ? patch.sku_label : c.sku_label,
          rating: patch.rating !== undefined ? patch.rating : c.rating,
          tags_json: patch.tags !== undefined ? JSON.stringify(patch.tags) : c.tags_json,
          notes: patch.notes !== undefined ? patch.notes : c.notes,
          status: patch.status !== undefined ? patch.status : c.status,
          updated_at: new Date().toISOString(),
        }
      }))
      showUiHint('胶囊信息已更新（dry-run）')
      return
    }

    const updated = await patchReviewCapsule(activeCapsule.id, patch)
    setCapsules(prev => prev.map(c => (c.id === activeCapsule.id ? updated : c)))
    showUiHint('胶囊信息已更新')
  }, [activeCapsule, dryrun, showUiHint])

  const deleteActive = useCallback(async () => {
    if (!activeCapsule || deleteBusyRef.current) return
    deleteBusyRef.current = true
    const snapshot = activeCapsule
    const deleteId = snapshot.id

    try {
      if (!dryrun) {
        await deleteReviewCapsule(deleteId)
      }
      setCapsules(prev => {
        const next = sortCapsulesByZ(prev.filter(c => c.id !== deleteId))
        setActiveCapsuleId(next.length > 0 ? next[next.length - 1].id : null)
        if (next.length === 0) setMode('browse')
        return next
      })
      stageUndoDelete(snapshot)
      showUiHint(`已删除 capsule #${deleteId}${dryrun ? '（dry-run）' : ''}`)
    } catch (err) {
      console.error('删除胶囊失败:', err)
      alert(`删除胶囊失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      deleteBusyRef.current = false
    }
  }, [activeCapsule, dryrun, setMode, showUiHint, stageUndoDelete])

  const undoDeleteCapsule = useCallback(async () => {
    const snapshot = consumeUndoDelete()
    if (!snapshot) return

    if (dryrun) {
      setCapsules(prev => sortCapsulesByZ([...prev, snapshot]))
      setActiveCapsuleId(snapshot.id)
      setMode('annotate')
      showUiHint(`已撤销删除 capsule #${snapshot.id}（dry-run）`)
      return
    }

    try {
      const restored = await createReviewCapsule({
        video_id: snapshot.video_id ?? undefined,
        video_path: snapshot.video_path,
        start_sec: snapshot.start_sec,
        end_sec: snapshot.end_sec,
        display_mode: snapshot.display_mode,
        compression_ratio: snapshot.compression_ratio,
        sample_interval_sec: snapshot.sample_interval_sec,
        sku_code: snapshot.sku_code,
        sku_label: snapshot.sku_label,
        rating: snapshot.rating,
        tags: parseCapsuleTags(snapshot.tags_json),
        notes: snapshot.notes,
        z_index: snapshot.z_index,
        status: snapshot.status,
      })
      setCapsules(prev => sortCapsulesByZ([...prev, restored]))
      setActiveCapsuleId(restored.id)
      setMode('annotate')
      showUiHint(`已撤销删除 capsule #${restored.id}`)
    } catch (err) {
      console.error('撤销删除失败:', err)
      alert(`撤销删除失败: ${err instanceof Error ? err.message : err}`)
    }
  }, [consumeUndoDelete, dryrun, setMode, showUiHint])

  const cycleOverlapAtAnchor = useCallback((reverse = false) => {
    if (capsules.length < 2) return false

    const hasAnchorHit = capsules.some(c => anchorSec >= c.start_sec && anchorSec <= c.end_sec)
    const pivot = hasAnchorHit
      ? anchorSec
      : (activeCapsule ? (activeCapsule.start_sec + activeCapsule.end_sec) / 2 : anchorSec)

    const overlap = [...capsules]
      .filter(c => pivot >= c.start_sec && pivot <= c.end_sec)
      .sort((a, b) => (b.z_index - a.z_index) || (b.id - a.id))

    if (overlap.length < 2) return false

    const idx = overlap.findIndex(c => c.id === activeCapsuleId)
    const step = reverse ? -1 : 1
    const base = idx >= 0 ? idx : 0
    const nextIdx = (base + step + overlap.length) % overlap.length
    activateCapsule(overlap[nextIdx].id)
    return true
  }, [activeCapsule, activeCapsuleId, activateCapsule, anchorSec, capsules])

  return {
    capsules,
    capsulesLoading,
    activeCapsule,
    activeCapsuleId,
    interactionState,
    setInteractionState,
    undoPending,
    clearUndoState: clearUndoDelete,
    createCapsule,
    createDefaultCapsuleAt,
    updateGeometry,
    activateCapsule,
    handleFrameSelect,
    patchActive,
    deleteActive,
    undoDeleteCapsule,
    cycleOverlapAtAnchor,
  }
}
