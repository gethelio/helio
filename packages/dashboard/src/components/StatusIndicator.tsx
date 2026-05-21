import { useEffect, useRef, useState } from 'react'

interface StatusIndicatorProps {
  connected: boolean
  version?: string
  uptimeSeconds?: number
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${String(h)}h ${String(m)}m`
  return `${String(m)}m`
}

export function StatusIndicator({ connected, version, uptimeSeconds }: StatusIndicatorProps) {
  const [showTooltip, setShowTooltip] = useState(false)
  const [liveUptime, setLiveUptime] = useState(uptimeSeconds)
  const mountedAt = useRef(Date.now())

  useEffect(() => {
    if (uptimeSeconds === undefined) return
    mountedAt.current = Date.now()
    setLiveUptime(uptimeSeconds)
    const id = setInterval(() => {
      const elapsed = Math.floor((Date.now() - mountedAt.current) / 1000)
      setLiveUptime(uptimeSeconds + elapsed)
    }, 1000)
    return () => {
      clearInterval(id)
    }
  }, [uptimeSeconds])

  return (
    <div className="relative">
      <button
        type="button"
        className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
        onMouseEnter={() => {
          setShowTooltip(true)
        }}
        onMouseLeave={() => {
          setShowTooltip(false)
        }}
        onFocus={() => {
          setShowTooltip(true)
        }}
        onBlur={() => {
          setShowTooltip(false)
        }}
        onClick={() => {
          setShowTooltip((prev) => !prev)
        }}
      >
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            connected ? 'bg-emerald-500' : 'bg-red-500'
          }`}
        />
        <span className="hidden sm:inline">{connected ? 'Connected' : 'Disconnected'}</span>
      </button>

      {showTooltip && (
        <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-gray-200 bg-white p-3 text-xs shadow-lg">
          <div className="mb-1 font-medium text-gray-900">
            {connected ? 'Proxy connected' : 'Proxy disconnected'}
          </div>
          {version && <div className="text-gray-500">Version: {version}</div>}
          {liveUptime !== undefined && (
            <div className="text-gray-500">Uptime: {formatUptime(liveUptime)}</div>
          )}
        </div>
      )}
    </div>
  )
}
