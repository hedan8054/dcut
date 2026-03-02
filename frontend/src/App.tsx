import React, { Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { NavBar } from '@/components/layout/NavBar'
import { ErrorBoundary } from '@/components/ErrorBoundary'

const ImportPage = React.lazy(() => import('@/pages/ImportPage'))
const PlanPage = React.lazy(() => import('@/pages/PlanPage'))
const ReviewPage = React.lazy(() => import('@/pages/ReviewPage'))
const ClipsPage = React.lazy(() => import('@/pages/ClipsPage'))
const SearchPage = React.lazy(() => import('@/pages/SearchPage'))
const SettingsPage = React.lazy(() => import('@/pages/SettingsPage'))

export default function App() {
  return (
    <BrowserRouter>
      <div className="h-screen flex flex-col">
        <NavBar />
        <main className="flex-1 overflow-auto">
          <ErrorBoundary>
            <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground">加载中...</div>}>
              <Routes>
                <Route path="/import" element={<ImportPage />} />
                <Route path="/plan" element={<PlanPage />} />
                <Route path="/review" element={<ReviewPage />} />
                <Route path="/clips" element={<ClipsPage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/import" replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </BrowserRouter>
  )
}
