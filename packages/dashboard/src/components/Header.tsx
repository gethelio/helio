import { useEffect, useState } from 'react'
import { fetchHealth } from '../api'
import { StatusIndicator } from './StatusIndicator'

interface HeaderProps {
  connected: boolean
  onToggleSidebar: () => void
  onLogout?: () => void
}

export function Header({ connected, onToggleSidebar, onLogout }: HeaderProps) {
  const [version, setVersion] = useState<string>()
  const [uptimeSeconds, setUptimeSeconds] = useState<number>()

  useEffect(() => {
    fetchHealth()
      .then((data) => {
        setVersion(data.version)
        setUptimeSeconds(Math.floor(data.uptime))
      })
      .catch(() => {
        // Health fetch failed — status indicator will show disconnected
      })
  }, [])

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 md:hidden"
          onClick={onToggleSidebar}
          aria-label="Toggle navigation"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>
        <h1 className="text-lg font-semibold text-gray-900">Dashboard</h1>
      </div>

      <div className="flex items-center gap-3">
        {onLogout && (
          <button
            type="button"
            className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
            onClick={onLogout}
          >
            Logout
          </button>
        )}
        <StatusIndicator connected={connected} version={version} uptimeSeconds={uptimeSeconds} />
      </div>
    </header>
  )
}
