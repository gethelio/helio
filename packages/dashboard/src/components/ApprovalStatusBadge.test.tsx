import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ApprovalStatusBadge } from './ApprovalStatusBadge'
import type { ApprovalStatus } from '../types'

describe('ApprovalStatusBadge', () => {
  it.each<[ApprovalStatus, string]>([
    ['pending', 'bg-amber-50'],
    ['approved', 'bg-emerald-50'],
    ['denied', 'bg-red-50'],
    ['timeout', 'bg-orange-50'],
    ['break_glass', 'bg-purple-50'],
    ['client_disconnected', 'bg-gray-100'],
    ['shutdown_cancelled', 'bg-slate-100'],
  ])('renders %s with correct color class', (status, expectedClass) => {
    render(<ApprovalStatusBadge status={status} />)
    const badge = screen.getByText(/.+/)
    expect(badge.className).toContain(expectedClass)
  })

  it('formats snake_case status to Title Case', () => {
    render(<ApprovalStatusBadge status="break_glass" />)
    expect(screen.getByText('Break Glass')).toBeTruthy()
  })

  it('formats client_disconnected status for operators', () => {
    render(<ApprovalStatusBadge status="client_disconnected" />)
    expect(screen.getByText('Client Disconnected')).toBeTruthy()
  })

  it('formats shutdown_cancelled status for operators', () => {
    render(<ApprovalStatusBadge status="shutdown_cancelled" />)
    expect(screen.getByText('Shutdown Cancelled')).toBeTruthy()
  })
})
