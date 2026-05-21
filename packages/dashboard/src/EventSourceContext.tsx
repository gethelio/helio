import { createContext, useContext } from 'react'
import { useEventSource } from './useEventSource'
import type { UseEventSourceReturn } from './useEventSource'

const EventSourceContext = createContext<UseEventSourceReturn | null>(null)

export function EventSourceProvider({
  children,
  onSessionExpired,
}: {
  children: React.ReactNode
  onSessionExpired?: () => void
}) {
  const es = useEventSource('/api/events', onSessionExpired)
  return <EventSourceContext.Provider value={es}>{children}</EventSourceContext.Provider>
}

export function useEventSourceContext(): UseEventSourceReturn {
  const ctx = useContext(EventSourceContext)
  if (!ctx) throw new Error('useEventSourceContext must be used within EventSourceProvider')
  return ctx
}
