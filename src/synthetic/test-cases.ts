import type { KnownCreditor } from "../checks.ts";
import type { LetterCreditor, LetterTruth, TestCase } from "./types.ts";

// The synthetic dev set: four letter styles, each clean and with near misses
// (SPEC.md > Data). Expected outcomes are written by hand from the truth,
// never by running the checks, so the evals can catch the checks being wrong.

const BRIGHTLOAN: LetterCreditor = {
  name: "Brightloan",
  legalName: "Brightloan Platform Limited",
  address: ["2nd Floor, 10 Example Yard", "London", "EC1A 1AA"],
  phone: "0300 000 0101",
};
const HARBOUR: LetterCreditor = {
  name: "Harbour Credit",
  legalName: "Harbour Credit plc",
  address: ["Harbour House", "1 Quay Street", "Bristol", "BS1 1AA"],
  phone: "0300 000 0202",
};
const NORTHWIND: LetterCreditor = {
  name: "Northwind Motor Finance",
  legalName: "Northwind Motor Finance Ltd",
  address: ["PO Box 123", "Leeds", "LS1 1AA"],
  phone: "0300 000 0303",
};
const KESTREL: LetterCreditor = {
  name: "Kestrel Loans",
  legalName: "Kestrel Loans Limited",
  address: ["Kestrel Court", "Manchester", "M1 1AA"],
  phone: "0300 000 0404",
};

// The known-creditor list the evals should use with these letters.
export const SYNTHETIC_KNOWN_CREDITORS: KnownCreditor[] = [
  { name: "Brightloan", aliases: ["Brightloan Platform"] },
  { name: "Harbour Credit", aliases: [] },
  { name: "Northwind Motor Finance", aliases: [] },
  { name: "Kestrel Loans", aliases: [] },
];

// A fictional customer with a placeholder address.
const fictionalCustomer = (name: string) => ({ name, address: ["1 Example Street", "Testville", "TE1 1ST"] });

// A clean test case: the customer entered the right figure, the loan matches.
const cleanTestCase = (
  id: string,
  description: string,
  truth: LetterTruth,
  enteredLoanAgreementNumber: string,
  today: string,
): TestCase => ({
  id,
  description,
  truth,
  application: { enteredPence: truth.settlementPence, loanAgreementNumber: enteredLoanAgreementNumber },
  loan: {
    creditor: truth.creditor.legalName.toUpperCase(),
    accountNumber: enteredLoanAgreementNumber,
    startDate: truth.loanStartDate ?? null,
  },
  today,
  expected: { accept: true, notPassing: [] },
});

// ---------- Base letters ----------

const appCleanTestCase = cleanTestCase(
  "app-clean",
  "App-style note: no account number, valid for three working days",
  {
    layout: "app",
    creditor: BRIGHTLOAN,
    customer: fictionalCustomer("Alex Sample"),
    letterDate: "2026-11-11", // Wed; three working days → Mon 16 Nov
    settlementPence: 125_000,
    validity: { kind: "period", count: 3, unit: "working_days", wording: "three working days" },
    accountNumber: null,
  },
  "BL-0042",
  "2026-11-12",
);

const formalCleanTestCase = cleanTestCase(
  "formal-clean",
  "Statutory-style statement: agreement number, breakdown, valid-until date",
  {
    layout: "formal",
    creditor: HARBOUR,
    customer: fictionalCustomer("Jordan Example"),
    letterDate: "2026-11-02",
    settlementPence: 497_800,
    breakdown: { balancePence: 512_340, interestPence: 4_210, rebatePence: 18_750 },
    validity: { kind: "date", date: "2026-11-30" },
    accountNumber: "HC-4471 2290",
    loanStartDate: "2023-06-14",
  },
  "HC44712290",
  "2026-11-12",
);

const carCleanTestCase = cleanTestCase(
  "car-clean",
  "Car finance: vehicle registration, ordinal valid-until date",
  {
    layout: "car_finance",
    creditor: NORTHWIND,
    customer: fictionalCustomer("Sam Placeholder"),
    letterDate: "2026-11-05",
    settlementPence: 1_124_599,
    breakdown: { balancePence: 1_189_020, interestPence: 6_310, rebatePence: 70_731 },
    validity: { kind: "date", date: "2026-11-19" },
    accountNumber: "NMF/88213/07",
    vehicleReg: "AB21 XYZ",
  },
  "NMF-88213-07",
  "2026-11-12",
);

const nextPaymentCleanTestCase = cleanTestCase(
  "next-payment-clean",
  'Valid "until your next payment due date", uploaded on the letter date',
  {
    layout: "next_payment",
    creditor: KESTREL,
    customer: fictionalCustomer("Taylor Testcase"),
    letterDate: "2026-11-12",
    settlementPence: 230_015,
    validity: { kind: "next_payment" },
    accountNumber: "KL 300 452",
  },
  "KL300452",
  "2026-11-12",
);

// ---------- Near misses ----------

// The figure with the first pair of different adjacent digits swapped (after
// the leading digit), like a customer mistyping it: 125000 → 152000.
const swapTwoAdjacentDigits = (pence: number): number => {
  const digits = String(pence);
  for (let digitIndex = 1; digitIndex < digits.length - 1; digitIndex++) {
    if (digits[digitIndex] !== digits[digitIndex + 1]) {
      return Number(digits.slice(0, digitIndex) + digits[digitIndex + 1] + digits[digitIndex] + digits.slice(digitIndex + 2));
    }
  }
  throw new Error(`No digits to swap in ${pence}`);
};

// A copy of a clean test case with one thing changed, which should be rejected
// by the given checks.
const nearMissOfTestCase = (
  baseTestCase: TestCase,
  id: string,
  description: string,
  testCaseChanges: Partial<TestCase>,
  notPassing: TestCase["expected"]["notPassing"],
): TestCase => ({
  ...baseTestCase,
  ...testCaseChanges,
  id,
  description,
  expected: { accept: false, notPassing },
});

// Every synthetic test case, in the order they are written to disk and run.
export const TEST_CASES: TestCase[] = [
  appCleanTestCase,
  nearMissOfTestCase(appCleanTestCase, "app-expired", "App-style, uploaded after the three working days", { today: "2026-11-17" }, ["expiry"]),
  nearMissOfTestCase(appCleanTestCase, "app-swapped-digits", "App-style, customer swapped two digits", {
    application: { ...appCleanTestCase.application, enteredPence: swapTwoAdjacentDigits(appCleanTestCase.truth.settlementPence) },
  }, ["amount"]),
  nearMissOfTestCase(appCleanTestCase, "app-other-creditor", "App-style, but the loan being settled is with a different creditor", {
    loan: { ...appCleanTestCase.loan, creditor: "HARBOUR CREDIT PLC" },
  }, ["account"]),

  formalCleanTestCase,
  nearMissOfTestCase(formalCleanTestCase, "formal-expired", "Formal, valid-until date has passed", { today: "2026-12-01" }, ["expiry"]),
  nearMissOfTestCase(formalCleanTestCase, "formal-balance-entered", "Formal, customer entered the balance, not the settlement figure", {
    application: { ...formalCleanTestCase.application, enteredPence: formalCleanTestCase.truth.breakdown!.balancePence },
  }, ["amount"]),
  nearMissOfTestCase(formalCleanTestCase, "formal-swapped-digits", "Formal, customer swapped two digits", {
    application: { ...formalCleanTestCase.application, enteredPence: swapTwoAdjacentDigits(formalCleanTestCase.truth.settlementPence) },
  }, ["amount"]),
  nearMissOfTestCase(formalCleanTestCase, "formal-other-account", "Formal, the letter is for a different account", {
    application: { ...formalCleanTestCase.application, loanAgreementNumber: "HC99990001" },
    loan: { ...formalCleanTestCase.loan, accountNumber: "HC99990001" },
  }, ["account"]),

  carCleanTestCase,
  nearMissOfTestCase(carCleanTestCase, "car-expired", "Car finance, valid-until date has passed", { today: "2026-11-20" }, ["expiry"]),
  nearMissOfTestCase(carCleanTestCase, "car-balance-entered", "Car finance, customer entered the balance", {
    application: { ...carCleanTestCase.application, enteredPence: carCleanTestCase.truth.breakdown!.balancePence },
  }, ["amount"]),

  nextPaymentCleanTestCase,
  nearMissOfTestCase(nextPaymentCleanTestCase, "next-payment-late", "Valid until next payment, uploaded the day after the letter", {
    today: "2026-11-13",
  }, ["expiry"]),

  {
    ...formalCleanTestCase,
    id: "monthly-statement",
    description: "Not a settlement letter: a normal monthly statement",
    truth: { ...formalCleanTestCase.truth, layout: "monthly_statement" },
    expected: { accept: false, notPassing: ["settlement_letter"] },
  },
];
