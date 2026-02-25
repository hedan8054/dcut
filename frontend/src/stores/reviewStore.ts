import { create } from 'zustand'
import type { Lead, VerifiedClip, VideoRegistry, SessionGroup } from '@/types'

type ReviewMode = 'browse' | 'annotate'

interface ReviewState {
  // 原有字段
  currentSkuCode: string
  currentLead: Lead | null
  savedClips: VerifiedClip[]
  setCurrentSkuCode: (code: string) => void
  setCurrentLead: (lead: Lead | null) => void
  setSavedClips: (clips: VerifiedClip[]) => void

  // 新增: 模式
  mode: ReviewMode
  setMode: (mode: ReviewMode) => void

  // 新增: 场次数据
  sessions: SessionGroup[]
  sessionsLoading: boolean
  setSessions: (sessions: SessionGroup[]) => void
  setSessionsLoading: (loading: boolean) => void

  // 新增: 当前场次
  currentSession: SessionGroup | null
  setCurrentSession: (session: SessionGroup | null) => void

  // 新增: 视频信息
  videoInfo: VideoRegistry | null
  setVideoInfo: (video: VideoRegistry | null) => void

  // 新增: 时间轴状态
  anchorSec: number
  setAnchorSec: (sec: number) => void
  viewRange: [number, number]
  setViewRange: (range: [number, number]) => void
  hitTimestamp: number
  setHitTimestamp: (ts: number) => void

  // 播放状态（双播放头）
  playbackSec: number
  setPlaybackSec: (sec: number) => void
  isPlaying: boolean
  setIsPlaying: (v: boolean) => void

  // 新增: 左侧面板展开的 SKU
  expandedSkuCode: string
  setExpandedSkuCode: (code: string) => void
}

export const useReviewStore = create<ReviewState>((set) => ({
  // 原有
  currentSkuCode: '',
  currentLead: null,
  savedClips: [],
  setCurrentSkuCode: (currentSkuCode) => set({ currentSkuCode }),
  setCurrentLead: (currentLead) => set({ currentLead }),
  setSavedClips: (savedClips) => set({ savedClips }),

  // 模式
  mode: 'browse',
  setMode: (mode) => set({ mode }),

  // 场次
  sessions: [],
  sessionsLoading: false,
  setSessions: (sessions) => set({ sessions }),
  setSessionsLoading: (sessionsLoading) => set({ sessionsLoading }),

  // 当前场次
  currentSession: null,
  setCurrentSession: (currentSession) => set({ currentSession }),

  // 视频
  videoInfo: null,
  setVideoInfo: (videoInfo) => set({ videoInfo }),

  // 时间轴
  anchorSec: 0,
  setAnchorSec: (anchorSec) => set({ anchorSec }),
  viewRange: [0, 0],
  setViewRange: (viewRange) => set({ viewRange }),
  hitTimestamp: 0,
  setHitTimestamp: (hitTimestamp) => set({ hitTimestamp }),

  // 播放状态（双播放头）
  playbackSec: 0,
  setPlaybackSec: (playbackSec) => set({ playbackSec }),
  isPlaying: false,
  setIsPlaying: (isPlaying) => set({ isPlaying }),

  // 左侧面板
  expandedSkuCode: '',
  setExpandedSkuCode: (expandedSkuCode) => set({ expandedSkuCode }),
}))
