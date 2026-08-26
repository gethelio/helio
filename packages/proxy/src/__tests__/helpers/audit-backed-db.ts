import type { Database as DatabaseType } from 'better-sqlite3'
import { AuditStore } from '../../audit/store.js'

/**
 * An in-memory database carrying the audit schema, for tests that construct
 * a BudgetLedger directly. The ledger's listing SQL LEFT JOINs
 * audit_records (issue #292), and production always satisfies that: the
 * ledger co-locates in the audit store's database. A bare handle without
 * the audit table would fail the ledger constructor's statement prepare.
 */
export function auditBackedDb(): DatabaseType {
  return new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  }).database
}
