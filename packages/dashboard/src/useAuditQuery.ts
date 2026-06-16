import { useCallback, useEffect, useState } from 'react'
import type { AuditListResponse } from './types'
import { fetchAudit } from './api'
import { outcomeFilterToAuditParams, type OutcomeFilterValue } from './outcome'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditFilters {
  tool: string
  decision: OutcomeFilterValue | null
  reason: string | null
  session: string
  from: string
  to: string
  upstream_status_min: string
  upstream_status_max: string
  origin: string
  record_kind: string
  channel: string
  sender: string
}

export interface UseAuditQueryReturn {
  data: AuditListResponse | null
  loading: boolean
  error: string | null
  filters: AuditFilters
  page: number
  limit: number
  setFilter: <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => void
  setBulkFilters: (patch: Partial<AuditFilters>) => void
  setPage: (page: number) => void
  setLimit: (limit: number) => void
  refetch: () => void
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const INITIAL_FILTERS: AuditFilters = {
  tool: '',
  decision: null,
  reason: null,
  session: '',
  from: '',
  to: '',
  upstream_status_min: '',
  upstream_status_max: '',
  origin: '',
  record_kind: '',
  channel: '',
  sender: '',
}

function parseOptionalInt(value: string): number | undefined {
  if (value.length === 0) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function useAuditQuery(): UseAuditQueryReturn {
  const [filters, setFilters] = useState<AuditFilters>(INITIAL_FILTERS)
  const [page, setPageRaw] = useState(1)
  const [limit, setLimitRaw] = useState(25)
  const [refreshToken, setRefreshToken] = useState(0)

  const [debouncedTool, setDebouncedTool] = useState('')
  const [debouncedSession, setDebouncedSession] = useState('')
  const [debouncedOrigin, setDebouncedOrigin] = useState('')
  const [debouncedChannel, setDebouncedChannel] = useState('')
  const [debouncedSender, setDebouncedSender] = useState('')

  const [data, setData] = useState<AuditListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // -- Debounce text inputs (300ms) -----------------------------------------
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedTool(filters.tool)
    }, 300)
    return () => {
      clearTimeout(id)
    }
  }, [filters.tool])

  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedSession(filters.session)
    }, 300)
    return () => {
      clearTimeout(id)
    }
  }, [filters.session])

  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedOrigin(filters.origin)
    }, 300)
    return () => {
      clearTimeout(id)
    }
  }, [filters.origin])

  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedChannel(filters.channel)
    }, 300)
    return () => {
      clearTimeout(id)
    }
  }, [filters.channel])

  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedSender(filters.sender)
    }, 300)
    return () => {
      clearTimeout(id)
    }
  }, [filters.sender])

  // -- Fetch on filter/page change ------------------------------------------
  useEffect(() => {
    let canceled = false
    setLoading(true)
    const outcomeParams = outcomeFilterToAuditParams(filters.decision)

    fetchAudit({
      tool: debouncedTool || undefined,
      decision: outcomeParams.decision,
      reason: filters.reason ?? outcomeParams.reason,
      blocked: outcomeParams.blocked,
      session: debouncedSession || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
      dry_run: outcomeParams.dry_run,
      upstream_status_min: parseOptionalInt(filters.upstream_status_min),
      upstream_status_max: parseOptionalInt(filters.upstream_status_max),
      origin: debouncedOrigin || undefined,
      record_kind: filters.record_kind || undefined,
      channel: debouncedChannel || undefined,
      sender: debouncedSender || undefined,
      offset: (page - 1) * limit,
      limit,
    })
      .then((res) => {
        if (canceled) return
        setData(res)
        setError(null)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (canceled) return
        setError(err instanceof Error ? err.message : 'Failed to load audit records')
        setLoading(false)
      })

    return () => {
      canceled = true
    }
  }, [
    debouncedTool,
    filters.decision,
    filters.reason,
    debouncedSession,
    filters.from,
    filters.to,
    filters.upstream_status_min,
    filters.upstream_status_max,
    debouncedOrigin,
    filters.record_kind,
    debouncedChannel,
    debouncedSender,
    page,
    limit,
    refreshToken,
  ])

  // -- Setters that reset page to 1 -----------------------------------------
  const setFilter = useCallback(<K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
    setPageRaw(1)
  }, [])

  const setBulkFilters = useCallback((patch: Partial<AuditFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }))
    setPageRaw(1)
  }, [])

  const setPage = useCallback((p: number) => {
    setPageRaw(p)
  }, [])

  const setLimit = useCallback((l: number) => {
    setLimitRaw(l)
    setPageRaw(1)
  }, [])

  const refetch = useCallback(() => {
    setRefreshToken((t) => t + 1)
  }, [])

  return {
    data,
    loading,
    error,
    filters,
    page,
    limit,
    setFilter,
    setBulkFilters,
    setPage,
    setLimit,
    refetch,
  }
}
