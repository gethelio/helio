import { useEffect, useState } from 'react'
import { Outlet } from 'react-router'
import { useEventSourceContext } from './EventSourceContext'
import { fetchPolicyStatus } from './api'
import type { PolicyStatusReadiness } from './types'
import { Header } from './components/Header'
import { Sidebar } from './components/Sidebar'

export interface LayoutProps {
  onLogout?: () => void
}

// ---------------------------------------------------------------------------
// Readiness banner (issue #396): the same sentence `helio start` prints once
// per boot, shown while the store holds enough recent activity and the
// policy enforces nothing. Dismissal is keyed by the corpus's first_seen so
// a corpus that starts later (retention rolled forward) shows again; adding
// a rule suppresses it server-side. The stored value is a timestamp, never
// a credential or a record.
// ---------------------------------------------------------------------------

const READINESS_DISMISSED_KEY = 'helio.readiness_dismissed'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatDay(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? '?'} ${String(d.getUTCFullYear())}`
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`
}

/** The persisted sentence, word for word the CLI's once-per-boot line. */
export function readinessSentence(readiness: PolicyStatusReadiness, window: string): string {
  const since = readiness.first_seen ? ` (audit rows since ${formatDay(readiness.first_seen)})` : ''
  return (
    `Persisted: ${plural(readiness.calls_in_window, 'call')} across ` +
    `${plural(readiness.tool_doors_called_in_window, 'tool-door pair')} in the last ${window}${since}. ` +
    'helio policy status lists which tools are called and which have no rule.'
  )
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(READINESS_DISMISSED_KEY)
  } catch {
    return null
  }
}

function writeDismissed(firstSeen: string): void {
  try {
    localStorage.setItem(READINESS_DISMISSED_KEY, firstSeen)
  } catch {
    // Storage unavailable (private window, quota): the banner still hides for this view.
  }
}

export function Layout({ onLogout }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { connected } = useEventSourceContext()
  const [readiness, setReadiness] = useState<{
    readiness: PolicyStatusReadiness
    window: string
  }>()
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed())

  useEffect(() => {
    fetchPolicyStatus()
      .then((report) => {
        setReadiness({ readiness: report.readiness, window: report.window })
      })
      .catch(() => {
        // No policy status (open mode without the dep, an older proxy, a
        // network failure): the banner renders nothing.
      })
  }, [])

  const showReadiness =
    readiness !== undefined &&
    readiness.readiness.ready &&
    !readiness.readiness.suppressed &&
    dismissed !== (readiness.readiness.first_seen ?? '')

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
          {showReadiness && (
            <div
              role="status"
              className="mb-4 flex items-start justify-between gap-3 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700"
            >
              <span>{readinessSentence(readiness.readiness, readiness.window)}</span>
              <button
                type="button"
                className="shrink-0 rounded px-2 py-0.5 text-gray-500 hover:bg-gray-100"
                onClick={() => {
                  const firstSeen = readiness.readiness.first_seen ?? ''
                  writeDismissed(firstSeen)
                  setDismissed(firstSeen)
                }}
              >
                Dismiss
              </button>
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  )
}
