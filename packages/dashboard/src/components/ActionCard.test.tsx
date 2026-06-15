import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ActionCard } from './ActionCard'
import type { ActionEvent, AuditRecord } from '../types'

const baseRecord: ActionEvent = {
  id: 'abc12345678',
  tool_name: 'create_payment',
  policy_decision: 'allow',
  block_reason: null,
  approval_status: null,
  session_id: 'sess-12345678901234',
  agent_id: null,
  environment: null,
  timestamp: new Date().toISOString(),
  total_duration_ms: 3.5,
  approval_wait_ms: 0,
  proxy_compute_ms: 2.3,
  flagged_destructive: false,
  dry_run: false,
  matched_rule: 'rule-1',
  matched_rule_index: 1,
  record_kind: 'tool_call',
  origin: 'mcp',
}

describe('ActionCard', () => {
  it('renders tool name', () => {
    render(<ActionCard record={baseRecord} expanded={false} onToggle={vi.fn()} />)
    expect(screen.getByText('create_payment')).toBeTruthy()
  })

  it('renders PolicyBadge with correct decision', () => {
    render(<ActionCard record={baseRecord} expanded={false} onToggle={vi.fn()} />)
    expect(screen.getByText('Allow')).toBeTruthy()
  })

  it('renders formatted latency', () => {
    render(<ActionCard record={baseRecord} expanded={false} onToggle={vi.fn()} />)
    expect(screen.getByText('4ms')).toBeTruthy()
  })

  it('renders truncated session ID', () => {
    render(<ActionCard record={baseRecord} expanded={false} onToggle={vi.fn()} />)
    expect(screen.getByText('sess-123\u2026')).toBeTruthy()
  })

  it('does not show detail section when collapsed', () => {
    render(<ActionCard record={baseRecord} expanded={false} onToggle={vi.fn()} />)
    expect(screen.queryByText('Input')).toBeNull()
  })

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn()
    render(<ActionCard record={baseRecord} expanded={false} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('shows error message when expanded with error', () => {
    render(
      <ActionCard
        record={baseRecord}
        expanded={true}
        onToggle={vi.fn()}
        error="Failed to load record details"
      />,
    )
    expect(screen.getByText('Failed to load record details')).toBeTruthy()
  })

  it('shows destructive styling when flagged', () => {
    const destructiveRecord = { ...baseRecord, flagged_destructive: true }
    const { container } = render(
      <ActionCard record={destructiveRecord} expanded={false} onToggle={vi.fn()} />,
    )
    const card = container.firstElementChild
    expect(card?.className).toContain('border-l-red-400')
  })

  it('shows origin and kind chip on the feed card summary (#16)', () => {
    render(
      <ActionCard
        record={{ ...baseRecord, origin: 'openclaw', record_kind: 'install_scan' }}
        expanded={false}
        onToggle={vi.fn()}
      />,
    )
    expect(screen.getByText('OpenClaw')).toBeTruthy()
    expect(screen.getByText('Install Scan')).toBeTruthy()
  })

  it('shows channel/sender in expanded detail when present (#16)', () => {
    const expandedRecord: AuditRecord = {
      ...baseRecord,
      tool_input: {},
      evidence_chain: null,
      approval_status: null,
      approved_by: null,
      upstream_response: null,
      upstream_error: null,
      upstream_http_status: null,
      upstream_latency_ms: null,
      block_reason: null,
      created_at: new Date().toISOString(),
      metadata: { channel_id: 'C1', sender_id: 'U1' },
    }
    render(
      <ActionCard
        record={baseRecord}
        expanded={true}
        onToggle={vi.fn()}
        expandedRecord={expandedRecord}
      />,
    )
    expect(screen.getByText(/C1/)).toBeTruthy()
    expect(screen.getByText(/U1/)).toBeTruthy()
  })

  it('truncates oversized detail payloads with an inline note', () => {
    const huge = 'x'.repeat(9_000)
    const expandedRecord: AuditRecord = {
      ...baseRecord,
      tool_input: { payload: huge },
      evidence_chain: null,
      approval_status: null,
      approved_by: null,
      upstream_response: null,
      upstream_error: null,
      upstream_http_status: null,
      upstream_latency_ms: null,
      block_reason: null,
      created_at: new Date().toISOString(),
      metadata: null,
    }

    render(
      <ActionCard
        record={baseRecord}
        expanded={true}
        onToggle={vi.fn()}
        expandedRecord={expandedRecord}
      />,
    )

    expect(screen.getByText('Input payload preview is truncated for readability.')).toBeTruthy()
  })
})
