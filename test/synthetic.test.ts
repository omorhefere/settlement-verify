import { describe, expect, it } from "vitest";
import { ENGLAND_AND_WALES_BANK_HOLIDAYS } from "../src/bank-holidays.ts";
import { runAllChecksOnExtraction } from "../src/checks.ts";
import { judgeCheckResults } from "../src/outcome.ts";
import { mockModelExtractionFromTruth } from "../src/synthetic/mock-model.ts";
import { renderLetterTruthAsPdf } from "../src/synthetic/render.ts";
import { TEST_CASES, SYNTHETIC_KNOWN_CREDITORS } from "../src/synthetic/test-cases.ts";

describe("synthetic test cases", () => {
  it("have unique ids", () => {
    expect(new Set(TEST_CASES.map((testCase) => testCase.id)).size).toBe(TEST_CASES.length);
  });

  it("breakdowns add up to the settlement figure", () => {
    for (const testCase of TEST_CASES) {
      const breakdown = testCase.truth.breakdown;
      if (breakdown) expect(breakdown.balancePence + breakdown.interestPence - breakdown.rebatePence, testCase.id).toBe(testCase.truth.settlementPence);
    }
  });

  // The mock model: if the checks disagree with a hand-written label here,
  // either the label or the checks are wrong, and no model is involved yet.
  it.each(TEST_CASES.map((testCase) => [testCase.id, testCase] as const))("%s: the mock model gets the expected outcome", (_, testCase) => {
    const checkResults = runAllChecksOnExtraction(mockModelExtractionFromTruth(testCase.truth), testCase.application, testCase.loan, {
      knownCreditors: SYNTHETIC_KNOWN_CREDITORS,
      today: testCase.today,
      bankHolidays: ENGLAND_AND_WALES_BANK_HOLIDAYS,
    });
    const verdict = judgeCheckResults(checkResults);
    expect(verdict.kind === "accept", JSON.stringify(checkResults, null, 2)).toBe(testCase.expected.accept);
    const notPassing = checkResults.filter((checkResult) => checkResult.status !== "pass").map((checkResult) => checkResult.check);
    for (const check of testCase.expected.notPassing) expect(notPassing, testCase.id).toContain(check);
  });

  it("render as PDFs", async () => {
    const letterFile = await renderLetterTruthAsPdf(TEST_CASES[0]!.truth, "test");
    expect(letterFile.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
