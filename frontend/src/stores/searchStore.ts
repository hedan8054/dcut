import { create } from 'zustand'

interface SearchState {
  mode: 'sku' | 'date'
  query: string
  setMode: (m: 'sku' | 'date') => void
  setQuery: (q: string) => void
}

export const useSearchStore = create<SearchState>((set) => ({
  mode: 'sku',
  query: '',
  setMode: (mode) => set({ mode }),
  setQuery: (query) => set({ query }),
}))
