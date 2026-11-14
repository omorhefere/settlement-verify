import type { CheckName, CheckResult } from "./types.ts";

// Single-pass verdict over one set of check results (one model's reading).
// Deciding what happens next (strong model, back to the customer, human) needs
// both models' verdicts, so it belongs to the verification flow, not here.

// Never allowed (SPEC.md): no automatic accept unless these explicitly pass.
// The name check joins this list once it exists.
export const NEVER_ALLOWED_CHECKS: readonly CheckName[] = ["settlement_letter", "known_creditor", "expiry"];

// Checks that must be present and pass for an automatic accept. Optional
// checks (loan start date) can block an accept by failing, but their absence
// doesn't.
export const CHECKS_REQUIRED_FOR_ACCEPT: readonly CheckName[] = [
  ...NEVER_ALLOWED_CHECKS,
  "amount",
  "account",
];

// What code concluded from one model's reading: accept, unsure (with the
// unsure and failed checks), or fail (with the failed checks and which of
// them are never-allowed).
export type Verdict =
  | { kind: "accept" }
  | { kind: "unsure"; unsure: CheckResult[]; fail: CheckResult[] }
  | { kind: "fail"; fail: CheckResult[]; neverAllowed: CheckName[] };

// Turns one reading's check results into a verdict. Unsure wins over fail.
// Throws if a required check is missing.
export const judgeCheckResults = (checkResults: CheckResult[]): Verdict => {
  // A missing required check is a bug. Throwing means no automatic accept.
  const missingChecks = CHECKS_REQUIRED_FOR_ACCEPT.filter(
    (requiredCheck) => !checkResults.some((checkResult) => checkResult.check === requiredCheck),
  );
  if (missingChecks.length > 0) throw new Error(`Missing required checks: ${missingChecks.join(", ")}`);

  const unsureResults = checkResults.filter((checkResult) => checkResult.status === "unsure");
  const failedResults = checkResults.filter((checkResult) => checkResult.status === "fail");
  if (unsureResults.length > 0) return { kind: "unsure", unsure: unsureResults, fail: failedResults };
  if (failedResults.length > 0) {
    return {
      kind: "fail",
      fail: failedResults,
      neverAllowed: failedResults
        .map((failedResult) => failedResult.check)
        .filter((checkName) => NEVER_ALLOWED_CHECKS.includes(checkName)),
    };
  }
  return { kind: "accept" };
};
