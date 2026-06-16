// ---------------------------------------------------------------------------
// Origin + record-kind display helpers (#16).
// origin is a constrained adapter slug (^[a-z0-9_-]{1,64}$); map known values
// to friendly labels and fall back to the raw slug for forward compatibility.
// ---------------------------------------------------------------------------

const ORIGIN_LABELS: Record<string, string> = {
  mcp: 'MCP',
  openclaw: 'OpenClaw',
}

export function formatOrigin(origin: string): string {
  return ORIGIN_LABELS[origin] ?? origin
}

// record_kind is orthogonal to the decision badge. tool_call is the default
// and renders no chip; the other kinds get a short label.
const RECORD_KIND_LABELS: Record<string, string> = {
  install_scan: 'Install Scan',
  drift_event: 'Drift',
  evaluation_expired: 'Expired',
}

export function formatRecordKind(kind: string): string | null {
  if (kind === 'tool_call') return null
  return RECORD_KIND_LABELS[kind] ?? kind
}
