import { describe, expect, it, vi } from "vitest";
import type { LetterExtraction } from "../src/extraction.ts";
import type { LetterExtractor } from "../src/extractors/types.ts";
import {
  createSettlementLetterVerifier,
  type SettlementLetterVerifierConfig,
  type UploadedLetterInput,
} from "../src/verify.ts";
import {
  appStyleLetterExtraction,
  appStyleLoan,
  checkConfig,
  cleanApplication,
  cleanLetterExtraction,
  cleanLoan,
  fakeAmount,
  fakeLetterDate,
} from "./fixtures.ts";

// Fake models: they return a fixed reading (or fail) instead of calling an API.
const fakeModelReturning = (extraction: LetterExtraction) => vi.fn<LetterExtractor>().mockResolvedValue(extraction);
const fakeModelFailingWith = (message: string) => vi.fn<LetterExtractor>().mockRejectedValue(new Error(message));

// A reading where the model dropped a digit converting £3,987.20 to pence.
const readingWithMisreadFigure = (): LetterExtraction => ({
  ...cleanLetterExtraction(),
  amounts: [fakeAmount("settlement_figure", "£3,987.20", 39872)],
});

// A reading of a letter whose figure expired on 1 November.
const readingOfExpiredLetter = (): LetterExtraction => ({
  ...cleanLetterExtraction(),
  dates: [fakeLetterDate("figure_valid_until", "01/11/2026", "2026-11-01")],
});

// A verifier with the spec's config, today = 8 Nov 2026, unless overridden.
const buildVerifierWithFakeModels = (
  cheapModel: LetterExtractor,
  strongModel: LetterExtractor,
  configOverrides: Partial<SettlementLetterVerifierConfig> = {},
) =>
  createSettlementLetterVerifier({
    cheapModel,
    strongModel,
    knownCreditors: checkConfig().knownCreditors,
    maxUploadAttempts: 5,
    escalationRule: "any_non_accept",
    getToday: () => "2026-11-08",
    bankHolidays: checkConfig().bankHolidays,
    ...configOverrides,
  });

// The clean application's upload, on the given attempt.
const uploadOnAttempt = (attemptNumber = 1): UploadedLetterInput => ({
  letterPdf: Buffer.from("%PDF fake"),
  application: cleanApplication(),
  loan: cleanLoan(),
  attemptNumber,
});

describe("settlement letter verifier", () => {
  it("accepts on the cheap model and never calls the strong one", async () => {
    const strongModel = fakeModelReturning(cleanLetterExtraction());
    const verify = buildVerifierWithFakeModels(fakeModelReturning(cleanLetterExtraction()), strongModel);
    const outcome = await verify(uploadOnAttempt());
    expect(outcome.outcome).toBe("accept");
    expect(outcome.readings.map((reading) => reading.model)).toEqual(["cheap"]);
    expect(strongModel).not.toHaveBeenCalled();
  });

  it("escalates a misread and accepts on the strong model", async () => {
    const verify = buildVerifierWithFakeModels(fakeModelReturning(readingWithMisreadFigure()), fakeModelReturning(cleanLetterExtraction()));
    const outcome = await verify(uploadOnAttempt());
    expect(outcome.outcome).toBe("accept");
    expect(outcome.readings.map((reading) => [reading.model, reading.verdict.kind])).toEqual([
      ["cheap", "unsure"],
      ["strong", "accept"],
    ]);
  });

  it("goes back to the customer with the strong model's reasons", async () => {
    const verify = buildVerifierWithFakeModels(fakeModelReturning(readingWithMisreadFigure()), fakeModelReturning(readingOfExpiredLetter()));
    expect(await verify(uploadOnAttempt(2))).toMatchObject({
      outcome: "retry",
      attemptsLeft: 3,
      messages: ["This settlement figure has expired. Please ask your creditor for an up-to-date letter."],
    });
  });

  it("tells the customer when they entered the balance", async () => {
    const uploadWithBalanceEntered = { ...uploadOnAttempt(), application: { ...cleanApplication(), enteredPence: 410255 } };
    const verify = buildVerifierWithFakeModels(fakeModelReturning(cleanLetterExtraction()), fakeModelReturning(cleanLetterExtraction()));
    const outcome = await verify(uploadWithBalanceEntered);
    expect(outcome.outcome).toBe("retry");
    if (outcome.outcome !== "retry") return;
    expect(outcome.messages[0]).toContain("which is the balance on the letter");
  });

  it("ends the application after the last attempt", async () => {
    const verify = buildVerifierWithFakeModels(fakeModelReturning(readingOfExpiredLetter()), fakeModelReturning(readingOfExpiredLetter()));
    expect((await verify(uploadOnAttempt(5))).outcome).toBe("ended");
  });

  it("treats a cheap model error as a service error, without calling the strong model", async () => {
    const strongModel = fakeModelReturning(cleanLetterExtraction());
    const verify = buildVerifierWithFakeModels(fakeModelFailingWith("timeout"), strongModel);
    expect(await verify(uploadOnAttempt())).toEqual({ outcome: "service_error", error: "timeout", readings: [] });
    expect(strongModel).not.toHaveBeenCalled();
  });

  it("treats a strong model error as a service error and keeps the cheap reading", async () => {
    const verify = buildVerifierWithFakeModels(fakeModelReturning(readingWithMisreadFigure()), fakeModelFailingWith("overloaded"));
    const outcome = await verify(uploadOnAttempt());
    expect(outcome.outcome).toBe("service_error");
    expect(outcome.readings.map((reading) => reading.model)).toEqual(["cheap"]);
  });

  it("unsure_only: a clear fail goes straight back to the customer", async () => {
    const strongModel = fakeModelReturning(cleanLetterExtraction());
    const verify = buildVerifierWithFakeModels(fakeModelReturning(readingOfExpiredLetter()), strongModel, {
      escalationRule: "unsure_only",
    });
    expect((await verify(uploadOnAttempt())).outcome).toBe("retry");
    expect(strongModel).not.toHaveBeenCalled();
  });

  it("unsure_only: an unsure still escalates", async () => {
    const verify = buildVerifierWithFakeModels(fakeModelReturning(readingWithMisreadFigure()), fakeModelReturning(cleanLetterExtraction()), {
      escalationRule: "unsure_only",
    });
    expect((await verify(uploadOnAttempt())).outcome).toBe("accept");
  });

  it("only ever gives the model the PDF, never the entered figure", async () => {
    const cheapModel = fakeModelReturning(cleanLetterExtraction());
    await buildVerifierWithFakeModels(cheapModel, fakeModelReturning(cleanLetterExtraction()))(uploadOnAttempt());
    expect(cheapModel).toHaveBeenCalledWith(uploadOnAttempt().letterPdf);
  });
});

describe("settlement letter verifier, app-style letter (shaped like the first real letter)", () => {
  const appStyleUpload = (): UploadedLetterInput => ({
    ...uploadOnAttempt(),
    application: { enteredPence: 125000, loanAgreementNumber: "FL0001" },
    loan: appStyleLoan(),
  });

  it("accepts within the validity period", async () => {
    const verify = buildVerifierWithFakeModels(fakeModelReturning(appStyleLetterExtraction()), fakeModelReturning(appStyleLetterExtraction()), {
      getToday: () => "2026-11-14",
    });
    expect((await verify(appStyleUpload())).outcome).toBe("accept");
  });

  it("goes back to the customer once the period has passed", async () => {
    const verify = buildVerifierWithFakeModels(fakeModelReturning(appStyleLetterExtraction()), fakeModelReturning(appStyleLetterExtraction()), {
      getToday: () => "2026-11-17",
    });
    expect((await verify(appStyleUpload())).outcome).toBe("retry");
  });
});
