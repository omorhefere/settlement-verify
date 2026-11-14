import { describe, expect, it } from "vitest";
import { runAllChecksOnExtraction } from "../src/checks.ts";
import { judgeCheckResults } from "../src/outcome.ts";
import type { CheckResult } from "../src/types.ts";
import { cleanApplication, cleanLetterExtraction, checkConfig, cleanLoan } from "./fixtures.ts";

// The check results for the clean letter: every check passes.
const cleanCheckResults = (): CheckResult[] => runAllChecksOnExtraction(cleanLetterExtraction(), cleanApplication(), cleanLoan(), checkConfig());

// The same check results with one check's status changed.
const withCheckStatusChanged = (checkResults: CheckResult[], check: CheckResult["check"], status: CheckResult["status"]) =>
  checkResults.map((checkResult) => (checkResult.check === check ? { ...checkResult, status } : checkResult));

describe("judgeCheckResults", () => {
  it("accepts when every check passes", () => {
    expect(judgeCheckResults(cleanCheckResults())).toEqual({ kind: "accept" });
  });

  it("unsure wins over fail, and both are reported", () => {
    const checkResults = withCheckStatusChanged(withCheckStatusChanged(cleanCheckResults(), "amount", "fail"), "expiry", "unsure");
    const verdict = judgeCheckResults(checkResults);
    expect(verdict.kind).toBe("unsure");
    if (verdict.kind !== "unsure") return;
    expect(verdict.unsure.map((checkResult) => checkResult.check)).toEqual(["expiry"]);
    expect(verdict.fail.map((checkResult) => checkResult.check)).toEqual(["amount"]);
  });

  it("marks never-allowed failures", () => {
    const checkResults = withCheckStatusChanged(withCheckStatusChanged(cleanCheckResults(), "expiry", "fail"), "amount", "fail");
    expect(judgeCheckResults(checkResults)).toMatchObject({ kind: "fail", neverAllowed: ["expiry"] });
  });

  it("an optional check that fails blocks an accept", () => {
    expect(judgeCheckResults(withCheckStatusChanged(cleanCheckResults(), "loan_start_date", "fail")).kind).toBe("fail");
  });

  it("an optional check that didn't run doesn't block an accept", () => {
    expect(judgeCheckResults(cleanCheckResults().filter((checkResult) => checkResult.check !== "loan_start_date"))).toEqual({ kind: "accept" });
  });

  it("throws when a required check is missing, so it can never auto-accept", () => {
    expect(() => judgeCheckResults(cleanCheckResults().filter((checkResult) => checkResult.check !== "expiry"))).toThrow(/expiry/);
  });
});
