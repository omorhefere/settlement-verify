import type { TokenUsage } from "../extractors/anthropic.ts";
import { costUsdOfTokenUsage } from "../pricing.ts";
import type { CheckName } from "../types.ts";
import type { LetterTruth } from "../synthetic/types.ts";
import type { ModelReading, VerificationOutcome } from "../verify.ts";
import { compareModelReadingWithLetterTruth, type FieldReadingCheck, type ReadingField } from "./reading-accuracy.ts";

// Grading: comparing what the system did with what it should have done
// (SPEC.md > Metrics). Pure functions: the runner makes the model calls and
// hands the outcomes here; nothing in this file calls a model.

// How one test case went: correct, or which kind of error.
export type Grade =
  | "correct"
  | "wrongly_accepted" // accepted, but should have been rejected: the worst error, target 0
  | "wrongly_rejected" // rejected, but should have been accepted
  | "wrong_reason" // rejected as expected, but not by the check we expected to catch it
  | "service_error"; // the model call failed, so the test case can't be graded either way

// Everything worth keeping about one test case's run: its grade, how the system
// got there, and what it cost. Saved to the results file.
export type SettlementLetterVerificationEvaluation = {
  id: string;
  description: string;
  grade: Grade;
  expectedAccept: boolean;
  outcome: VerificationOutcome["outcome"];
  escalated: boolean; // did the strong model have to read it too?
  // One entry per model that read the letter: which one, what code concluded
  // from its reading, which checks didn't pass, and (synthetic letters only)
  // how accurately it read each field.
  readings: {
    model: "cheap" | "strong";
    verdict: string;
    notPassing: CheckName[];
    fieldReadingChecks?: FieldReadingCheck[];
  }[];
  usage: TokenUsage[];
  costUsd: number;
  seconds: number;
  error?: string;
};

// What a test case's label says should happen. Synthetic test cases and
// hand-labelled real letters both have this.
export type ExpectedResult = {
  accept: boolean; // should the letter be accepted?
  notPassing: CheckName[]; // if not, the checks that must catch it
};

// Lists the checks that didn't pass when code checked one model's reading:
// those that came back fail or unsure, e.g. ["amount", "expiry"].
const listChecksThatDidNotPass = (reading: ModelReading): CheckName[] =>
  reading.checkResults.filter((checkResult) => checkResult.status !== "pass").map((checkResult) => checkResult.check);

// Checks whether what the verifier did matches the expected result, and says
// how: correct, or which kind of mistake. Only the last model reading's
// reasons count, because that's what the customer would be told.
export const checkVerificationOutcomeMatchesExpectedResult = (
  verificationOutcome: VerificationOutcome,
  expectedResult: ExpectedResult,
): Grade => {
  if (verificationOutcome.outcome === "service_error") return "service_error";

  const wasAccepted = verificationOutcome.outcome === "accept";
  if (wasAccepted && !expectedResult.accept) return "wrongly_accepted";
  if (!wasAccepted && expectedResult.accept) return "wrongly_rejected";
  if (wasAccepted) return "correct";

  // Rejected, as expected. Was it rejected for the expected reason? The
  // reasons are the checks that didn't pass on the last model reading (the
  // strong model's if it read the letter, otherwise the cheap model's).
  const finalReading = verificationOutcome.readings[verificationOutcome.readings.length - 1];
  const checksThatRejectedTheLetter = finalReading ? listChecksThatDidNotPass(finalReading) : [];
  const wasCaughtByExpectedChecks = expectedResult.notPassing.every((expectedCheck) =>
    checksThatRejectedTheLetter.includes(expectedCheck),
  );
  return wasCaughtByExpectedChecks ? "correct" : "wrong_reason";
};

// Evaluates one run of the settlement letter verifier (evals only): checks
// the verifier's final decision against the test case's expected result, and
// records each model reading, the tokens used, the cost and the time taken.
export const evaluateOutcomeOfSettlementLetterVerification = (
  labelledTestCase: { id: string; description: string; expected: ExpectedResult; truth?: LetterTruth },
  verificationOutcome: VerificationOutcome,
  tokensUsedForLetterExtraction: TokenUsage[],
  secondsTaken: number,
): SettlementLetterVerificationEvaluation => ({
  id: labelledTestCase.id,
  description: labelledTestCase.description,
  grade: checkVerificationOutcomeMatchesExpectedResult(verificationOutcome, labelledTestCase.expected),
  expectedAccept: labelledTestCase.expected.accept,
  outcome: verificationOutcome.outcome,
  escalated: verificationOutcome.readings.length > 1,
  readings: verificationOutcome.readings.map((reading) => ({
    model: reading.model,
    verdict: reading.verdict.kind,
    notPassing: listChecksThatDidNotPass(reading),
    // Testing the model alone: only possible when we know what's printed.
    ...(labelledTestCase.truth
      ? { fieldReadingChecks: compareModelReadingWithLetterTruth(reading.extraction, labelledTestCase.truth) }
      : {}),
  })),
  usage: tokensUsedForLetterExtraction,
  costUsd: tokensUsedForLetterExtraction.reduce((totalCostUsd, modelCall) => totalCostUsd + (costUsdOfTokenUsage(modelCall) ?? 0), 0),
  seconds: secondsTaken,
  ...(verificationOutcome.outcome === "service_error" ? { error: verificationOutcome.error } : {}),
});

// The scorecard for a whole run: counts of each kind of error, each next to
// the number of chances it had, plus escalations, cost and time.
export type Scorecard = {
  testCases: number;
  wronglyAccepted: number;
  shouldReject: number; // how many test cases should have been rejected (the chances to be wrongly accepted)
  wronglyRejected: number;
  shouldAccept: number; // how many should have been accepted (the chances to be wrongly rejected)
  wrongReason: number;
  escalated: number;
  serviceErrors: number;
  totalCostUsd: number;
  costPerTestCaseUsd: number;
  averageSeconds: number;
};

// Adds up every test case's grade into one scorecard: how many of each kind of
// error, each next to the number of chances it had to happen, plus how many
// test cases needed the strong model, the total and per-test case cost, and the
// average time. Service errors are left out of the error counts, since a
// failed call says nothing about how well the model reads.
export const buildScorecardFromVerificationEvaluations = (verificationEvaluations: SettlementLetterVerificationEvaluation[]): Scorecard => {
  const countEvaluationsWithGrade = (grade: Grade) => verificationEvaluations.filter((evaluation) => evaluation.grade === grade).length;
  const gradedEvaluations = verificationEvaluations.filter((evaluation) => evaluation.grade !== "service_error");
  const totalCostUsd = verificationEvaluations.reduce((total, evaluation) => total + evaluation.costUsd, 0);
  const totalSeconds = verificationEvaluations.reduce((total, evaluation) => total + evaluation.seconds, 0);

  return {
    testCases: verificationEvaluations.length,
    wronglyAccepted: countEvaluationsWithGrade("wrongly_accepted"),
    shouldReject: gradedEvaluations.filter((evaluation) => !evaluation.expectedAccept).length,
    wronglyRejected: countEvaluationsWithGrade("wrongly_rejected"),
    shouldAccept: gradedEvaluations.filter((evaluation) => evaluation.expectedAccept).length,
    wrongReason: countEvaluationsWithGrade("wrong_reason"),
    escalated: verificationEvaluations.filter((evaluation) => evaluation.escalated).length,
    serviceErrors: countEvaluationsWithGrade("service_error"),
    totalCostUsd,
    costPerTestCaseUsd: verificationEvaluations.length > 0 ? totalCostUsd / verificationEvaluations.length : 0,
    averageSeconds: verificationEvaluations.length > 0 ? totalSeconds / verificationEvaluations.length : 0,
  };
};

// Reading accuracy for one model and one field: how many of its readings got
// that field right (testing the model alone, SPEC.md > Metrics level 1).
export type FieldReadingAccuracy = {
  model: "cheap" | "strong";
  field: ReadingField;
  right: number;
  total: number;
};

// The order fields are shown in.
const READING_FIELDS: ReadingField[] = ["settlement_letter", "settlement_figure", "letter_date", "expiry", "account_number", "creditor"];

// Adds up every reading's field checks into one table: for each model (cheap,
// strong) and each field, how many readings got it right out of how many.
// Each model reading counts, so a test case the strong model also read adds a
// strong-model row. Test cases without a known truth (real letters with no
// field labels) aren't counted.
export const buildReadingAccuracyFromVerificationEvaluations = (
  verificationEvaluations: SettlementLetterVerificationEvaluation[],
): FieldReadingAccuracy[] => {
  const allReadings = verificationEvaluations.flatMap((evaluation) => evaluation.readings);
  const readingAccuracy: FieldReadingAccuracy[] = [];
  for (const model of ["cheap", "strong"] as const) {
    for (const field of READING_FIELDS) {
      const fieldChecks = allReadings
        .filter((reading) => reading.model === model)
        .flatMap((reading) => reading.fieldReadingChecks ?? [])
        .filter((fieldCheck) => fieldCheck.field === field);
      if (fieldChecks.length === 0) continue;
      readingAccuracy.push({
        model,
        field,
        right: fieldChecks.filter((fieldCheck) => fieldCheck.isRight).length,
        total: fieldChecks.length,
      });
    }
  }
  return readingAccuracy;
};
