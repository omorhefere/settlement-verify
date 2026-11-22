import { describe, expect, it } from "vitest";
import {
  evaluateOutcomeOfSettlementLetterVerification,
  buildScorecardFromVerificationEvaluations,
  buildReadingAccuracyFromVerificationEvaluations,
  checkVerificationOutcomeMatchesExpectedResult,
} from "../src/evals/score.ts";
import { mockModelExtractionFromTruth } from "../src/synthetic/mock-model.ts";
import { letterFactsFromTruth } from "../src/evals/reading-accuracy.ts";
import type { Verdict } from "../src/outcome.ts";
import { TEST_CASES } from "../src/synthetic/test-cases.ts";
import type { TestCase } from "../src/synthetic/types.ts";
import type { CheckResult } from "../src/types.ts";
import type { ModelReading, VerificationOutcome } from "../src/verify.ts";
import { cleanLetterExtraction } from "./fixtures.ts";

// The synthetic test case with this id.
const testCaseById = (id: string): TestCase => TEST_CASES.find((candidate) => candidate.id === id)!;

// A reading where the given checks fail and every other check is absent. The
// extraction is a placeholder: these tests only look at the check results.
const fakeReading = (model: ModelReading["model"], failingChecks: CheckResult["check"][]): ModelReading => {
  const checkResults: CheckResult[] = failingChecks.map((check) => ({ check, status: "fail", reason: "test" }));
  const verdict: Verdict = failingChecks.length ? { kind: "fail", fail: checkResults, neverAllowed: [] } : { kind: "accept" };
  return { model, extraction: cleanLetterExtraction(), checkResults, verdict };
};

const acceptedOutcome = (...readings: ModelReading[]): VerificationOutcome => ({ outcome: "accept", readings });
const rejectedOutcome = (...readings: ModelReading[]): VerificationOutcome => ({ outcome: "retry", messages: [], attemptsLeft: 4, readings });
const tokenUsage = [{ model: "claude-haiku-5-5", inputTokens: 4000, outputTokens: 500 }];

// What the label says for each test case used below.
const expectAccept = testCaseById("formal-clean").expected; // accept
const expectRejectForExpiry = testCaseById("formal-expired").expected; // reject, caught by "expiry"

describe("checkVerificationOutcomeMatchesExpectedResult", () => {
  it("correct: accepted, and should be", () => {
    expect(checkVerificationOutcomeMatchesExpectedResult(acceptedOutcome(fakeReading("cheap", [])), expectAccept)).toBe("correct");
  });

  it("wrongly accepted: accepted a letter that should be rejected", () => {
    expect(checkVerificationOutcomeMatchesExpectedResult(acceptedOutcome(fakeReading("cheap", [])), expectRejectForExpiry)).toBe("wrongly_accepted");
  });

  it("wrongly rejected: rejected a letter that should be accepted", () => {
    expect(checkVerificationOutcomeMatchesExpectedResult(rejectedOutcome(fakeReading("cheap", ["amount"])), expectAccept)).toBe("wrongly_rejected");
  });

  it("correct: rejected, and the expected check caught it", () => {
    expect(checkVerificationOutcomeMatchesExpectedResult(rejectedOutcome(fakeReading("cheap", ["expiry"])), expectRejectForExpiry)).toBe("correct");
  });

  it("wrong reason: rejected, but not by the expected check", () => {
    expect(checkVerificationOutcomeMatchesExpectedResult(rejectedOutcome(fakeReading("cheap", ["amount"])), expectRejectForExpiry)).toBe("wrong_reason");
  });

  it("only the final (strong) reading's reasons count", () => {
    const cheapThenStrong = rejectedOutcome(fakeReading("cheap", ["amount"]), fakeReading("strong", ["expiry"]));
    expect(checkVerificationOutcomeMatchesExpectedResult(cheapThenStrong, expectRejectForExpiry)).toBe("correct");
  });

  it("service errors aren't counted either way", () => {
    const serviceError: VerificationOutcome = { outcome: "service_error", error: "timeout", readings: [] };
    expect(checkVerificationOutcomeMatchesExpectedResult(serviceError, expectAccept)).toBe("service_error");
  });
});

describe("evaluateOutcomeOfSettlementLetterVerification", () => {
  it("records the grade, whether it escalated, and each reading", () => {
    const cheapThenStrong = rejectedOutcome(fakeReading("cheap", ["amount"]), fakeReading("strong", ["expiry"]));
    expect(evaluateOutcomeOfSettlementLetterVerification(testCaseById("formal-expired"), cheapThenStrong, tokenUsage, 1)).toMatchObject({
      grade: "correct",
      escalated: true,
      readings: [
        { model: "cheap", verdict: "fail", notPassing: ["amount"] },
        { model: "strong", verdict: "fail", notPassing: ["expiry"] },
      ],
    });
  });

  it("keeps the error message of a service error", () => {
    const serviceError: VerificationOutcome = { outcome: "service_error", error: "timeout", readings: [] };
    expect(evaluateOutcomeOfSettlementLetterVerification(testCaseById("formal-clean"), serviceError, [], 1)).toMatchObject({ error: "timeout" });
  });

  it("adds up the cost of every call", () => {
    // 4000 × $0.10/M + 500 × $0.50/M = $0.00065
    expect(evaluateOutcomeOfSettlementLetterVerification(testCaseById("formal-clean"), acceptedOutcome(fakeReading("cheap", [])), tokenUsage, 1).costUsd).toBeCloseTo(0.00065, 8);
  });
});

describe("buildScorecardFromVerificationEvaluations", () => {
  it("counts each kind of result", () => {
    const verificationEvaluations = [
      evaluateOutcomeOfSettlementLetterVerification(testCaseById("formal-clean"), acceptedOutcome(fakeReading("cheap", [])), tokenUsage, 2),
      evaluateOutcomeOfSettlementLetterVerification(testCaseById("formal-expired"), acceptedOutcome(fakeReading("cheap", [])), tokenUsage, 2),
      evaluateOutcomeOfSettlementLetterVerification(testCaseById("car-clean"), rejectedOutcome(fakeReading("cheap", ["amount"]), fakeReading("strong", ["amount"])), tokenUsage, 4),
    ];
    expect(buildScorecardFromVerificationEvaluations(verificationEvaluations)).toMatchObject({
      testCases: 3,
      wronglyAccepted: 1,
      shouldReject: 1,
      wronglyRejected: 1,
      shouldAccept: 2,
      escalated: 1,
      averageSeconds: (2 + 2 + 4) / 3,
    });
  });
});

describe("buildReadingAccuracyFromVerificationEvaluations", () => {
  it("counts right readings per model and field", () => {
    const formalTestCase = testCaseById("formal-clean");
    const perfectReading = mockModelExtractionFromTruth(formalTestCase.truth);
    const misreadFigure = {
      ...perfectReading,
      amounts: perfectReading.amounts.map((amount) => (amount.category === "settlement_figure" ? { ...amount, pence: 49780 } : amount)),
    };
    // Cheap model misread the figure; strong model read it right.
    const cheapReading = { ...fakeReading("cheap", ["amount"]), extraction: misreadFigure };
    const strongReading = { ...fakeReading("strong", []), extraction: perfectReading };
    const formalWithFacts = { ...formalTestCase, letterFacts: letterFactsFromTruth(formalTestCase.truth) };
    const evaluation = evaluateOutcomeOfSettlementLetterVerification(formalWithFacts, acceptedOutcome(cheapReading, strongReading), tokenUsage, 1);

    const readingAccuracy = buildReadingAccuracyFromVerificationEvaluations([evaluation]);
    expect(readingAccuracy).toContainEqual({ model: "cheap", field: "settlement_figure", right: 0, total: 1 });
    expect(readingAccuracy).toContainEqual({ model: "strong", field: "settlement_figure", right: 1, total: 1 });
    expect(readingAccuracy).toContainEqual({ model: "cheap", field: "creditor", right: 1, total: 1 });
  });
});
