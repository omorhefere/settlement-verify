import { formatPenceAsPounds, normaliseCreditorName, normaliseIdentifierNumber } from "../checks.ts";
import type { LetterExtraction } from "../extraction.ts";
import {
  crossCheckAmountWithModelReading,
  crossCheckDateWithModelReading,
  crossCheckValidityPeriodWithModelReading,
} from "../parse.ts";
import type { LetterTruth } from "../synthetic/types.ts";

// Testing the model alone (SPEC.md > Metrics, level 1): did it read the letter
// correctly? Like a typing test: we know exactly what's printed on each
// synthetic letter (its truth), so we compare that with what the model read,
// field by field. What the customer entered plays no part here.

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

// Compares what the model read from one synthetic letter with what's printed
// on it. For amounts and dates, "right" means both the text the model copied
// and the value it worked out are right (our code's cross-check agrees, and
// the value is the true one). Fields a letter doesn't have are left out:
// a monthly statement has no settlement figure to date or expire.
export const compareModelReadingWithLetterTruth = (extraction: LetterExtraction, truth: LetterTruth): FieldReadingCheck[] => {
  const isSettlementLetter = truth.layout !== "monthly_statement";
  const fieldChecks: FieldReadingCheck[] = [];

  // Settlement letter?
  const expectedAnswer = isSettlementLetter ? "yes" : "no";
  fieldChecks.push({
    field: "settlement_letter",
    isRight: extraction.is_settlement_letter === expectedAnswer,
    onLetter: expectedAnswer,
    modelRead: extraction.is_settlement_letter,
  });

  // Settlement figure: every amount the model called the settlement figure
  // must be the true figure, and there must be at least one. A non-settlement
  // letter must have none.
  const settlementFigures = extraction.amounts.filter((amount) => amount.category === "settlement_figure");
  const settlementFiguresRead = settlementFigures.map((amount) => `"${amount.printed}" → ${amount.pence ?? "none"}p`).join(", ") || "none";
  if (isSettlementLetter) {
    fieldChecks.push({
      field: "settlement_figure",
      isRight:
        settlementFigures.length > 0 &&
        settlementFigures.every((amount) => {
          const crossChecked = crossCheckAmountWithModelReading(amount);
          return crossChecked.status === "ok" && crossChecked.value === truth.settlementPence;
        }),
      onLetter: formatPenceAsPounds(truth.settlementPence),
      modelRead: settlementFiguresRead,
    });
  } else {
    fieldChecks.push({
      field: "settlement_figure",
      isRight: settlementFigures.length === 0,
      onLetter: "none",
      modelRead: settlementFiguresRead,
    });
  }

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

  if (isSettlementLetter) {
    checkDatesInCategory("letter_date", "letter_date", truth.letterDate);

    // Expiry: a printed date, a period, or "until your next payment".
    const validity = truth.validity;
    if (validity.kind === "date") {
      checkDatesInCategory("expiry", "figure_valid_until", validity.date);
    } else {
      const expectedPeriod =
        validity.kind === "period" ? { count: validity.count, unit: validity.unit } : { count: 0, unit: "until_next_payment" };
      const periodRead = extraction.validity_period;
      const crossChecked = periodRead ? crossCheckValidityPeriodWithModelReading(periodRead) : undefined;
      fieldChecks.push({
        field: "expiry",
        isRight:
          crossChecked?.status === "ok" &&
          crossChecked.value.count === expectedPeriod.count &&
          crossChecked.value.unit === expectedPeriod.unit,
        onLetter: validity.kind === "period" ? validity.wording : "until your next payment due date",
        modelRead: periodRead ? `"${periodRead.printed}" → ${periodRead.count ?? "none"} ${periodRead.unit ?? "none"}` : "none",
      });
    }
  }

  // Account number: found if the letter prints one; otherwise no number
  // wrongly labelled as an account number.
  const numbersRead = extraction.identifier_numbers.map((identifier) => `[${identifier.category}] ${identifier.value}`).join(", ") || "none";
  if (truth.accountNumber !== null) {
    const trueAccountNumber = normaliseIdentifierNumber(truth.accountNumber);
    fieldChecks.push({
      field: "account_number",
      isRight: extraction.identifier_numbers.some((identifier) => normaliseIdentifierNumber(identifier.value) === trueAccountNumber),
      onLetter: truth.accountNumber,
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

  // Creditor: the printed name or the legal name both count.
  const creditorRead = extraction.creditor?.value ?? null;
  const acceptableCreditorNames = [truth.creditor.name, truth.creditor.legalName].map(normaliseCreditorName);
  fieldChecks.push({
    field: "creditor",
    isRight: creditorRead !== null && acceptableCreditorNames.includes(normaliseCreditorName(creditorRead)),
    onLetter: truth.creditor.name,
    modelRead: creditorRead ?? "none",
  });

  return fieldChecks;
};
