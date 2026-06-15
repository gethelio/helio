import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OriginBadge } from './OriginBadge'

describe('OriginBadge', () => {
  it('renders the friendly origin label', () => {
    render(<OriginBadge origin="openclaw" recordKind="tool_call" />)
    expect(screen.getByText('OpenClaw')).toBeTruthy()
  })
  it('renders a kind chip for non-tool_call kinds', () => {
    render(<OriginBadge origin="openclaw" recordKind="install_scan" />)
    expect(screen.getByText('Install Scan')).toBeTruthy()
  })
  it('renders no kind chip for tool_call', () => {
    render(<OriginBadge origin="mcp" recordKind="tool_call" />)
    expect(screen.queryByText('Install Scan')).toBeNull()
  })
})
