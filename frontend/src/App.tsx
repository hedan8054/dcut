import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { NavBar } from '@/components/layout/NavBar'
import ImportPage from '@/pages/ImportPage'
import PlanPage from '@/pages/PlanPage'
import ReviewPage from '@/pages/ReviewPage'
import SearchPage from '@/pages/SearchPage'
import SettingsPage from '@/pages/SettingsPage'

export default function App() {
  return (
    <BrowserRouter>
      <div className="h-screen flex flex-col">
        <NavBar />
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/import" element={<ImportPage />} />
            <Route path="/plan" element={<PlanPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/import" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
