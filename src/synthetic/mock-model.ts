import { formatPenceAsPounds } from "../checks.ts";
import type { Amount, IdentifierNumber, LetterDate, LetterExtraction } from "../extraction.ts";
import { formatIsoAsLongDate, formatIsoAsNumericDate, formatIsoAsOrdinalDate } from "./render.ts";
import type { LetterTruth } from "./types.ts";

// A mock model that never misreads: it returns, from the letter's known
// contents, exactly what a perfect model would extract from the PDF.
// Running the real checks on this tests our code and the hand-written expected
// outcomes for free, with no real model involved. Once that passes, any
// failure in a real eval is down to the model's reading.

// The date format each layout prints, matching render.ts.
const DATE_FORMAT_BY_LAYOUT = {
  app: formatIsoAsLongDate,
  formal: formatIsoAsNumericDate,
  car_finance: formatIsoAsOrdinalDate,
  next_payment: formatIsoAsLongDate,
  monthly_statement: formatIsoAsNumericDate,
} as const;

const perfectlyReadAmount = (category: Amount["category"], pence: number, label: string | null): Amount => ({
  label,
  printed: formatPenceAsPounds(pence),
  pence,
  category,
  source_text: `${label ?? ""} ${formatPenceAsPounds(pence)}`.trim(),
});

const perfectlyReadDate = (
  category: LetterDate["category"],
  iso: string,
  formatDate: (iso: string) => string,
): LetterDate => ({
  label: null,
  printed: formatDate(iso),
  iso,
  category,
  source_text: formatDate(iso),
});

const perfectlyReadIdentifierNumber = (category: IdentifierNumber["category"], value: string): IdentifierNumber => ({
  label: null,
  value,
  category,
  source_text: value,
});

// What a perfect model would extract from the letter drawn from this truth.
export const mockModelExtractionFromTruth = (truth: LetterTruth): LetterExtraction => {
  const formatDate = DATE_FORMAT_BY_LAYOUT[truth.layout];
  const isStatement = truth.layout === "monthly_statement";

  const amounts: Amount[] = isStatement
    ? [perfectlyReadAmount("balance", truth.breakdown?.balancePence ?? truth.settlementPence, "Closing balance")]
    : [
        perfectlyReadAmount("settlement_figure", truth.settlementPence, "Settlement figure"),
        ...(truth.breakdown ? [perfectlyReadAmount("balance", truth.breakdown.balancePence, "Outstanding balance")] : []),
      ];

  const dates: LetterDate[] = [perfectlyReadDate("letter_date", truth.letterDate, formatDate)];
  if (!isStatement && truth.validity.kind === "date") {
    dates.push(perfectlyReadDate("figure_valid_until", truth.validity.date, formatDate));
  }
  if (truth.layout === "formal" && truth.loanStartDate) {
    dates.push(perfectlyReadDate("loan_start_date", truth.loanStartDate, formatDate));
  }

  const validity = truth.validity;
  const validity_period: LetterExtraction["validity_period"] = isStatement
    ? null
    : validity.kind === "period"
      ? { printed: validity.wording, count: validity.count, unit: validity.unit, source_text: `valid for ${validity.wording}` }
      : validity.kind === "next_payment"
        ? { printed: "until your next payment due date", count: null, unit: "until_next_payment", source_text: "valid until your next payment due date" }
        : null;

  return {
    is_settlement_letter: isStatement ? "no" : "yes",
    amounts,
    dates,
    validity_period,
    creditor: { value: truth.creditor.name, source_text: truth.creditor.name },
    identifier_numbers: [
      ...(truth.accountNumber
        ? [perfectlyReadIdentifierNumber(truth.layout === "formal" ? "loan_agreement_number" : "account_number", truth.accountNumber)]
        : []),
      perfectlyReadIdentifierNumber("other", "900001"),
      perfectlyReadIdentifierNumber("other", "00000001"),
    ],
  };
};
