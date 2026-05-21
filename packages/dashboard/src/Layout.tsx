import { useState } from 'react'
import { Outlet } from 'react-router'
import { useEventSourceContext } from './EventSourceContext'
import { Header } from './components/Header'
import { Sidebar } from './components/Sidebar'

export interface LayoutProps {
  onLogout?: () => void
}

export function Layout({ onLogout }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { connected } = useEventSourceContext()

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar
        open={sidebarOpen}
        onClose={() => {
          setSidebarOpen(false)
        }}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        <Header
          connected={connected}
          onToggleSidebar={() => {
            setSidebarOpen((prev) => !prev)
          }}
          onLogout={onLogout}
        />

        <main className="flex-1 overflow-y-auto p-6">
          {!connected && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Live updates disconnected. Dashboard data may be stale until the stream reconnects.
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  )
}
