import { useCallback, useEffect, useState } from 'react'
import type { ApprovalStatus } from '../types'
import { approveTicket, denyTicket, breakGlassTicket } from '../api'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApprovalActionsProps {
  ticketId: string
  status: ApprovalStatus
  onResolved: () => void
}

type Mode = 'idle' | 'deny' | 'break_glass'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ApprovalActions({ ticketId, status, onResolved }: ApprovalActionsProps) {
  const [mode, setMode] = useState<Mode>('idle')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [denyReason, setDenyReason] = useState('')
  const [breakGlassReason, setBreakGlassReason] = useState('')
  const [reasonRequired, setReasonRequired] = useState(false)

  // Close break-glass modal on Escape
  useEffect(() => {
    if (mode !== 'break_glass') return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMode('idle')
        setBreakGlassReason('')
        setReasonRequired(false)
      }
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
    }
  }, [mode])

  const handleError = useCallback((err: unknown) => {
    if (err instanceof Error && 'status' in err) {
      const status = (err as { status: number }).status
      if (status === 409) {
        setError('This ticket has already been resolved')
      } else if (status === 404) {
        setError('Ticket not found')
      } else {
        setError(err.message || 'Action failed')
      }
    } else {
      setError('Action failed')
    }
  }, [])

  const handleApprove = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      await approveTicket(ticketId, 'dashboard')
      onResolved()
    } catch (err: unknown) {
      handleError(err)
    } finally {
      setLoading(false)
    }
  }, [ticketId, onResolved, handleError])

  const handleConfirmDeny = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      await denyTicket(ticketId, 'dashboard', denyReason || undefined)
      onResolved()
    } catch (err: unknown) {
      handleError(err)
    } finally {
      setLoading(false)
    }
  }, [ticketId, denyReason, onResolved, handleError])

  const handleConfirmBreakGlass = useCallback(async () => {
    if (!breakGlassReason.trim()) {
      setReasonRequired(true)
      return
    }
    setError(null)
    setLoading(true)
    try {
      await breakGlassTicket(ticketId, 'dashboard', breakGlassReason.trim())
      onResolved()
    } catch (err: unknown) {
      handleError(err)
    } finally {
      setLoading(false)
    }
  }, [ticketId, breakGlassReason, onResolved, handleError])

  const cancelMode = useCallback(() => {
    setMode('idle')
    setDenyReason('')
    setBreakGlassReason('')
    setReasonRequired(false)
    setError(null)
  }, [])

  if (status !== 'pending') return null

  return (
    <div className="space-y-2">
      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            void handleApprove()
          }}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {loading && mode === 'idle' ? <Spinner /> : <CheckIcon />}
          Approve
        </button>

        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setError(null)
            setMode('deny')
          }}
          className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          <XIcon />
          Deny
        </button>

        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setError(null)
            setMode('break_glass')
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
        >
          <WarningIcon />
          Break Glass
        </button>
      </div>

      {/* Error message */}
      {error && <p className="text-xs text-red-600">{error}</p>}

      {/* Deny inline form */}
      {mode === 'deny' && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Reason (optional)"
            value={denyReason}
            onChange={(e) => {
              setDenyReason(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleConfirmDeny()
              if (e.key === 'Escape') cancelMode()
            }}
            className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none"
            autoFocus
          />
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              void handleConfirmDeny()
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {loading && <Spinner />}
            Confirm Deny
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={cancelMode}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Break-glass modal */}
      {mode === 'break_glass' && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/10"
            role="button"
            tabIndex={-1}
            aria-label="Close modal"
            onClick={cancelMode}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') cancelMode()
            }}
          />

          {/* Modal */}
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="mx-4 w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-lg">
              <div className="mb-4 flex items-center gap-2">
                <WarningIcon />
                <h3 className="text-base font-semibold text-gray-900">Break-Glass Override</h3>
              </div>

              <p className="mb-4 text-sm text-gray-600">
                This will immediately approve the request and flag it in the audit trail. This
                action cannot be undone.
              </p>

              <textarea
                placeholder="Reason (required)"
                value={breakGlassReason}
                onChange={(e) => {
                  setBreakGlassReason(e.target.value)
                  if (reasonRequired && e.target.value.trim()) setReasonRequired(false)
                }}
                className={`mb-4 w-full rounded-md border bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none ${
                  reasonRequired
                    ? 'border-red-300 ring-1 ring-red-300 focus:border-red-400'
                    : 'border-gray-200 focus:border-gray-300'
                }`}
                rows={3}
                autoFocus
              />
              {reasonRequired && (
                <p className="-mt-3 mb-4 text-xs text-red-600">A reason is required.</p>
              )}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={loading}
                  onClick={cancelMode}
                  className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    void handleConfirmBreakGlass()
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {loading && <Spinner />}
                  Override &amp; Approve
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function CheckIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
    </svg>
  )
}

function WarningIcon() {
  return (
    <svg
      className="h-4 w-4 text-amber-600"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
      />
    </svg>
  )
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  )
}
