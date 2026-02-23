import { create } from 'zustand'
import type { Plan, Product } from '@/types'

interface PlanState {
  plan: Plan | null
  availableSkus: Product[]
  setPlan: (p: Plan | null) => void
  setAvailableSkus: (skus: Product[]) => void
}

export const usePlanStore = create<PlanState>((set) => ({
  plan: null,
  availableSkus: [],
  setPlan: (plan) => set({ plan }),
  setAvailableSkus: (availableSkus) => set({ availableSkus }),
}))
