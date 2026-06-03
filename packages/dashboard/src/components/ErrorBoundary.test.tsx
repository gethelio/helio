import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

// Suppress React error boundary console output during tests
let consoleErrorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  consoleErrorSpy = vi.spyOn(globalThis.console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ThrowingComponent({ message }: { message: string }): never {
  throw new Error(message)
}

function SafeComponent() {
  return <p>All good</p>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ErrorBoundary', () => {
  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <SafeComponent />
      </ErrorBoundary>,
    )
    expect(screen.getByText('All good')).toBeTruthy()
  })

  it('renders fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="boom" />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Something went wrong')).toBeTruthy()
  })

  it('displays the error message', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="Test render failure" />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Test render failure')).toBeTruthy()
  })

  it('renders a Reload button', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="crash" />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Reload')).toBeTruthy()
  })

  it('calls window.location.reload when Reload is clicked', () => {
    const reloadMock = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { reload: reloadMock },
      writable: true,
    })

    render(
      <ErrorBoundary>
        <ThrowingComponent message="crash" />
      </ErrorBoundary>,
    )

    fireEvent.click(screen.getByText('Reload'))
    expect(reloadMock).toHaveBeenCalled()
  })

  it('logs the error via console.error in componentDidCatch', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="logged crash" />
      </ErrorBoundary>,
    )
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[helio] Uncaught component error:',
      expect.objectContaining({ message: 'logged crash' }),
      expect.any(String),
    )
  })
})
