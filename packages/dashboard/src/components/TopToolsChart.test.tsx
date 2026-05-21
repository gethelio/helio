import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TopToolsChart } from './TopToolsChart'

describe('TopToolsChart', () => {
  it('renders without crashing with valid data', () => {
    const data = [
      { tool_name: 'send_email', count: 42 },
      { tool_name: 'create_payment', count: 18 },
    ]
    const { container } = render(<TopToolsChart data={data} />)
    expect(container.querySelector('.recharts-responsive-container')).toBeTruthy()
  })

  it('renders without crashing with empty data', () => {
    const { container } = render(<TopToolsChart data={[]} />)
    expect(container.querySelector('.recharts-responsive-container')).toBeTruthy()
  })

  it('computes dynamic chart height based on data length', () => {
    const data = [
      { tool_name: 'a', count: 1 },
      { tool_name: 'b', count: 2 },
      { tool_name: 'c', count: 3 },
      { tool_name: 'd', count: 4 },
      { tool_name: 'e', count: 5 },
    ]
    const { container } = render(<TopToolsChart data={data} />)
    const rc = container.querySelector('.recharts-responsive-container')
    // Dynamic height = max(120, data.length * 36 + 20) = max(120, 200) = 200
    expect(rc?.getAttribute('style')).toContain('200')
  })

  it('enforces minimum height of 120', () => {
    const data = [{ tool_name: 'a', count: 1 }]
    const { container } = render(<TopToolsChart data={data} />)
    const rc = container.querySelector('.recharts-responsive-container')
    // Dynamic height = max(120, 1 * 36 + 20) = max(120, 56) = 120
    expect(rc?.getAttribute('style')).toContain('120')
  })
})
