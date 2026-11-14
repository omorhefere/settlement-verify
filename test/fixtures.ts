import type { Amount, IdentifierNumber, LetterDate, LetterExtraction } from "../src/extraction.ts";
import { ENGLAND_AND_WALES_BANK_HOLIDAYS } from "../src/bank-holidays.ts";
import type { CheckConfig } from "../src/checks.ts";
import type { Application, Loan } from "../src/types.ts";

// Hand-built test inputs: a clean letter that should pass every check.
// Tests copy it and change one thing to make a near miss.

// One amount as the model would extract it, with no label.
export const fakeAmount = (category: Amount["category"], printed: string, pence: number | null): Amount => ({
  label: null,
  printed,
  pence,
  category,
  source_text: printed,
});

// One date as the model would extract it, with no label.
export const fakeLetterDate = (category: LetterDate["category"], printed: string, iso: string | null): LetterDate => ({
  label: null,
  printed,
  iso,
  category,
  source_text: printed,
});

// One account, agreement or reference number as the model would extract it.
export const fakeIdentifierNumber = (category: IdentifierNumber["category"], value: string): IdentifierNumber => ({
  label: null,
  value,
  category,
  source_text: value,
});

// The model's reading of a clean letter that matches cleanApplication and cleanLoan.
export const cleanLetterExtraction = (): LetterExtraction => ({
  is_settlement_letter: "yes",
  amounts: [
    fakeAmount("settlement_figure", "£3,987.20", 398720),
    fakeAmount("balance", "£4,102.55", 410255),
  ],
  dates: [
    fakeLetterDate("letter_date", "01/11/2026", "2026-11-01"),
    fakeLetterDate("figure_valid_until", "30/11/2026", "2026-11-30"),
    fakeLetterDate("loan_start_date", "15 March 2023", "2023-03-15"),
  ],
  validity_period: null,
  creditor: { value: "Acme Finance Ltd", source_text: "Acme Finance Ltd, 1 High Street" },
  identifier_numbers: [
    fakeIdentifierNumber("loan_agreement_number", "LA-1234 5678"),
    fakeIdentifierNumber("reference_number", "REF99"),
  ],
});

// Shaped like the first real letter (an app-generated note): no account
// number, only the creditor's regulatory numbers, no balance, and a validity
// period instead of an expiry date. Letter dated Wed 11 Nov 2026.
export const appStyleLetterExtraction = (): LetterExtraction => ({
  is_settlement_letter: "yes",
  amounts: [fakeAmount("settlement_figure", "£1,250.00", 125000)],
  dates: [fakeLetterDate("letter_date", "11 November 2026", "2026-11-11")],
  validity_period: {
    printed: "three working days",
    count: 3,
    unit: "working_days",
    source_text: "your settlement figure is valid for three working days",
  },
  creditor: { value: "Fluro", source_text: "Fluro is a trading name of Fluro Platform Limited" },
  identifier_numbers: [
    fakeIdentifierNumber("other", "723151"),
    fakeIdentifierNumber("other", "ZA002001"),
    fakeIdentifierNumber("other", "8302549"),
  ],
});

// The loan being settled for the app-style letter, as on the credit report.
export const appStyleLoan = (): Loan => ({
  creditor: "FLURO PLATFORM LIMITED",
  accountNumber: "FL0001",
  startDate: null,
});

// What the customer entered for the clean letter.
export const cleanApplication = (): Application => ({
  enteredPence: 398720,
  loanAgreementNumber: "LA12345678",
});

// The loan being settled for the clean letter, as it appears on the credit report.
export const cleanLoan = (): Loan => ({
  creditor: "ACME FINANCE",
  accountNumber: "LA12345678",
  startDate: "2023-03-15",
});

// Check config for the tests: three known creditors, today = 8 Nov 2026.
export const checkConfig = (): CheckConfig => ({
  knownCreditors: [
    { name: "Acme Finance", aliases: ["Acme Loans"] },
    { name: "Other Bank", aliases: [] },
    { name: "Fluro", aliases: ["Fluro Platform"] },
  ],
  today: "2026-11-08",
  bankHolidays: ENGLAND_AND_WALES_BANK_HOLIDAYS,
});
