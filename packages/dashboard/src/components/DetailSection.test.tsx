import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DetailSection } from './DetailSection'

describe('DetailSection', () => {
  it('renders label text', () => {
    render(<DetailSection label="Decision">Allow</DetailSection>)
    expect(screen.getByText('Decision')).toBeTruthy()
  })

  it('renders children content', () => {
    render(
      <DetailSection label="Input">
        <pre>{'{ "amount": 100 }'}</pre>
      </DetailSection>,
    )
    expect(screen.getByText('{ "amount": 100 }')).toBeTruthy()
  })
})
