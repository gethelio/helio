import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AuditTable } from './AuditTable'
import type { AuditRecord } from '../types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
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

function defaultProps() {
  return {
    records: [makeRecord()] as readonly AuditRecord[],
    selectedId: null,
    page: 1,
    totalPages: 1,
    limit: 25,
    loading: false,
    onRowClick: vi.fn(),
    onPageChange: vi.fn(),
    onLimitChange: vi.fn(),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditTable', () => {
  it('renders table with record data', () => {
    render(<AuditTable {...defaultProps()} />)
    expect(screen.getByText('send_email')).toBeTruthy()
  })

  it('renders column headers', () => {
    render(<AuditTable {...defaultProps()} />)
    expect(screen.getByText('Timestamp')).toBeTruthy()
    expect(screen.getByText('Tool')).toBeTruthy()
    expect(screen.getByText('Decision')).toBeTruthy()
    expect(screen.getByText('Duration')).toBeTruthy()
  })

  it('calls onRowClick when a row is clicked', () => {
    const props = defaultProps()
    render(<AuditTable {...props} />)
    fireEvent.click(screen.getByText('send_email'))
    expect(props.onRowClick).toHaveBeenCalledWith('rec-001')
  })

  it('highlights selected row', () => {
    const props = { ...defaultProps(), selectedId: 'rec-001' }
    render(<AuditTable {...props} />)
    const row = screen.getByText('send_email').closest('tr')
    if (!row) throw new Error('expected <tr> ancestor for "send_email" cell')
    expect(row.className).toContain('bg-blue-50')
  })

  it('renders pagination controls', () => {
    const props = { ...defaultProps(), totalPages: 3, page: 2 }
    render(<AuditTable {...props} />)
    expect(screen.getByText('Previous')).toBeTruthy()
    expect(screen.getByText('Next')).toBeTruthy()
    expect(screen.getByText('Page 2 of 3')).toBeTruthy()
  })

  it('disables Previous on first page', () => {
    const props = { ...defaultProps(), page: 1, totalPages: 3 }
    render(<AuditTable {...props} />)
    expect(screen.getByText('Previous').hasAttribute('disabled')).toBe(true)
  })

  it('disables Next on last page', () => {
    const props = { ...defaultProps(), page: 3, totalPages: 3 }
    render(<AuditTable {...props} />)
    expect(screen.getByText('Next').hasAttribute('disabled')).toBe(true)
  })

  it('calls onPageChange when Next is clicked', () => {
    const props = { ...defaultProps(), page: 1, totalPages: 3 }
    render(<AuditTable {...props} />)
    fireEvent.click(screen.getByText('Next'))
    expect(props.onPageChange).toHaveBeenCalledWith(2)
  })

  it('shows loading bar when loading', () => {
    const { container } = render(<AuditTable {...defaultProps()} loading={true} />)
    expect(container.querySelector('.animate-pulse')).toBeTruthy()
  })

  it('returns null when records are empty and not loading', () => {
    const { container } = render(<AuditTable {...defaultProps()} records={[]} loading={false} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders destructive flag indicator', () => {
    const props = {
      ...defaultProps(),
      records: [makeRecord({ flagged_destructive: true })],
    }
    const { container } = render(<AuditTable {...props} />)
    expect(container.querySelector('.bg-red-400')).toBeTruthy()
  })

  it('renders multiple records', () => {
    const props = {
      ...defaultProps(),
      records: [
        makeRecord({ id: 'rec-001', tool_name: 'send_email' }),
        makeRecord({ id: 'rec-002', tool_name: 'delete_file' }),
        makeRecord({ id: 'rec-003', tool_name: 'read_config' }),
      ],
    }
    render(<AuditTable {...props} />)
    expect(screen.getByText('send_email')).toBeTruthy()
    expect(screen.getByText('delete_file')).toBeTruthy()
    expect(screen.getByText('read_config')).toBeTruthy()
  })

  it('calls onLimitChange when page size is changed', () => {
    const props = { ...defaultProps(), totalPages: 3 }
    render(<AuditTable {...props} />)
    fireEvent.change(screen.getByDisplayValue('25'), { target: { value: '50' } })
    expect(props.onLimitChange).toHaveBeenCalledWith(50)
  })

  it('renders an Origin column with the friendly label and kind chip (#16)', () => {
    const props = {
      ...defaultProps(),
      records: [makeRecord({ origin: 'openclaw', record_kind: 'install_scan' })],
    }
    render(<AuditTable {...props} />)
    expect(screen.getByText('OpenClaw')).toBeTruthy()
    expect(screen.getByText('Install Scan')).toBeTruthy()
  })

  it('renders channel_id/sender_id from metadata (#16)', () => {
    const props = {
      ...defaultProps(),
      records: [makeRecord({ metadata: { channel_id: 'C123', sender_id: 'U1' } })],
    }
    render(<AuditTable {...props} />)
    expect(screen.getByText('C123')).toBeTruthy()
    expect(screen.getByText('U1')).toBeTruthy()
  })
})
