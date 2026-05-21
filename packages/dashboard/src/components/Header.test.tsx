import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Header } from './Header'

vi.mock('../api', () => ({
  fetchHealth: () => Promise.resolve({ status: 'ok', version: '0.0.0', uptime: 120 }),
}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Header', () => {
  it('renders Dashboard title', async () => {
    render(<Header connected={true} onToggleSidebar={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeTruthy()
    })
  })

  it('renders mobile menu button with aria label', async () => {
    render(<Header connected={true} onToggleSidebar={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByLabelText('Toggle navigation')).toBeTruthy()
    })
  })

  it('calls onToggleSidebar when menu button is clicked', async () => {
    const onToggle = vi.fn()
    render(<Header connected={true} onToggleSidebar={onToggle} />)
    await waitFor(() => {
      expect(screen.getByLabelText('Toggle navigation')).toBeTruthy()
    })
    fireEvent.click(screen.getByLabelText('Toggle navigation'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('renders StatusIndicator with connected state', async () => {
    render(<Header connected={true} onToggleSidebar={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeTruthy()
    })
  })

  it('renders StatusIndicator with disconnected state', async () => {
    render(<Header connected={false} onToggleSidebar={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Disconnected')).toBeTruthy()
    })
  })
})
