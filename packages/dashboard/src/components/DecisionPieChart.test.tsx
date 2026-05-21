import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { DecisionPieChart } from './DecisionPieChart'

describe('DecisionPieChart', () => {
  it('renders without crashing with valid data', () => {
    const data = [
      { decision: 'allow', count: 50 },
      { decision: 'deny', count: 10 },
    ]
    const { container } = render(<DecisionPieChart data={data} />)
    expect(container.querySelector('.recharts-responsive-container')).toBeTruthy()
  })

  it('renders without crashing with empty data', () => {
    const { container } = render(<DecisionPieChart data={[]} />)
    expect(container.querySelector('.recharts-responsive-container')).toBeTruthy()
  })
})
