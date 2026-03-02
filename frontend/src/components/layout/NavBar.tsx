import { useNavigate, useLocation } from 'react-router-dom'
import { Upload, CalendarDays, ScanSearch, Scissors, Search, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function NavBar() {
  const navigate = useNavigate()
  const location = useLocation()

  const tabs = [
    { path: '/import', label: '导入', icon: Upload },
    { path: '/plan', label: '选品', icon: CalendarDays },
    { path: '/review', label: '审核', icon: ScanSearch },
    { path: '/clips', label: '片段', icon: Scissors },
    { path: '/search', label: '检索', icon: Search },
    { path: '/settings', label: '设置', icon: Settings },
  ] as const

  return (
    <nav className="flex items-center h-12 px-4 border-b border-border bg-card">
      <span className="text-lg font-bold mr-4 text-primary">LiveCuts</span>
      <div className="flex items-center gap-1">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const isActive = location.pathname === tab.path
          return (
            <Button
              key={tab.path}
              variant={isActive ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => navigate(tab.path)}
              className="gap-1.5"
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </Button>
          )
        })}
      </div>
    </nav>
  )
}
