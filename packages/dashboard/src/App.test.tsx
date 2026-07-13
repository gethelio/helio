import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Outlet } from 'react-router'
import { App } from './App'
import type { AuthSessionResponse } from './types'

const mockFetchAuthSession = vi.fn<() => Promise<AuthSessionResponse>>()
const mockLoginDashboard = vi.fn<(secret: string) => Promise<AuthSessionResponse>>()
const mockLogoutDashboard = vi.fn<() => Promise<{ ok: true }>>()
const mockSetCsrfToken = vi.fn<(token: string | undefined) => void>()
let unauthorizedHandler: (() => void) | undefined

vi.mock('./api', () => ({
  ApiError: class ApiError extends Error {
    readonly status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
  fetchAuthSession: () => mockFetchAuthSession(),
  loginDashboard: (secret: string) => mockLoginDashboard(secret),
  logoutDashboard: () => mockLogoutDashboard(),
  setCsrfToken: (token: string | undefined) => {
    mockSetCsrfToken(token)
  },
  setUnauthorizedHandler: (handler: (() => void) | undefined) => {
    unauthorizedHandler = handler
  },
}))

vi.mock('./EventSourceContext', () => ({
  EventSourceProvider: ({ children }: { children: ReactNode; onSessionExpired?: () => void }) => (
    <>{children}</>
  ),
}))

vi.mock('./Layout', () => ({
  Layout: () => (
    <div>
      <div>Mock Layout</div>
      <Outlet />
    </div>
  ),
}))

vi.mock('./pages/FeedPage', () => ({ FeedPage: () => <div>Mock Feed Page</div> }))
vi.mock('./pages/ApprovalsPage', () => ({ ApprovalsPage: () => <div>Mock Approvals Page</div> }))
vi.mock('./pages/AuditPage', () => ({ AuditPage: () => <div>Mock Audit Page</div> }))
vi.mock('./pages/LimitsPage', () => ({ LimitsPage: () => <div>Mock Limits Page</div> }))
vi.mock('./pages/BudgetsPage', () => ({ BudgetsPage: () => <div>Mock Budgets Page</div> }))
vi.mock('./pages/AnalyticsPage', () => ({ AnalyticsPage: () => <div>Mock Analytics Page</div> }))

describe('App auth gate', () => {
  beforeEach(() => {
    mockFetchAuthSession.mockReset()
    mockLoginDashboard.mockReset()
    mockLogoutDashboard.mockReset()
    mockSetCsrfToken.mockReset()
    unauthorizedHandler = undefined
  })

  it('shows the login card when session auth is required and unauthenticated', async () => {
    mockFetchAuthSession.mockResolvedValue({
      auth_required: true,
      authenticated: false,
    })

    render(<App />)
    expect(await screen.findByText('Dashboard Locked')).toBeTruthy()
    expect(screen.getByLabelText('Dashboard secret')).toBeTruthy()
  })

  it('unlocks and renders dashboard routes after successful login', async () => {
    mockFetchAuthSession.mockResolvedValue({
      auth_required: true,
      authenticated: false,
    })
    mockLoginDashboard.mockResolvedValue({
      auth_required: true,
      authenticated: true,
      csrf_token: 'csrf-token',
    })

    render(<App />)
    await screen.findByText('Dashboard Locked')

    fireEvent.change(screen.getByLabelText('Dashboard secret'), {
      target: { value: 'test-secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock Dashboard' }))

    expect(await screen.findByText('Mock Feed Page')).toBeTruthy()
    expect(mockSetCsrfToken).toHaveBeenCalledWith('csrf-token')
  })

  it('renders the budgets route for an authenticated session', async () => {
    mockFetchAuthSession.mockResolvedValue({
      auth_required: false,
      authenticated: true,
    })

    window.history.pushState({}, '', '/budgets')
    try {
      render(<App />)
      expect(await screen.findByText('Mock Budgets Page')).toBeTruthy()
      expect(screen.getByText('Mock Layout')).toBeTruthy()
    } finally {
      window.history.pushState({}, '', '/')
    }
  })

  it('locks the app when unauthorized handler fires', async () => {
    mockFetchAuthSession.mockResolvedValue({
      auth_required: false,
      authenticated: true,
    })

    render(<App />)
    await screen.findByText('Mock Feed Page')

    expect(unauthorizedHandler).toBeTypeOf('function')
    act(() => {
      unauthorizedHandler?.()
    })

    await waitFor(() => {
      expect(screen.getByText('Dashboard Locked')).toBeTruthy()
    })
  })
})
