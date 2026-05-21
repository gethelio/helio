import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StatusIndicator } from './StatusIndicator'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('StatusIndicator', () => {
  it('renders green dot when connected', () => {
    const { container } = render(<StatusIndicator connected={true} />)
    const dot = container.querySelector('.bg-emerald-500')
    expect(dot).toBeTruthy()
  })

  it('renders red dot when disconnected', () => {
    const { container } = render(<StatusIndicator connected={false} />)
    const dot = container.querySelector('.bg-red-500')
    expect(dot).toBeTruthy()
  })

  it('shows Connected text when connected', () => {
    render(<StatusIndicator connected={true} />)
    expect(screen.getByText('Connected')).toBeTruthy()
  })

  it('shows Disconnected text when disconnected', () => {
    render(<StatusIndicator connected={false} />)
    expect(screen.getByText('Disconnected')).toBeTruthy()
  })

  it('shows tooltip with version on click', () => {
    render(<StatusIndicator connected={true} version="1.2.3" uptimeSeconds={3661} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Version: 1.2.3')).toBeTruthy()
  })

  it('shows formatted uptime in tooltip', () => {
    render(<StatusIndicator connected={true} uptimeSeconds={3661} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Uptime: 1h 1m')).toBeTruthy()
  })

  it('shows minutes-only format for uptimes under 1h', () => {
    render(<StatusIndicator connected={true} uptimeSeconds={300} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Uptime: 5m')).toBeTruthy()
  })
})
