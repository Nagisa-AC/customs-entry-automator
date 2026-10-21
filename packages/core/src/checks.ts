/** Shared shape for every finding the pipeline reports, from any stage. */
export type Severity = "blocking" | "warning";
export type Outcome = "pass" | "fail" | "skipped";

export interface CheckResult {
  ruleId: string;
  ruleVersion: string;
  severity: Severity;
  outcome: Outcome;
  /** 1-based row in the stitched line list; null for document-level checks. */
  row: number | null;
  page: number | null;
  field: string | null;
  expected: string | null;
  actual: string | null;
  /** Plain remediation-oriented explanation. Never includes data beyond this document. */
  message: string;
}

export function isBlockingFailure(check: CheckResult): boolean {
  return check.outcome === "fail" && check.severity === "blocking";
}
