import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TimeSeriesChart } from './TimeSeriesChart'

describe('TimeSeriesChart', () => {
  it('renders without crashing with valid data', () => {
    const data = [
      { bucket: '2025-01-15T10:00:00Z', count: 5 },
      { bucket: '2025-01-15T11:00:00Z', count: 12 },
    ]
    const { container } = render(<TimeSeriesChart data={data} />)
    expect(container.querySelector('.recharts-responsive-container')).toBeTruthy()
  })

  it('renders without crashing with empty data', () => {
    const { container } = render(<TimeSeriesChart data={[]} />)
    expect(container.querySelector('.recharts-responsive-container')).toBeTruthy()
  })
})
