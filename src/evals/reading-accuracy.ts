import { formatPenceAsPounds, normaliseCreditorName, normaliseIdentifierNumber } from "../checks.ts";
import type { LetterExtraction } from "../extraction.ts";
import {
  crossCheckAmountWithModelReading,
  crossCheckDateWithModelReading,
  crossCheckValidityPeriodWithModelReading,
} from "../parse.ts";
import type { LetterTruth } from "../synthetic/types.ts";

// Testing the model alone (SPEC.md > Metrics, level 1): did it read the letter
// correctly? Like a typing test: we know what's printed on the letter (its
// facts), so we compare that with what the model read, field by field. What
// the customer entered plays no part here.
//
// For synthetic letters the facts come from the truth the PDF was drawn from.
// For real letters they're written by hand in the test case's label file.

// What's printed on a letter: the answers the model's reading is scored
// against. A field set to null isn't on the letter, so it isn't scored.
export type LetterFacts = {
  isSettlementLetter: boolean;
  settlementPence: number | null; // the settlement figure; null if the letter has none
  letterDate: string | null; // YYYY-MM-DD
  // How long the figure is valid: a printed date, a period such as "three
  // working days", or "until your next payment due date". null if not stated.
  validity:
    | { kind: "date"; date: string }
    | { kind: "period"; count: number; unit: "calendar_days" | "working_days" }
    | { kind: "next_payment" }
    | null;
  accountNumber: string | null; // null if the letter prints no account or agreement number
  creditorNames: string[]; // any of these counts as reading the creditor right (e.g. trading and legal name)
};

// The facts of a synthetic letter, from the truth it was drawn from.
export const letterFactsFromTruth = (truth: LetterTruth): LetterFacts => {
  const isSettlementLetter = truth.layout !== "monthly_statement";
  const validity = truth.validity;
  return {
    isSettlementLetter,
    settlementPence: isSettlementLetter ? truth.settlementPence : null,
    letterDate: isSettlementLetter ? truth.letterDate : null,
    validity: !isSettlementLetter
      ? null
      : validity.kind === "period"
        ? { kind: "period", count: validity.count, unit: validity.unit }
        : validity,
    accountNumber: truth.accountNumber,
    creditorNames: [truth.creditor.name, truth.creditor.legalName],
  };
};

// The fields we score the model's reading on.
export type ReadingField =
  | "settlement_letter" // did it say yes for a settlement letter, no for anything else?
  | "settlement_figure"
  | "letter_date"
  | "expiry" // the valid-until date, or the validity period, whichever the letter uses
  | "account_number"
  | "creditor";

// One field of one reading: right or wrong, and both values so a miss can be
// shown side by side.
export type FieldReadingCheck = {
  field: ReadingField;
  isRight: boolean;
  onLetter: string; // what's printed on the letter
  modelRead: string; // what the model read
};

// Account number categories: a number in one of these that isn't the loan's
// would make the account check fail.
const ACCOUNT_NUMBER_CATEGORIES = ["account_number", "loan_agreement_number"];

// Compares what the model read from one letter with what's printed on it. For
// amounts and dates, "right" means both the text the model copied and the
// value it worked out are right (our code's cross-check agrees, and the value
// is the true one). Fields the letter doesn't have are left out.
export const compareModelReadingWithLetterFacts = (extraction: LetterExtraction, facts: LetterFacts): FieldReadingCheck[] => {
  const fieldChecks: FieldReadingCheck[] = [];

  // Settlement letter?
  const expectedAnswer = facts.isSettlementLetter ? "yes" : "no";
  fieldChecks.push({
    field: "settlement_letter",
    isRight: extraction.is_settlement_letter === expectedAnswer,
    onLetter: expectedAnswer,
    modelRead: extraction.is_settlement_letter,
  });

  // Settlement figure: every amount the model called the settlement figure
  // must be the true figure, and there must be at least one. A letter with no
  // settlement figure must have none.
  const settlementFigures = extraction.amounts.filter((amount) => amount.category === "settlement_figure");
  const settlementFiguresRead = settlementFigures.map((amount) => `"${amount.printed}" → ${amount.pence ?? "none"}p`).join(", ") || "none";
  const trueSettlementPence = facts.settlementPence;
  fieldChecks.push(
    trueSettlementPence === null
      ? { field: "settlement_figure", isRight: settlementFigures.length === 0, onLetter: "none", modelRead: settlementFiguresRead }
      : {
          field: "settlement_figure",
          isRight:
            settlementFigures.length > 0 &&
            settlementFigures.every((amount) => {
              const crossChecked = crossCheckAmountWithModelReading(amount);
              return crossChecked.status === "ok" && crossChecked.value === trueSettlementPence;
            }),
          onLetter: formatPenceAsPounds(trueSettlementPence),
          modelRead: settlementFiguresRead,
        },
  );

  // Dates the model put in one category must all be the true date.
  const checkDatesInCategory = (field: ReadingField, category: string, trueIsoDate: string) => {
    const datesInCategory = extraction.dates.filter((letterDate) => letterDate.category === category);
    fieldChecks.push({
      field,
      isRight:
        datesInCategory.length > 0 &&
        datesInCategory.every((letterDate) => {
          const crossChecked = crossCheckDateWithModelReading(letterDate);
          return crossChecked.status === "ok" && crossChecked.value === trueIsoDate;
        }),
      onLetter: trueIsoDate,
      modelRead: datesInCategory.map((letterDate) => `"${letterDate.printed}" → ${letterDate.iso ?? "none"}`).join(", ") || "none",
    });
  };

  if (facts.letterDate !== null) checkDatesInCategory("letter_date", "letter_date", facts.letterDate);

  // Expiry: a printed date, a period, or "until your next payment".
  const validity = facts.validity;
  if (validity?.kind === "date") {
    checkDatesInCategory("expiry", "figure_valid_until", validity.date);
  } else if (validity) {
    const expectedPeriod = validity.kind === "period" ? { count: validity.count, unit: validity.unit } : { count: 0, unit: "until_next_payment" };
    const periodRead = extraction.validity_period;
    const crossChecked = periodRead ? crossCheckValidityPeriodWithModelReading(periodRead) : undefined;
    fieldChecks.push({
      field: "expiry",
      isRight:
        crossChecked?.status === "ok" &&
        crossChecked.value.count === expectedPeriod.count &&
        crossChecked.value.unit === expectedPeriod.unit,
      onLetter: validity.kind === "period" ? `${validity.count} ${validity.unit}` : "until your next payment due date",
      modelRead: periodRead ? `"${periodRead.printed}" → ${periodRead.count ?? "none"} ${periodRead.unit ?? "none"}` : "none",
    });
  }

  // Account number: found if the letter prints one; otherwise no number
  // wrongly labelled as an account number.
  const numbersRead = extraction.identifier_numbers.map((identifier) => `[${identifier.category}] ${identifier.value}`).join(", ") || "none";
  if (facts.accountNumber !== null) {
    const trueAccountNumber = normaliseIdentifierNumber(facts.accountNumber);
    fieldChecks.push({
      field: "account_number",
      isRight: extraction.identifier_numbers.some((identifier) => normaliseIdentifierNumber(identifier.value) === trueAccountNumber),
      onLetter: facts.accountNumber,
      modelRead: numbersRead,
    });
  } else {
    fieldChecks.push({
      field: "account_number",
      isRight: !extraction.identifier_numbers.some((identifier) => ACCOUNT_NUMBER_CATEGORIES.includes(identifier.category)),
      onLetter: "none",
      modelRead: numbersRead,
    });
  }

  // Creditor: any of the letter's acceptable names counts.
  const creditorRead = extraction.creditor?.value ?? null;
  const acceptableCreditorNames = facts.creditorNames.map(normaliseCreditorName);
  fieldChecks.push({
    field: "creditor",
    isRight: creditorRead !== null && acceptableCreditorNames.includes(normaliseCreditorName(creditorRead)),
    onLetter: facts.creditorNames[0] ?? "none",
    modelRead: creditorRead ?? "none",
  });

  return fieldChecks;
};
