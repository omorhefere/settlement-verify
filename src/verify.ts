import { runAllChecksOnExtraction, type KnownCreditor } from "./checks.ts";
import type { LetterExtraction } from "./extraction.ts";
import type { LetterExtractor } from "./extractors/types.ts";
import { customerMessagesForNotPassingChecks } from "./messages.ts";
import { judgeCheckResults, type Verdict } from "./outcome.ts";
import type { Application, CheckResult, Loan } from "./types.ts";

// The verification flow (SPEC.md > Outcomes). The models only read; code
// decides.
//
//   cheap model reads the letter → checks → all pass? accept
//   otherwise → strong model reads the same letter from scratch → checks → all pass? accept
//   otherwise → back to the customer with reasons (upload n of maxUploadAttempts)
//   after the last attempt → the application ends
//
// What triggers the strong read: any check on the cheap reading that didn't
// pass (unsure or fail). The strong model gets only the letter: not the cheap
// model's reading and not the figure the customer entered, so its reading is
// independent. Checks then run on the strong reading alone.
//
// A model error is a service error: it doesn't use up an attempt.
//
// This is the product's flow: every upload would go through it. The evals and
// tests call the same function, so they measure exactly what would ship.

// The config a settlement letter verifier is built with. They stay the same
// for every upload.
export type SettlementLetterVerifierConfig = {
  // Reads every letter first.
  cheapModel: LetterExtractor;
  // Reads the letter again, from scratch, when the cheap reading doesn't pass.
  strongModel: LetterExtractor;
  // The creditors we accept letters from, with their other names.
  knownCreditors: KnownCreditor[];
  // How many uploads a customer gets before the application ends (5 in the spec).
  maxUploadAttempts: number;
  // When the strong model gets asked:
  //   "any_non_accept": after any unsure or fail (the spec's rule).
  //   "unsure_only": only after an unsure. The tighter rule to switch to if the
  //     evals show second readings causing letters to be wrongly accepted.
  //   "never": no second reading. For measuring one model on its own.
  escalationRule: "any_non_accept" | "unsure_only" | "never";
  // Today's date as YYYY-MM-DD. A function so tests can fix the date.
  getToday: () => string;
  // England and Wales bank holidays, for "valid for N working days" letters.
  bankHolidays: readonly string[];
};

// One upload: the letter and everything we already know about the application.
export type UploadedLetterInput = {
  letterFile: Buffer; // the uploaded letter: a PDF or a photo (JPEG, PNG, GIF or WebP)
  application: Application; // what the customer entered
  loan: Loan; // the loan being settled, from the credit report
  attemptNumber: number; // 1 for the first upload
};

// One model's reading of the letter, and what code made of it. Kept for the
// evidence trail and the evals.
export type ModelReading = {
  model: "cheap" | "strong";
  // What the model read from the letter. Holds the letter's PII on real
  // letters: mask it before storing or logging (SPEC.md > Data handling).
  extraction: LetterExtraction;
  checkResults: CheckResult[];
  verdict: Verdict;
};

// What happens after an upload. Every outcome keeps the readings, so you can
// see why.
export type VerificationOutcome =
  | { outcome: "accept"; readings: ModelReading[] }
  | { outcome: "retry"; messages: string[]; attemptsLeft: number; readings: ModelReading[] }
  | { outcome: "ended"; messages: string[]; readings: ModelReading[] }
  | { outcome: "service_error"; error: string; readings: ModelReading[] };

// Checks one uploaded settlement letter and decides what happens next.
export type SettlementLetterVerifier = (upload: UploadedLetterInput) => Promise<VerificationOutcome>;

// Builds a settlement letter verifier from its verifierConfig. Call this once with
// the config; then call the verifier it returns once per upload. (The evals
// build one per letter, so each letter's cost is counted separately.)
export const createSettlementLetterVerifier =
  (verifierConfig: SettlementLetterVerifierConfig): SettlementLetterVerifier =>
  async (upload) => {
    // Asks one model to read the letter, then runs every check on what it read.
    // Returns an Error only when the model call itself failed.
    const readLetterWithModel = async (model: ModelReading["model"]): Promise<ModelReading | Error> => {
      const extractor = model === "cheap" ? verifierConfig.cheapModel : verifierConfig.strongModel;
      // Only the model call is caught: that's the service. A bug in our own
      // code (e.g. judgeCheckResults finding a missing check) must crash, not be retried
      // as if the service were down.
      const extraction = await extractor(upload.letterFile).catch((error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
      );
      if (extraction instanceof Error) return extraction;
      const checkResults = runAllChecksOnExtraction(extraction, upload.application, upload.loan, {
        knownCreditors: verifierConfig.knownCreditors,
        today: verifierConfig.getToday(),
        bankHolidays: verifierConfig.bankHolidays,
      });
      return { model, extraction, checkResults, verdict: judgeCheckResults(checkResults) };
    };

    const serviceErrorOutcome = (error: Error, readings: ModelReading[]): VerificationOutcome => ({
      outcome: "service_error",
      error: error.message,
      readings,
    });

    // Not accepted: tell the customer why (from the last reading), and either
    // let them try again or end the application if that was the last attempt.
    const sendBackToCustomer = (readings: ModelReading[]): VerificationOutcome => {
      const finalReading = readings[readings.length - 1]!;
      const messages = customerMessagesForNotPassingChecks(finalReading.checkResults);
      const attemptsLeft = verifierConfig.maxUploadAttempts - upload.attemptNumber;
      return attemptsLeft > 0
        ? { outcome: "retry", messages, attemptsLeft, readings }
        : { outcome: "ended", messages, readings };
    };

    const cheapReading = await readLetterWithModel("cheap");
    if (cheapReading instanceof Error) return serviceErrorOutcome(cheapReading, []);
    if (cheapReading.verdict.kind === "accept") return { outcome: "accept", readings: [cheapReading] };
    if (verifierConfig.escalationRule === "never") return sendBackToCustomer([cheapReading]);
    if (verifierConfig.escalationRule === "unsure_only" && cheapReading.verdict.kind === "fail") {
      return sendBackToCustomer([cheapReading]);
    }

    const strongReading = await readLetterWithModel("strong");
    if (strongReading instanceof Error) return serviceErrorOutcome(strongReading, [cheapReading]);
    if (strongReading.verdict.kind === "accept") return { outcome: "accept", readings: [cheapReading, strongReading] };
    return sendBackToCustomer([cheapReading, strongReading]);
  };
