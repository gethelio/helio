import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AnalyticsPage } from './AnalyticsPage'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock recharts to avoid SVG/ResizeObserver issues in jsdom
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  AreaChart: () => <div data-testid="area-chart" />,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  PieChart: () => <div data-testid="pie-chart" />,
  Pie: () => null,
  Sector: () => null,
  Legend: () => null,
  BarChart: () => <div data-testid="bar-chart" />,
  Bar: () => null,
}))

const mockFetchAnalytics = vi.fn()

vi.mock('../api', () => ({
  fetchAnalytics: (...args: unknown[]): unknown => mockFetchAnalytics(...args),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function analyticsData() {
  return {
    total: 150,
    allowed_total: 100,
    by_decision: [
      { decision: 'allow', count: 100 },
      { decision: 'deny', count: 20 },
      { decision: 'rate_limit', count: 15 },
      { decision: 'spend_limit', count: 5 },
      { decision: 'require_approval', count: 10 },
    ],
    blocked_total: 40,
    dry_run_total: 12,
    applied_total: 138,
    by_block_reason: [
      { reason: 'policy_denied', count: 20 },
      { reason: 'rate_limited', count: 15 },
      { reason: 'spend_limited', count: 5 },
    ],
    top_tools: [
      { tool_name: 'send_email', count: 50 },
      { tool_name: 'create_payment', count: 30 },
    ],
    approval_rate: 0.85,
    per_hour: [
      { bucket: '2024-01-01T00:00:00Z', count: 10 },
      { bucket: '2024-01-01T01:00:00Z', count: 20 },
    ],
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFetchAnalytics.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderPage() {
  return render(
    <MemoryRouter>
      <AnalyticsPage />
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnalyticsPage', () => {
  it('renders stat cards with correct values', async () => {
    mockFetchAnalytics.mockResolvedValue(analyticsData())
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Total Actions')).toBeTruthy()
      expect(screen.getByText('150')).toBeTruthy()
      expect(screen.getByText('Allowed')).toBeTruthy()
      expect(screen.getByText('100')).toBeTruthy()
      expect(screen.getByText('Blocked')).toBeTruthy()
      expect(screen.getByText('40')).toBeTruthy() // 20 + 15 + 5
      expect(screen.getByText('Approval Rate')).toBeTruthy()
      expect(screen.getByText('85%')).toBeTruthy()
    })
  })

  it('shows empty state when total is 0', async () => {
    mockFetchAnalytics.mockResolvedValue({
      total: 0,
      allowed_total: 0,
      by_decision: [],
      blocked_total: 0,
      dry_run_total: 0,
      applied_total: 0,
      by_block_reason: [],
      top_tools: [],
      approval_rate: null,
      per_hour: [],
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText(/No data yet/)).toBeTruthy()
    })
  })

  it('renders time range pills', async () => {
    mockFetchAnalytics.mockResolvedValue(analyticsData())
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('1h')).toBeTruthy()
      expect(screen.getByText('24h')).toBeTruthy()
      expect(screen.getByText('7d')).toBeTruthy()
    })
  })

  it('clicking time range pill triggers refetch', async () => {
    mockFetchAnalytics.mockResolvedValue(analyticsData())
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('1h')).toBeTruthy()
    })

    mockFetchAnalytics.mockClear()
    fireEvent.click(screen.getByText('1h'))

    await waitFor(() => {
      expect(mockFetchAnalytics).toHaveBeenCalled()
    })
  })

  it('shows error state on fetch failure', async () => {
    mockFetchAnalytics.mockRejectedValue(new Error('Analytics unavailable'))
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Analytics unavailable')).toBeTruthy()
      expect(screen.getByText('Retry')).toBeTruthy()
    })
  })

  it('renders chart containers', async () => {
    mockFetchAnalytics.mockResolvedValue(analyticsData())
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Actions Per Hour')).toBeTruthy()
      expect(screen.getByText('Matched Actions')).toBeTruthy()
      expect(screen.getByText('Blocked by Reason')).toBeTruthy()
      expect(screen.getByText('Top Tools')).toBeTruthy()
    })
  })

  it('uses allowed_total even when by_decision has no allow bucket', async () => {
    const data = analyticsData()
    mockFetchAnalytics.mockResolvedValue({
      ...data,
      total: 3,
      allowed_total: 2,
      blocked_total: 1,
      by_decision: [{ decision: 'rate_limit', count: 3 }],
      by_block_reason: [{ reason: 'rate_limited', count: 1 }],
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Allowed')).toBeTruthy()
      expect(screen.getByText('2')).toBeTruthy()
      expect(screen.getByText('Blocked')).toBeTruthy()
      expect(screen.getByText('1')).toBeTruthy()
    })
  })

  it('shows em dash totals for older proxies without explicit outcome fields', async () => {
    const data = analyticsData()
    mockFetchAnalytics.mockResolvedValue({
      total: data.total,
      by_decision: data.by_decision,
      top_tools: data.top_tools,
      approval_rate: data.approval_rate,
      per_hour: data.per_hour,
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Allowed')).toBeTruthy()
      expect(screen.getAllByText('\u2014').length).toBeGreaterThanOrEqual(2)
      expect(screen.getByText('Requires a newer proxy version')).toBeTruthy()
    })
  })
})
