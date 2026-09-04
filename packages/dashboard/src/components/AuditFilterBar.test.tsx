import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AuditFilterBar } from './AuditFilterBar'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultProps() {
  return {
    filters: {
      tool: '',
      decision: null,
      reason: null,
      session: '',
      from: '',
      to: '',
      upstream_status_min: '',
      upstream_status_max: '',
      origin: '',
      record_kind: '',
      channel: '',
      sender: '',
      upstream: '',
      session_source: '',
    },
    setFilter: vi.fn(),
    setBulkFilters: vi.fn(),
    hasAttributedRows: false,
  } as const
}

type RenderBarOverrides = Omit<Partial<Parameters<typeof AuditFilterBar>[0]>, 'filters'> & {
  filters?: Partial<Parameters<typeof AuditFilterBar>[0]['filters']>
}

function renderBar(overrides: RenderBarOverrides = {}) {
  const base = defaultProps()
  const props = {
    ...base,
    ...overrides,
    filters: { ...base.filters, ...(overrides.filters ?? {}) },
  }
  return render(<AuditFilterBar {...props} />)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditFilterBar', () => {
  it('renders tool name input', () => {
    render(<AuditFilterBar {...defaultProps()} />)
    expect(screen.getByPlaceholderText('Filter by tool name…')).toBeTruthy()
  })

  it('renders session ID input', () => {
    render(<AuditFilterBar {...defaultProps()} />)
    expect(screen.getByPlaceholderText('Session ID…')).toBeTruthy()
  })

  it('renders all decision filter buttons', () => {
    render(<AuditFilterBar {...defaultProps()} />)
    // "All" appears in both decision filters and time presets
    expect(screen.getAllByText('All').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Allow')).toBeTruthy()
    expect(screen.getByText('Deny')).toBeTruthy()
    expect(screen.getAllByText('Approval Denied').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Approval Timeout').length).toBeGreaterThanOrEqual(1)
  })

  it('renders time preset buttons', () => {
    render(<AuditFilterBar {...defaultProps()} />)
    expect(screen.getByText('1h')).toBeTruthy()
    expect(screen.getByText('24h')).toBeTruthy()
    expect(screen.getByText('7d')).toBeTruthy()
    expect(screen.getByText('Custom')).toBeTruthy()
  })

  it('calls setFilter on tool name input change', () => {
    const props = defaultProps()
    render(<AuditFilterBar {...props} />)
    fireEvent.change(screen.getByPlaceholderText('Filter by tool name…'), {
      target: { value: 'send' },
    })
    expect(props.setFilter).toHaveBeenCalledWith('tool', 'send')
  })

  it('calls setFilter on decision pill click', () => {
    const props = defaultProps()
    render(<AuditFilterBar {...props} />)
    fireEvent.click(screen.getByText('Deny'))
    expect(props.setFilter).toHaveBeenCalledWith('decision', 'deny')
  })

  it('calls setBulkFilters when time preset is clicked', () => {
    const props = defaultProps()
    render(<AuditFilterBar {...props} />)
    fireEvent.click(screen.getByText('1h'))
    expect(props.setBulkFilters).toHaveBeenCalledWith(expect.objectContaining({ to: '' }))
    // "from" should be a recent ISO string
    const firstCall = props.setBulkFilters.mock.calls[0]
    if (!firstCall) throw new Error('expected setBulkFilters to have been called')
    const call = firstCall[0] as Record<string, string>
    expect(call.from).toBeTruthy()
  })

  it('shows custom date inputs when Custom is clicked', () => {
    render(<AuditFilterBar {...defaultProps()} />)
    fireEvent.click(screen.getByText('Custom'))
    const dateInputs = screen.getAllByDisplayValue('')
    // At minimum the two datetime-local inputs are present
    expect(dateInputs.length).toBeGreaterThanOrEqual(2)
  })

  it('renders export button and dropdown', () => {
    render(<AuditFilterBar {...defaultProps()} />)
    const exportBtn = screen.getByText('Export')
    expect(exportBtn).toBeTruthy()

    fireEvent.click(exportBtn)
    expect(screen.getByText('Export JSON')).toBeTruthy()
    expect(screen.getByText('Export CSV')).toBeTruthy()
  })

  it('highlights active decision filter', () => {
    const props = defaultProps()
    render(<AuditFilterBar {...props} filters={{ ...props.filters, decision: 'deny' }} />)
    const denyBtn = screen.getByText('Deny')
    expect(denyBtn.className).toContain('bg-gray-900')
  })

  it('calls setFilter on session ID input change', () => {
    const props = defaultProps()
    render(<AuditFilterBar {...props} />)
    fireEvent.change(screen.getByPlaceholderText('Session ID…'), {
      target: { value: 'sess-123' },
    })
    expect(props.setFilter).toHaveBeenCalledWith('session', 'sess-123')
  })

  it('calls setFilter on upstream status range input change', () => {
    const props = defaultProps()
    render(<AuditFilterBar {...props} />)
    fireEvent.change(screen.getByPlaceholderText('Status min'), {
      target: { value: '500' },
    })
    fireEvent.change(screen.getByPlaceholderText('Status max'), {
      target: { value: '599' },
    })
    expect(props.setFilter).toHaveBeenCalledWith('upstream_status_min', '500')
    expect(props.setFilter).toHaveBeenCalledWith('upstream_status_max', '599')
  })

  it('exports without bearer headers and relies on same-origin cookies', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const createObjectURLMock = vi.fn(() => 'blob:http://localhost/fake')
    const revokeObjectURLMock = vi.fn()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: createObjectURLMock,
      revokeObjectURL: revokeObjectURLMock,
    })
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)

    render(<AuditFilterBar {...defaultProps()} />)
    fireEvent.click(screen.getByText('Export'))
    fireEvent.click(screen.getByText('Export JSON'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/audit/export?format=json')
    })

    clickSpy.mockRestore()
  })

  it('clears time filters when "All" preset is clicked', () => {
    const props = defaultProps()
    render(<AuditFilterBar {...props} />)
    // "All" appears in both decision and time rows — click the one in the time row
    const allButtons = screen.getAllByText('All')
    // The time preset "All" is the one rendered after decision filters
    const lastAll = allButtons.at(-1)
    if (!lastAll) throw new Error('no "All" buttons found')
    fireEvent.click(lastAll)
    expect(props.setBulkFilters).toHaveBeenCalledWith({ from: '', to: '' })
  })

  it('renders the upstream input when the current page has attributed rows (issue #297)', () => {
    const setFilter = vi.fn()
    renderBar({ setFilter, hasAttributedRows: true })
    const input = screen.getByPlaceholderText('Filter by upstream…')
    fireEvent.change(input, { target: { value: 'alpha' } })
    expect(setFilter).toHaveBeenCalledWith('upstream', 'alpha')
  })

  it('hides the upstream input for all-null data with no filter set (issue #297)', () => {
    renderBar()
    expect(screen.queryByPlaceholderText('Filter by upstream…')).toBeNull()
  })

  it('keeps the upstream input rendered when its filter matches zero rows (issue #297)', () => {
    // The disappearing-control trap: filtering to a door with no rows must
    // not hide the control that caused the empty result set.
    renderBar({ filters: { upstream: 'ghost' } })
    expect(screen.getByPlaceholderText('Filter by upstream…')).toBeTruthy()
  })

  it('renders the session source select with the five identity sources (issue #250)', () => {
    const setFilter = vi.fn()
    renderBar({ setFilter })
    expect(screen.getByRole('option', { name: 'All Sources' })).toBeTruthy()
    for (const value of ['header', 'meta', 'legacy_header', 'transport', 'sideband']) {
      expect(screen.getByRole('option', { name: value })).toBeTruthy()
    }
    const select = screen.getByLabelText('Session Source')
    fireEvent.change(select, { target: { value: 'legacy_header' } })
    expect(setFilter).toHaveBeenCalledWith('session_source', 'legacy_header')
  })

  it('includes upstream and session_source in the export URL (issues #297/#250)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const createObjectURLMock = vi.fn(() => 'blob:http://localhost/fake')
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: createObjectURLMock,
      revokeObjectURL: vi.fn(),
    })
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)

    renderBar({ filters: { upstream: 'alpha', session_source: 'header' } })
    fireEvent.click(screen.getByText('Export'))
    fireEvent.click(screen.getByText('Export JSON'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('upstream=alpha'))
    })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('session_source=header'))

    clickSpy.mockRestore()
  })

  it('exposes an Install Denied block-reason option (#16)', () => {
    renderBar()
    expect(screen.getByRole('option', { name: 'Install Denied' })).toBeTruthy()
  })

  it('exposes a Header Mismatch block-reason option and applies its filter value (#226)', () => {
    const setFilter = vi.fn()
    renderBar({ setFilter })
    const option = screen.getByRole('option', { name: 'Header Mismatch' })
    expect(option.getAttribute('value')).toBe('header_mismatch')
    const select = option.closest('select')
    if (!select) throw new Error('Header Mismatch option not inside a select')
    fireEvent.change(select, { target: { value: 'header_mismatch' } })
    expect(setFilter).toHaveBeenCalledWith('reason', 'header_mismatch')
  })

  it('renders an origin free-text input and a record-kind select, calling setFilter (#16)', () => {
    const setFilter = vi.fn()
    renderBar({ setFilter })
    fireEvent.change(screen.getByLabelText('Origin'), { target: { value: 'some_future_adapter' } })
    expect(setFilter).toHaveBeenCalledWith('origin', 'some_future_adapter')
    fireEvent.change(screen.getByLabelText('Record Kind'), { target: { value: 'install_scan' } })
    expect(setFilter).toHaveBeenCalledWith('record_kind', 'install_scan')
    fireEvent.change(screen.getByLabelText('Record Kind'), { target: { value: 'policy_reload' } })
    expect(setFilter).toHaveBeenCalledWith('record_kind', 'policy_reload')
  })

  it('renders channel and sender free-text inputs, calling setFilter (#16)', () => {
    const setFilter = vi.fn()
    renderBar({ setFilter })
    fireEvent.change(screen.getByPlaceholderText('Channel ID…'), { target: { value: 'ch-abc' } })
    expect(setFilter).toHaveBeenCalledWith('channel', 'ch-abc')
    fireEvent.change(screen.getByPlaceholderText('Sender ID…'), { target: { value: 'user-42' } })
    expect(setFilter).toHaveBeenCalledWith('sender', 'user-42')
  })

  it('includes origin/record_kind/channel_id/sender_id in export URL when set (#16)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const createObjectURLMock = vi.fn(() => 'blob:http://localhost/fake')
    const revokeObjectURLMock = vi.fn()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: createObjectURLMock,
      revokeObjectURL: revokeObjectURLMock,
    })
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)

    renderBar({
      filters: {
        origin: 'openclaw',
        record_kind: 'install_scan',
        channel: 'ch-1',
        sender: 'user-1',
      },
    })
    fireEvent.click(screen.getByText('Export'))
    fireEvent.click(screen.getByText('Export JSON'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const calledUrl: string = (fetchMock.mock.calls[0] as [string])[0]
      expect(calledUrl).toContain('origin=openclaw')
      expect(calledUrl).toContain('record_kind=install_scan')
      expect(calledUrl).toContain('channel_id=ch-1')
      expect(calledUrl).toContain('sender_id=user-1')
    })

    clickSpy.mockRestore()
  })
})
