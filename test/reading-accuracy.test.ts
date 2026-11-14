import { describe, expect, it } from "vitest";
import { compareModelReadingWithLetterTruth, type ReadingField } from "../src/evals/reading-accuracy.ts";
import type { LetterExtraction } from "../src/extraction.ts";
import { mockModelExtractionFromTruth } from "../src/synthetic/mock-model.ts";
import { TEST_CASES } from "../src/synthetic/test-cases.ts";
import type { LetterTruth } from "../src/synthetic/types.ts";

const truthOf = (id: string): LetterTruth => TEST_CASES.find((testCase) => testCase.id === id)!.truth;

// The fields a reading got wrong.
const wrongFields = (extraction: LetterExtraction, truth: LetterTruth): ReadingField[] =>
  compareModelReadingWithLetterTruth(extraction, truth)
    .filter((fieldCheck) => !fieldCheck.isRight)
    .map((fieldCheck) => fieldCheck.field);

describe("compareModelReadingWithLetterTruth", () => {
  // The mock model reads perfectly, so every field of every letter is right.
  it.each(TEST_CASES.map((testCase) => [testCase.id, testCase.truth] as const))("%s: a perfect reading gets every field right", (_, truth) => {
    expect(wrongFields(mockModelExtractionFromTruth(truth), truth)).toEqual([]);
  });

  it("scores the fields each letter has", () => {
    const fields = (id: string) => compareModelReadingWithLetterTruth(mockModelExtractionFromTruth(truthOf(id)), truthOf(id)).map((fieldCheck) => fieldCheck.field);
    expect(fields("formal-clean")).toEqual(["settlement_letter", "settlement_figure", "letter_date", "expiry", "account_number", "creditor"]);
    // A monthly statement has no letter date or expiry to score.
    expect(fields("monthly-statement")).toEqual(["settlement_letter", "settlement_figure", "account_number", "creditor"]);
  });

  it("settlement figure: a dropped digit is wrong", () => {
    const truth = truthOf("formal-clean");
    const perfect = mockModelExtractionFromTruth(truth);
    const misread = {
      ...perfect,
      amounts: perfect.amounts.map((amount) => (amount.category === "settlement_figure" ? { ...amount, pence: 49780 } : amount)),
    };
    expect(wrongFields(misread, truth)).toEqual(["settlement_figure"]);
  });

  it("expiry: a valid-until date read month-first is wrong", () => {
    const truth = truthOf("formal-clean");
    const perfect = mockModelExtractionFromTruth(truth);
    const misread = {
      ...perfect,
      dates: perfect.dates.map((letterDate) => (letterDate.category === "figure_valid_until" ? { ...letterDate, iso: "2026-30-11" } : letterDate)),
    };
    expect(wrongFields(misread, truth)).toEqual(["expiry"]);
  });

  it("expiry: a validity period read as calendar days is wrong", () => {
    const truth = truthOf("app-clean");
    const perfect = mockModelExtractionFromTruth(truth);
    const misread = { ...perfect, validity_period: { ...perfect.validity_period!, unit: "calendar_days" as const } };
    expect(wrongFields(misread, truth)).toEqual(["expiry"]);
  });

  it("account number: a letter with none, where the model labels a regulatory number as an account number, is wrong", () => {
    const truth = truthOf("app-clean");
    const perfect = mockModelExtractionFromTruth(truth);
    const misread = {
      ...perfect,
      identifier_numbers: [{ label: null, value: "900001", category: "account_number" as const, source_text: "900001" }],
    };
    expect(wrongFields(misread, truth)).toEqual(["account_number"]);
  });

  it("creditor: the legal name counts as right, another name doesn't", () => {
    const truth = truthOf("formal-clean");
    const perfect = mockModelExtractionFromTruth(truth);
    const legalName = { ...perfect, creditor: { value: "Harbour Credit plc", source_text: "Harbour Credit plc" } };
    const otherName = { ...perfect, creditor: { value: "Harbour Bank", source_text: "Harbour Bank" } };
    expect(wrongFields(legalName, truth)).toEqual([]);
    expect(wrongFields(otherName, truth)).toEqual(["creditor"]);
  });

  it("settlement letter: calling a monthly statement a settlement letter is wrong", () => {
    const truth = truthOf("monthly-statement");
    const misread = { ...mockModelExtractionFromTruth(truth), is_settlement_letter: "yes" as const };
    expect(wrongFields(misread, truth)).toEqual(["settlement_letter"]);
  });
});
