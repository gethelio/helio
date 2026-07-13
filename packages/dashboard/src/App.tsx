import { useCallback, useEffect, useState, type SyntheticEvent } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router'
import { EventSourceProvider } from './EventSourceContext'
import {
  ApiError,
  fetchAuthSession,
  loginDashboard,
  logoutDashboard,
  setCsrfToken,
  setUnauthorizedHandler,
} from './api'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Layout } from './Layout'
import { FeedPage } from './pages/FeedPage'
import { ApprovalsPage } from './pages/ApprovalsPage'
import { AuditPage } from './pages/AuditPage'
import { LimitsPage } from './pages/LimitsPage'
import { BudgetsPage } from './pages/BudgetsPage'
import { AnalyticsPage } from './pages/AnalyticsPage'

type AppViewState = 'booting' | 'locked' | 'authenticating' | 'ready'

export function App() {
  const [viewState, setViewState] = useState<AppViewState>('booting')
  const [authRequired, setAuthRequired] = useState(false)
  const [secretInput, setSecretInput] = useState('')
  const [authMessage, setAuthMessage] = useState<string | null>(null)

  const lockForExpiredSession = useCallback(() => {
    setCsrfToken(undefined)
    setViewState('locked')
    setAuthMessage('Session expired. Enter the dashboard secret again.')
  }, [])

  const refreshSession = useCallback(async () => {
    setViewState('booting')
    try {
      const session = await fetchAuthSession()
      setAuthRequired(session.auth_required)
      if (!session.auth_required || session.authenticated) {
        setCsrfToken(session.csrf_token)
        setAuthMessage(null)
        setViewState('ready')
        return
      }
      setCsrfToken(undefined)
      setViewState('locked')
      setAuthMessage(null)
    } catch {
      setCsrfToken(undefined)
      setViewState('locked')
      setAuthMessage('Unable to check session state. Verify the proxy is running and try again.')
    }
  }, [])

  useEffect(() => {
    void refreshSession()
  }, [refreshSession])

  useEffect(() => {
    setUnauthorizedHandler(lockForExpiredSession)
    return () => {
      setUnauthorizedHandler(undefined)
    }
  }, [lockForExpiredSession])

  async function handleLogin(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
    event.preventDefault()
    if (!secretInput.trim()) {
      setAuthMessage('Enter the dashboard secret from your Helio config.')
      return
    }
    setViewState('authenticating')
    setAuthMessage(null)
    try {
      const session = await loginDashboard(secretInput.trim())
      setAuthRequired(session.auth_required)
      setCsrfToken(session.csrf_token)
      setSecretInput('')
      setViewState('ready')
    } catch (error) {
      setCsrfToken(undefined)
      setViewState('locked')
      if (error instanceof ApiError && error.status === 401) {
        setAuthMessage('Invalid dashboard secret. Check your Helio config and try again.')
      } else {
        setAuthMessage('Sign in failed due to a network or server error. Try again.')
      }
    }
  }

  async function handleLogout(): Promise<void> {
    try {
      await logoutDashboard()
    } catch {
      // Even if logout fails remotely, lock local UI and require re-auth.
    }
    setCsrfToken(undefined)
    setViewState('locked')
    setAuthMessage('Signed out. Enter the dashboard secret to unlock.')
  }

  if (viewState === 'booting') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-gray-900">Helio Dashboard</h1>
          <p className="mt-2 text-sm text-gray-600">Checking session status...</p>
        </div>
      </div>
    )
  }

  if (viewState === 'locked' || viewState === 'authenticating') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <form
          onSubmit={(event) => {
            void handleLogin(event)
          }}
          className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
        >
          <h1 className="text-lg font-semibold text-gray-900">Dashboard Locked</h1>
          <p className="mt-2 text-sm text-gray-600">
            Enter your dashboard secret, the <code>dashboard.api_secret</code> value from your Helio
            config. If that is an env placeholder (for example{' '}
            <code>{'${HELIO_DASHBOARD_SECRET}'}</code>), enter the value it resolves to.
          </p>
          <label
            htmlFor="dashboard-secret"
            className="mt-4 block text-sm font-medium text-gray-700"
          >
            Dashboard secret
          </label>
          <input
            id="dashboard-secret"
            type="password"
            autoComplete="current-password"
            value={secretInput}
            onChange={(event) => {
              setSecretInput(event.target.value)
            }}
            disabled={viewState === 'authenticating'}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:bg-gray-100"
          />
          {authMessage && (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {authMessage}
            </p>
          )}
          <button
            type="submit"
            disabled={viewState === 'authenticating'}
            className="mt-4 inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-blue-300"
          >
            {viewState === 'authenticating' ? 'Unlocking...' : 'Unlock Dashboard'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <EventSourceProvider onSessionExpired={lockForExpiredSession}>
          <Routes>
            <Route
              element={<Layout onLogout={authRequired ? () => void handleLogout() : undefined} />}
            >
              <Route index element={<FeedPage />} />
              <Route path="approvals" element={<ApprovalsPage />} />
              <Route path="audit" element={<AuditPage />} />
              <Route path="limits" element={<LimitsPage />} />
              <Route path="budgets" element={<BudgetsPage />} />
              <Route path="analytics" element={<AnalyticsPage />} />
            </Route>
          </Routes>
        </EventSourceProvider>
      </ErrorBoundary>
    </BrowserRouter>
  )
}
