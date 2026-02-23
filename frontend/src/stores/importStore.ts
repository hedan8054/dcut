import { create } from 'zustand'
import type { Snapshot, ImportDiff } from '@/types'

interface ImportState {
  snapshots: Snapshot[]
  currentDiffs: ImportDiff[]
  uploading: boolean
  setSnapshots: (s: Snapshot[]) => void
  setCurrentDiffs: (d: ImportDiff[]) => void
  setUploading: (v: boolean) => void
}

export const useImportStore = create<ImportState>((set) => ({
  snapshots: [],
  currentDiffs: [],
  uploading: false,
  setSnapshots: (snapshots) => set({ snapshots }),
  setCurrentDiffs: (currentDiffs) => set({ currentDiffs }),
  setUploading: (uploading) => set({ uploading }),
}))
