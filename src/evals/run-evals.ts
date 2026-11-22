// pnpm eval [setup] [--unsure-only] [--dataset <folder>]
//
// Runs every test case in a dataset through the real verifier with real
// models and reports two levels of testing (SPEC.md > Metrics):
//   the model alone: what each model read vs what's printed on the letter, per field
//   the system: the verifier's decision vs each test case's expected result
// (The code alone is tested by `pnpm test`, with a mock model.) Saves the full
// results to evals/results/ (gitignored).
//
// Datasets:
//   letters/synthetic (default)   the dev set; run `pnpm generate` first
//   --dataset letters/private/test  real letters labelled by hand (the test set; run rarely)
//
// Setups:
//   haiku | sonnet | opus      one model, no second reading
//   haiku:sonnet | haiku:opus  cheap model first, strong model on anything else (the spec's flow)
//   mock                       the mock model: no API calls, free; checks the runner itself
// --unsure-only               with a cheap:strong setup, escalate only unsure readings

import Anthropic from "@anthropic-ai/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ENGLAND_AND_WALES_BANK_HOLIDAYS } from "../bank-holidays.ts";
import { makeAnthropicExtractor, type TokenUsage } from "../extractors/anthropic.ts";
import type { LetterExtractor } from "../extractors/types.ts";
import { mockModelExtractionFromTruth } from "../synthetic/mock-model.ts";
import { SYNTHETIC_KNOWN_CREDITORS } from "../synthetic/test-cases.ts";
import { createSettlementLetterVerifier } from "../verify.ts";
import { loadKnownCreditorsFromFolder, loadLabelledTestCasesFromFolder, type LabelledTestCase } from "./dataset.ts";
import {
  buildReadingAccuracyFromVerificationEvaluations,
  buildScorecardFromVerificationEvaluations,
  evaluateOutcomeOfSettlementLetterVerification,
  type SettlementLetterVerificationEvaluation,
} from "./score.ts";

const DEFAULT_DATASET_FOLDER = "letters/synthetic";
const RESULTS_FOLDER = "evals/results";
const TEST_CASES_IN_FLIGHT = 4; // how many test cases run at once; keeps well under API rate limits

// Short model names accepted on the command line, and the pinned model ID each means.
const MODEL_IDS: Record<string, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

// ---------- Read the command line ----------

const commandLineArguments = process.argv.slice(2);
// --dataset <folder>: the folder name is the argument after the flag.
const datasetFlagPosition = commandLineArguments.indexOf("--dataset");
const datasetFolder = datasetFlagPosition >= 0 ? commandLineArguments[datasetFlagPosition + 1] : DEFAULT_DATASET_FOLDER;
if (!datasetFolder) {
  console.error("--dataset needs a folder, e.g. --dataset letters/private/test");
  process.exit(1);
}
// The setup is the first argument that isn't a flag or the --dataset folder.
const isDatasetFolderArgument = (position: number) => datasetFlagPosition >= 0 && position === datasetFlagPosition + 1;
const setupName =
  commandLineArguments.find((argument, position) => !argument.startsWith("--") && !isDatasetFolderArgument(position)) ?? "haiku:sonnet";
const shouldEscalateUnsureOnly = commandLineArguments.includes("--unsure-only");
// "haiku:sonnet" → cheap "haiku", strong "sonnet". "haiku" → no strong model.
const [cheapModelName, strongModelName] = setupName.split(":") as [string, string | undefined];
const isMock = cheapModelName === "mock";
const datasetLabel = datasetFolder === DEFAULT_DATASET_FOLDER ? "" : ` on ${basename(datasetFolder)}`;
const runLabel = `${setupName}${shouldEscalateUnsureOnly ? " --unsure-only" : ""}${datasetLabel}`;

for (const modelName of [cheapModelName, strongModelName]) {
  if (modelName !== undefined && modelName !== "mock" && !MODEL_IDS[modelName]) {
    console.error(`Unknown model "${modelName}". Use ${Object.keys(MODEL_IDS).join(", ")} or mock.`);
    process.exit(1);
  }
}
if (!isMock && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY isn't set. Add it to .env (pnpm eval loads it).");
  process.exit(1);
}

const anthropicClient = isMock ? undefined : new Anthropic();

// ---------- Run one test case ----------

// An extractor for one test case. Made fresh per test case so each test case's token
// usage is counted separately, even with several test cases running at once.
const makeExtractorForTestCase = (modelName: string, testCase: LabelledTestCase, tokensUsedForLetterExtraction: TokenUsage[]): LetterExtractor => {
  if (modelName === "mock") {
    if (!testCase.truth) throw new Error(`${testCase.id} has no truth, so the mock model can't read it`);
    const truth = testCase.truth;
    return async () => mockModelExtractionFromTruth(truth);
  }
  return makeAnthropicExtractor({
    client: anthropicClient!,
    model: MODEL_IDS[modelName]!,
    onUsage: (modelCallUsage) => tokensUsedForLetterExtraction.push(modelCallUsage),
  });
};

// Runs one test case through the same verifier the product uses, with this
// test case's customer input, loan and date, then scores the outcome.
const runAndEvaluateOneTestCase = async (testCase: LabelledTestCase): Promise<SettlementLetterVerificationEvaluation> => {
  const tokensUsedForLetterExtraction: TokenUsage[] = [];
  const verifySettlementLetter = createSettlementLetterVerifier({
    cheapModel: makeExtractorForTestCase(cheapModelName, testCase, tokensUsedForLetterExtraction),
    strongModel: makeExtractorForTestCase(strongModelName ?? cheapModelName, testCase, tokensUsedForLetterExtraction),
    escalationRule: strongModelName === undefined ? "never" : shouldEscalateUnsureOnly ? "unsure_only" : "any_non_accept",
    knownCreditors,
    maxUploadAttempts: 5,
    getToday: () => testCase.today,
    bankHolidays: ENGLAND_AND_WALES_BANK_HOLIDAYS,
  });
  const startedAt = Date.now();
  const verificationOutcome = await verifySettlementLetter({ letterFile: testCase.letterFile, application: testCase.application, loan: testCase.loan, attemptNumber: 1 });
  return evaluateOutcomeOfSettlementLetterVerification(testCase, verificationOutcome, tokensUsedForLetterExtraction, (Date.now() - startedAt) / 1000);
};

// ---------- Run them all ----------

// The mark printed next to each test case for its grade.
const MARK_BY_GRADE: Record<SettlementLetterVerificationEvaluation["grade"], string> = {
  correct: "✓",
  wrongly_accepted: "✗ WRONGLY ACCEPTED",
  wrongly_rejected: "✗ wrongly rejected",
  wrong_reason: "~ wrong reason",
  service_error: "! service error",
};

// Runs every test case, with at most TEST_CASES_IN_FLIGHT going at once.
//
// How: we start a few "workers". A worker is just a call to
// keepTakingTheNextTest case: a loop that takes the next test case off a shared
// queue, runs it, and repeats until the queue is empty. While one worker is
// waiting on the model API, JavaScript runs the others, so several model
// calls are out at once. No threads: it's the normal event loop. Reports are
// stored by position, so they stay in the dataset's order.
const runAndEvaluateAllTestCases = async (testCases: LabelledTestCase[]): Promise<SettlementLetterVerificationEvaluation[]> => {
  const verificationEvaluations: SettlementLetterVerificationEvaluation[] = new Array(testCases.length);
  let nextIndex = 0; // the shared queue: the position of the next test case to take

  const keepTakingTheNextTestCase = async () => {
    while (nextIndex < testCases.length) {
      // Taking a test case can't be interrupted (there's no await in it), so
      // two workers never take the same one.
      const index = nextIndex++;
      const verificationEvaluation = await runAndEvaluateOneTestCase(testCases[index]!);
      verificationEvaluations[index] = verificationEvaluation;
      console.log(`${MARK_BY_GRADE[verificationEvaluation.grade]} ${verificationEvaluation.id.padEnd(24)} ${verificationEvaluation.outcome}${verificationEvaluation.escalated ? " (escalated)" : ""}`);
    }
  };

  // Start the workers: each call begins a loop and returns a promise that
  // finishes when that loop does. Then wait for all of them.
  const workerCount = Math.min(TEST_CASES_IN_FLIGHT, testCases.length);
  const runningWorkers: Promise<void>[] = [];
  for (let workerNumber = 0; workerNumber < workerCount; workerNumber++) {
    runningWorkers.push(keepTakingTheNextTestCase());
  }
  await Promise.all(runningWorkers);
  return verificationEvaluations;
};

const loadDatasetOrExit = async <T>(loading: Promise<T>): Promise<T> =>
  loading.catch((error: unknown) => {
    const isMissingFolder = error instanceof Error && "code" in error && error.code === "ENOENT" && error.message.includes("scandir");
    console.error(
      isMissingFolder
        ? `Couldn't read ${datasetFolder}/.${datasetFolder === DEFAULT_DATASET_FOLDER ? " Run `pnpm generate` first." : ""}`
        : `Problem in ${datasetFolder}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });

const testCases = await loadDatasetOrExit(loadLabelledTestCasesFromFolder(datasetFolder));
// The creditors the checks accept: the dataset's own known-creditors.json, or
// the synthetic creditors for the dev set.
const knownCreditors = (await loadDatasetOrExit(loadKnownCreditorsFromFolder(datasetFolder))) ?? SYNTHETIC_KNOWN_CREDITORS;

console.log(`\nRunning ${testCases.length} test cases with ${runLabel}\n`);
const verificationEvaluations = await runAndEvaluateAllTestCases(testCases);
const scorecard = buildScorecardFromVerificationEvaluations(verificationEvaluations);
const readingAccuracy = buildReadingAccuracyFromVerificationEvaluations(verificationEvaluations);

// ---------- Report: testing the model alone ----------

// Which model ID each reading came from, for the table headings.
const modelLabel = { cheap: cheapModelName, strong: strongModelName ?? cheapModelName };

console.log("\nReading accuracy (the model alone: what it read vs what's printed on the letter)");
for (const model of ["cheap", "strong"] as const) {
  const rowsForModel = readingAccuracy.filter((fieldAccuracy) => fieldAccuracy.model === model);
  if (rowsForModel.length === 0) continue;
  console.log(`  ${model} (${modelLabel[model]})`);
  for (const fieldAccuracy of rowsForModel) {
    const isAllRight = fieldAccuracy.right === fieldAccuracy.total;
    console.log(`    ${fieldAccuracy.field.padEnd(18)} ${fieldAccuracy.right}/${fieldAccuracy.total}${isAllRight ? "" : "  ←"}`);
  }
}

// Every field a model read wrongly, with what's printed next to what it read.
for (const verificationEvaluation of verificationEvaluations) {
  for (const reading of verificationEvaluation.readings) {
    for (const fieldCheck of (reading.fieldReadingChecks ?? []).filter((fieldReadingCheck) => !fieldReadingCheck.isRight)) {
      console.log(`  misread: ${verificationEvaluation.id}, ${reading.model}, ${fieldCheck.field}: letter says ${fieldCheck.onLetter}, model read ${fieldCheck.modelRead}`);
    }
  }
}

// ---------- Report: testing the system ----------

console.log(`
System (model and code together: decision vs expected result)
Setup:            ${runLabel}
Wrongly accepted: ${scorecard.wronglyAccepted} of ${scorecard.shouldReject} that should be rejected   ${scorecard.wronglyAccepted === 0 ? "(target 0 ✓)" : "(TARGET IS 0)"}
Wrongly rejected: ${scorecard.wronglyRejected} of ${scorecard.shouldAccept} that should be accepted
Wrong reason:     ${scorecard.wrongReason}
Escalated:        ${scorecard.escalated} of ${scorecard.testCases}
Service errors:   ${scorecard.serviceErrors}
Cost:             $${scorecard.totalCostUsd.toFixed(4)} total, $${scorecard.costPerTestCaseUsd.toFixed(5)} per test case
Time:             ${scorecard.averageSeconds.toFixed(1)}s per test case on average`);

// Detail for anything that wasn't correct: what each model's reading led to.
for (const verificationEvaluation of verificationEvaluations.filter((verificationEvaluation) => verificationEvaluation.grade !== "correct")) {
  console.log(`\n${verificationEvaluation.id}: ${verificationEvaluation.grade}${verificationEvaluation.error ? ` (${verificationEvaluation.error})` : ""}`);
  for (const reading of verificationEvaluation.readings) {
    console.log(`  ${reading.model}: ${reading.verdict}, not passing: ${reading.notPassing.join(", ") || "none"}`);
  }
}

await mkdir(RESULTS_FOLDER, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const resultsFile = join(RESULTS_FOLDER, `${timestamp}_${runLabel.replace(/[: /]+/g, "_")}.json`);
await writeFile(resultsFile, JSON.stringify({ setup: runLabel, ranAt: new Date().toISOString(), scorecard, readingAccuracy, verificationEvaluations }, null, 2) + "\n");
console.log(`\nSaved to ${resultsFile}`);
