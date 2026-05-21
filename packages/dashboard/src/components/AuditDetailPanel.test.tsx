import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AuditDetailPanel } from './AuditDetailPanel'
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
  }
  return {
    ...defaults,
    ...overrides,
    environment: overrides.environment ?? defaults.environment,
    matched_rule_index: overrides.matched_rule_index ?? defaults.matched_rule_index,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditDetailPanel', () => {
  it('renders loading skeleton when detailLoading is true', () => {
    const { container } = render(
      <AuditDetailPanel
        selectedRecord={null}
        detailLoading={true}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
  })

  it('renders record details when selectedRecord is provided', () => {
    render(
      <AuditDetailPanel
        selectedRecord={makeRecord()}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('send_email')).toBeTruthy()
    expect(screen.getByText('Decision')).toBeTruthy()
    expect(screen.getByText('Input Parameters')).toBeTruthy()
  })

  it('renders error message when detailError is set', () => {
    render(
      <AuditDetailPanel
        selectedRecord={null}
        detailLoading={false}
        detailError="Record not found"
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Record not found')).toBeTruthy()
  })

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn()
    render(
      <AuditDetailPanel
        selectedRecord={makeRecord()}
        detailLoading={false}
        detailError={null}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn()
    render(
      <AuditDetailPanel
        selectedRecord={makeRecord()}
        detailLoading={false}
        detailError={null}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByLabelText('Close detail panel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders matched rule when present', () => {
    render(
      <AuditDetailPanel
        selectedRecord={makeRecord({ matched_rule: 'deny-destructive' })}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Matched Rule')).toBeTruthy()
    expect(screen.getByText('deny-destructive')).toBeTruthy()
  })

  it('renders approval details when present', () => {
    render(
      <AuditDetailPanel
        selectedRecord={makeRecord({
          approval_status: 'approved',
          approved_by: 'alice',
        })}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Approval')).toBeTruthy()
    expect(screen.getByText('approved by alice')).toBeTruthy()
  })

  it('renders destructive flag when flagged', () => {
    render(
      <AuditDetailPanel
        selectedRecord={makeRecord({ flagged_destructive: true })}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Flags')).toBeTruthy()
    expect(screen.getByText('Destructive')).toBeTruthy()
  })

  it('renders latency information', () => {
    render(
      <AuditDetailPanel
        selectedRecord={makeRecord({
          total_duration_ms: 3.5,
          proxy_compute_ms: 1.2,
          upstream_latency_ms: 12,
        })}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Duration')).toBeTruthy()
  })

  it('renders upstream error when present', () => {
    render(
      <AuditDetailPanel
        selectedRecord={makeRecord({ upstream_error: 'timeout' })}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Upstream Error')).toBeTruthy()
    expect(screen.getByText('timeout')).toBeTruthy()
  })

  it('renders dry run badge when dry_run is true', () => {
    render(
      <AuditDetailPanel
        selectedRecord={makeRecord({ dry_run: true })}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Flags')).toBeTruthy()
    // "Dry Run" appears in both the Decision badge and the Flags section
    expect(screen.getAllByText('Dry Run').length).toBeGreaterThanOrEqual(2)
  })

  it('renders upstream response when present', () => {
    render(
      <AuditDetailPanel
        selectedRecord={makeRecord({ upstream_response: { result: 'ok' } })}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Upstream Response')).toBeTruthy()
  })

  it('renders evidence chain when present', () => {
    render(
      <AuditDetailPanel
        selectedRecord={makeRecord({
          evidence_chain: { steps: [{ check: 'evidence', key: 'order', result: 'pass' }] },
        })}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Evidence Chain')).toBeTruthy()
  })

  it('renders upstream_error under 4KB without truncation', () => {
    const msg = 'connection refused after 5 retries'
    render(
      <AuditDetailPanel
        selectedRecord={makeRecord({ upstream_error: msg })}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    const node = screen.getByText(msg)
    expect(node).toBeTruthy()
    // No truncation suffix on short strings
    expect(node.textContent).not.toContain('\u2026')
  })

  it('truncates upstream_error over 4KB to prevent layout breakage', () => {
    const long = 'x'.repeat(10_000)
    const { container } = render(
      <AuditDetailPanel
        selectedRecord={makeRecord({ upstream_error: long })}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    // The full 10k-character error must not be rendered as-is; the UI
    // has to cap it so a single row in the audit log cannot blow up
    // the detail panel layout.
    const errorSection = container.querySelector('[class*="text-red-600"]')
    expect(errorSection).toBeTruthy()
    const rendered = errorSection?.textContent ?? ''
    expect(rendered.length).toBeLessThan(long.length)
    expect(rendered.length).toBeLessThanOrEqual(4096 + 4)
    expect(rendered).toContain('\u2026')
  })

  it('renders upstream_response under 4KB without truncation', () => {
    const { container } = render(
      <AuditDetailPanel
        selectedRecord={makeRecord({ upstream_response: { result: 'ok' } })}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    const pre = container.querySelector('[data-testid="upstream-response-json"]')
    expect(pre).toBeTruthy()
    const rendered = pre?.textContent ?? ''
    expect(rendered).toContain('"result"')
    expect(rendered).toContain('"ok"')
    expect(rendered).not.toContain('\u2026')
  })

  it('truncates upstream_response over 4KB to prevent layout breakage', () => {
    // A single upstream-controlled JSON field with megabytes of text
    // must be capped the same way as `upstream_error` — otherwise the
    // detail panel re-stringifies the full payload on every render and
    // horizontally overflows the `pre`.
    const long = 'x'.repeat(10_000)
    const { container } = render(
      <AuditDetailPanel
        selectedRecord={makeRecord({ upstream_response: { data: long } })}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    const pre = container.querySelector('[data-testid="upstream-response-json"]')
    expect(pre).toBeTruthy()
    const rendered = pre?.textContent ?? ''
    expect(rendered.length).toBeLessThan(long.length)
    expect(rendered.length).toBeLessThanOrEqual(4096 + 4)
    expect(rendered).toContain('\u2026')
  })

  it('truncates tool_input over 4KB to prevent detail panel freezes', () => {
    const long = 'x'.repeat(10_000)
    const { container } = render(
      <AuditDetailPanel
        selectedRecord={makeRecord({ tool_input: { payload: long } })}
        detailLoading={false}
        detailError={null}
        onClose={vi.fn()}
      />,
    )
    const inputPre = container.querySelector('pre')
    expect(inputPre).toBeTruthy()
    const rendered = inputPre?.textContent ?? ''
    expect(rendered.length).toBeLessThan(long.length)
    expect(rendered.length).toBeLessThanOrEqual(4096 + 4)
    expect(rendered).toContain('\u2026')
    expect(screen.getByText('Input payload preview is truncated for readability.')).toBeTruthy()
  })
})
