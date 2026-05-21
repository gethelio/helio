import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageError } from './PageError'

describe('PageError', () => {
  it('renders the error message', () => {
    render(<PageError error="Failed to load feed" />)
    expect(screen.getByText('Failed to load feed')).toBeTruthy()
  })

  it('renders a Retry button', () => {
    render(<PageError error="Network error" />)
    const button = screen.getByRole('button', { name: 'Retry' })
    expect(button).toBeTruthy()
    expect(button.getAttribute('type')).toBe('button')
  })
})
