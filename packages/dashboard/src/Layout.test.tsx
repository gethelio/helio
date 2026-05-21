import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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

vi.mock('./api', () => ({
  fetchHealth: () => mockFetchHealth(),
}))

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
})
