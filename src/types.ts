export type Role = "prosecution" | "defense";
export type Checkout = "head" | "base";

export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  html_url: string;
  head_sha: string;
  base_sha: string;
  head_ref: string;
  base_ref: string;
}

export interface ExecResult {
  exit_code: number;
  exec_ms: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
}

export interface Exhibit {
  id: string;
  side: Role;
  round: number;
  argument: string;
  language: "python" | "bash";
  checkout: Checkout | "both";
  code: string;
  results: { checkout: Checkout; result: ExecResult }[];
}

export interface TestSummary {
  checkout: Checkout;
  passed: number;
  failed: number;
  errors: number;
  exit_code: number;
  tail: string;
}

export interface ChargeSheet {
  summary: string;
  claims: string[];
  falsifiable_criteria: string[];
  risk_areas: string[];
  caveats: string;
}

export interface Verdict {
  ruling: "BROKEN" | "UPHELD" | "INCONCLUSIVE";
  headline: string;
  confidence: "low" | "medium" | "high";
  recommendation: "merge" | "request_changes" | "needs_human_review";
  decisive_exhibit: string | null;
  reasoning: string;
  blocking_issues: { title: string; exhibit_id: string }[];
  exhibit_assessments: { exhibit_id: string; side: Role; valid: boolean; note: string }[];
}

export type TrialEvent =
  | { t: "trial_start"; id: string; pr: PRInfo; startedAt: number }
  | { t: "status"; message: string }
  | { t: "charge"; sheet: ChargeSheet }
  | { t: "exhibit0"; tests: TestSummary[] }
  | { t: "turn_start"; role: Role; round: number }
  | { t: "speech"; role: Role; text: string }
  | { t: "inspect"; role: Role; command: string; output: string; exit_code: number }
  | { t: "exhibit_code"; role: Role; code: string }
  | {
      t: "exhibit_start";
      role: Role;
      id: string;
      argument: string;
      language: Exhibit["language"];
      checkout: Exhibit["checkout"];
      code: string;
    }
  | { t: "exhibit_output"; role: Role; id: string; checkout: Checkout; stream: "stdout" | "stderr"; data: string }
  | { t: "exhibit_result"; role: Role; id: string; checkout: Checkout; result: ExecResult }
  | { t: "turn_end"; role: Role; round: number; statement: string }
  | { t: "deliberating" }
  | { t: "verdict"; verdict: Verdict }
  | { t: "error"; message: string }
  | { t: "trial_end" };

export type StampedEvent = TrialEvent & { ts: number };
