import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Sidebar } from './Sidebar'

function renderSidebar(open = true, onClose = vi.fn()) {
  return render(
    <MemoryRouter>
      <Sidebar open={open} onClose={onClose} />
    </MemoryRouter>,
  )
}

describe('Sidebar', () => {
  it('renders all 6 nav links', () => {
    renderSidebar()
    expect(screen.getByText('Feed')).toBeTruthy()
    expect(screen.getByText('Approvals')).toBeTruthy()
    expect(screen.getByText('Audit')).toBeTruthy()
    expect(screen.getByText('Limits')).toBeTruthy()
    expect(screen.getByText('Budgets')).toBeTruthy()
    expect(screen.getByText('Analytics')).toBeTruthy()
  })

  it('calls onClose when a nav link is clicked', () => {
    const onClose = vi.fn()
    renderSidebar(true, onClose)
    fireEvent.click(screen.getByText('Approvals'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders mobile overlay when open', () => {
    renderSidebar(true)
    expect(screen.getByLabelText('Close navigation')).toBeTruthy()
  })

  it('does not render overlay when closed', () => {
    renderSidebar(false)
    expect(screen.queryByLabelText('Close navigation')).toBeNull()
  })

  it('calls onClose when overlay is clicked', () => {
    const onClose = vi.fn()
    renderSidebar(true, onClose)
    fireEvent.click(screen.getByLabelText('Close navigation'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
