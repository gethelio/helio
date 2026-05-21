/** Shared label + content pair used in detail panels across ActionCard, ApprovalsPage, and AuditPage. */
export function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="mb-1 text-xs font-medium text-gray-500">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
