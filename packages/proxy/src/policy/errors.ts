/**
 * Error thrown when policy compilation fails due to an invalid rule.
 *
 * Includes the rule index and optional name for clear error reporting.
 */
export class PolicyParseError extends Error {
  readonly ruleIndex: number
  readonly ruleName?: string

  constructor(message: string, ruleIndex: number, ruleName?: string) {
    const prefix = ruleName
      ? `Policy rule ${String(ruleIndex)} ("${ruleName}")`
      : `Policy rule ${String(ruleIndex)}`
    super(`${prefix}: ${message}`)
    this.name = 'PolicyParseError'
    this.ruleIndex = ruleIndex
    this.ruleName = ruleName
  }
}
