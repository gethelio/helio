import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AuditPage } from './AuditPage'
import type { AuditRecord } from '../types'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSubscribe = vi.fn(() => vi.fn())

vi.mock('../EventSourceContext', () => ({
  useEventSourceContext: () => ({ connected: true, connectionEpoch: 1, subscribe: mockSubscribe }),
}))

const mockFetchAudit = vi.fn()
const mockFetchAuditRecord = vi.fn()

vi.mock('../api', () => ({
  fetchAudit: (...args: unknown[]): unknown => mockFetchAudit(...args),
  fetchAuditRecord: (...args: unknown[]): unknown => mockFetchAuditRecord(...args),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAuditRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  const defaults: AuditRecord = {
    id: 'rec-001',
    timestamp: '2025-01-15T10:00:00.000Z',
    session_id: 'sess-abc-1234567890',
    agent_id: null,
    environment: null,
    tool_name: 'send_email',
    tool_input: { to: 'user@example.com' },
    policy_decision: 'allow',
    block_reason: null,
    matched_rule: 'rule-1',
    matched_rule_index: 0,
    evidence_chain: null,
    approval_status: null,
    approved_by: null,
    upstream_response: null,
    upstream_error: null,
    upstream_http_status: null,
    upstream_latency_ms: 12,
    total_duration_ms: 3.5,
    approval_wait_ms: 0,
    proxy_compute_ms: 1.2,
    flagged_destructive: false,
    dry_run: false,
    created_at: '2025-01-15T10:00:00.100Z',
    record_kind: 'tool_call',
    origin: 'mcp',
    metadata: null,
  }
  return {
    ...defaults,
    ...overrides,
    environment: overrides.environment ?? defaults.environment,
    matched_rule_index: overrides.matched_rule_index ?? defaults.matched_rule_index,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSubscribe.mockClear()
  mockFetchAudit.mockReset()
  mockFetchAuditRecord.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderPage() {
  return render(
    <MemoryRouter>
      <AuditPage />
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditPage', () => {
  it('renders audit records after fetch', async () => {
    mockFetchAudit.mockResolvedValue({
      data: [makeAuditRecord()],
      total: 1,
      limit: 25,
      offset: 0,
    })

    renderPage()

    await waitFor(() => {
      expect(screen.getByText('send_email')).toBeTruthy()
    })
  })

  it('renders empty state when no records and no filters', async () => {
    mockFetchAudit.mockResolvedValue({
      data: [],
      total: 0,
      limit: 25,
      offset: 0,
    })

    renderPage()

    await waitFor(() => {
      expect(screen.getByText('No audit records yet')).toBeTruthy()
    })
  })

  it('renders Audit Log heading', async () => {
    mockFetchAudit.mockResolvedValue({
      data: [makeAuditRecord()],
      total: 1,
      limit: 25,
      offset: 0,
    })

    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Audit Log')).toBeTruthy()
    })
  })

  it('renders filter controls', async () => {
    mockFetchAudit.mockResolvedValue({
      data: [makeAuditRecord()],
      total: 1,
      limit: 25,
      offset: 0,
    })

    renderPage()

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Filter by tool name…')).toBeTruthy()
      expect(screen.getByPlaceholderText('Session ID…')).toBeTruthy()
      expect(screen.getByText('Export')).toBeTruthy()
    })
  })

  it('renders time preset buttons', async () => {
    mockFetchAudit.mockResolvedValue({
      data: [makeAuditRecord()],
      total: 1,
      limit: 25,
      offset: 0,
    })

    renderPage()

    await waitFor(() => {
      expect(screen.getByText('1h')).toBeTruthy()
      expect(screen.getByText('24h')).toBeTruthy()
      expect(screen.getByText('7d')).toBeTruthy()
      expect(screen.getByText('Custom')).toBeTruthy()
    })
  })

  it('renders pagination when there are records', async () => {
    mockFetchAudit.mockResolvedValue({
      data: [makeAuditRecord()],
      total: 50,
      limit: 25,
      offset: 0,
    })

    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Previous')).toBeTruthy()
      expect(screen.getByText('Next')).toBeTruthy()
      expect(screen.getByText('Page 1 of 2')).toBeTruthy()
    })
  })

  it('subscribes to SSE action events', async () => {
    mockFetchAudit.mockResolvedValue({
      data: [makeAuditRecord()],
      total: 1,
      limit: 25,
      offset: 0,
    })

    renderPage()

    await waitFor(() => {
      expect(mockSubscribe).toHaveBeenCalledWith('action', expect.any(Function))
    })
  })

  it('opens detail panel on row click and loads record', async () => {
    const record = makeAuditRecord()
    mockFetchAudit.mockResolvedValue({
      data: [record],
      total: 1,
      limit: 25,
      offset: 0,
    })
    mockFetchAuditRecord.mockResolvedValue(record)

    renderPage()

    await waitFor(() => {
      expect(screen.getByText('send_email')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('send_email'))

    await waitFor(() => {
      expect(mockFetchAuditRecord).toHaveBeenCalledWith('rec-001')
      expect(screen.getByText('Input Parameters')).toBeTruthy()
    })
  })

  it('shows error in detail panel when record fetch fails', async () => {
    mockFetchAudit.mockResolvedValue({
      data: [makeAuditRecord()],
      total: 1,
      limit: 25,
      offset: 0,
    })
    mockFetchAuditRecord.mockRejectedValue(new Error('Record not found'))

    renderPage()

    await waitFor(() => {
      expect(screen.getByText('send_email')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('send_email'))

    await waitFor(() => {
      expect(screen.getByText('Record not found')).toBeTruthy()
    })
  })

  it('shows error state on fetch failure', async () => {
    mockFetchAudit.mockRejectedValue(new Error('Network error'))

    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy()
      expect(screen.getByText('Retry')).toBeTruthy()
    })
  })

  it('renders export dropdown items', async () => {
    mockFetchAudit.mockResolvedValue({
      data: [makeAuditRecord()],
      total: 1,
      limit: 25,
      offset: 0,
    })

    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Export')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('Export'))
    expect(screen.getByText('Export JSON')).toBeTruthy()
    expect(screen.getByText('Export CSV')).toBeTruthy()
  })
})
