import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Layout } from './Layout'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./EventSourceContext', () => ({
  useEventSourceContext: () => ({
    connected: true,
    connectionEpoch: 1,
    subscribe: vi.fn(() => vi.fn()),
  }),
}))

const mockFetchHealth = vi.fn(() => Promise.reject(new Error('health unavailable in layout test')))
const mockFetchPolicyStatus = vi.fn<() => Promise<unknown>>(() =>
  Promise.reject(new Error('policy status unavailable in layout test')),
)

vi.mock('./api', () => ({
  fetchHealth: () => mockFetchHealth(),
  fetchPolicyStatus: () => mockFetchPolicyStatus(),
}))

/** A policy status report whose readiness block is `readiness`. */
function statusReport(readiness: {
  ready: boolean
  suppressed: boolean
  first_seen?: string | null
}) {
  return {
    schema_version: 1,
    generated_at: '2026-09-21T12:00:00.000Z',
    window: '4h',
    policy: {},
    surface: {},
    coverage: {},
    persisted: {},
    readiness: {
      ready: readiness.ready,
      suppressed: readiness.suppressed,
      calls_in_window: 1851,
      tool_doors_called_in_window: 600,
      first_seen:
        readiness.first_seen === undefined ? '2026-06-23T10:00:00.000Z' : readiness.first_seen,
      thresholds: { min_calls: 100, min_tool_doors: 3 },
    },
  }
}

const BANNER_TEXT =
  'Persisted: 1,851 calls across 600 tool-door pairs in the last 4h (audit rows since 23 Jun 2026). helio policy status lists which tools are called and which have no rule.'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function renderLayout() {
  return render(
    <MemoryRouter>
      <Layout />
    </MemoryRouter>,
  )
}

describe('Layout', () => {
  beforeEach(() => {
    mockFetchHealth.mockClear()
    mockFetchPolicyStatus.mockReset()
    mockFetchPolicyStatus.mockImplementation(() =>
      Promise.reject(new Error('policy status unavailable in layout test')),
    )
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders sidebar with 5 navigation links', () => {
    renderLayout()
    expect(screen.getByText('Feed')).toBeTruthy()
    expect(screen.getByText('Approvals')).toBeTruthy()
    expect(screen.getByText('Audit')).toBeTruthy()
    expect(screen.getByText('Limits')).toBeTruthy()
    expect(screen.getByText('Analytics')).toBeTruthy()
  })

  it('navigation links have correct paths', () => {
    renderLayout()
    const links = screen.getAllByRole('link')
    const hrefs = links.map((l) => l.getAttribute('href'))
    expect(hrefs).toContain('/')
    expect(hrefs).toContain('/approvals')
    expect(hrefs).toContain('/audit')
    expect(hrefs).toContain('/limits')
    expect(hrefs).toContain('/analytics')
  })

  it('renders hamburger button with correct aria-label', () => {
    renderLayout()
    expect(screen.getByLabelText('Toggle navigation')).toBeTruthy()
  })

  it('renders Dashboard title', () => {
    renderLayout()
    expect(screen.getByText('Dashboard')).toBeTruthy()
  })

  it('renders Helio logo in sidebar', () => {
    renderLayout()
    expect(screen.getByAltText('Helio')).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // The readiness banner (issue #396)
  // -------------------------------------------------------------------------

  it('shows the readiness banner when the store is ready and nothing is enforced', async () => {
    mockFetchPolicyStatus.mockImplementation(() =>
      Promise.resolve(statusReport({ ready: true, suppressed: false })),
    )
    renderLayout()
    expect(await screen.findByText(BANNER_TEXT)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
    expect(mockFetchPolicyStatus).toHaveBeenCalledTimes(1)
  })

  it('shows nothing when readiness is suppressed by a loaded policy', async () => {
    mockFetchPolicyStatus.mockImplementation(() =>
      Promise.resolve(statusReport({ ready: true, suppressed: true })),
    )
    renderLayout()
    await waitFor(() => {
      expect(mockFetchPolicyStatus).toHaveBeenCalled()
    })
    expect(screen.queryByText(/Persisted:/)).toBeNull()
  })

  it('shows nothing before the window reaches the floor', async () => {
    mockFetchPolicyStatus.mockImplementation(() =>
      Promise.resolve(statusReport({ ready: false, suppressed: false })),
    )
    renderLayout()
    await waitFor(() => {
      expect(mockFetchPolicyStatus).toHaveBeenCalled()
    })
    expect(screen.queryByText(/Persisted:/)).toBeNull()
  })

  it('hides the banner on Dismiss, remembers first_seen, and shows a new corpus again', async () => {
    mockFetchPolicyStatus.mockImplementation(() =>
      Promise.resolve(statusReport({ ready: true, suppressed: false })),
    )
    const first = renderLayout()
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(BANNER_TEXT)).toBeNull()
    expect(localStorage.getItem('helio.readiness_dismissed')).toBe('2026-06-23T10:00:00.000Z')
    first.unmount()

    // The same corpus stays dismissed across a reload.
    const second = renderLayout()
    await waitFor(() => {
      expect(mockFetchPolicyStatus).toHaveBeenCalledTimes(2)
    })
    expect(screen.queryByText(BANNER_TEXT)).toBeNull()
    second.unmount()

    // A corpus that starts later (retention rolled forward) shows again.
    mockFetchPolicyStatus.mockImplementation(() =>
      Promise.resolve(
        statusReport({ ready: true, suppressed: false, first_seen: '2026-07-01T00:00:00.000Z' }),
      ),
    )
    renderLayout()
    expect(await screen.findByText(/audit rows since 1 Jul 2026/)).toBeTruthy()
  })

  it('still hides the banner on Dismiss when localStorage throws', async () => {
    mockFetchPolicyStatus.mockImplementation(() =>
      Promise.resolve(statusReport({ ready: true, suppressed: false })),
    )
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    renderLayout()
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(BANNER_TEXT)).toBeNull()
  })

  it('renders nothing when the policy status fetch fails', async () => {
    renderLayout()
    await waitFor(() => {
      expect(mockFetchPolicyStatus).toHaveBeenCalled()
    })
    expect(screen.queryByText(/Persisted:/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })
})
