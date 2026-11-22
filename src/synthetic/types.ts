import type { CheckName, Application, Loan } from "../types.ts";

// A synthetic letter is drawn from its truth: the correct answers, written
// first. The same truth gives the expected outcome, so every generated letter
// comes labelled (SPEC.md > Data). All people and creditors are fictional.

// Which style of letter to draw.
export type LetterLayout =
  | "app" // short app-generated note, like the first real letter: no account number, a validity period
  | "formal" // statutory-style settlement statement: agreement number, breakdown, valid-until date
  | "car_finance" // car finance: vehicle registration, valid-until date
  | "next_payment" // valid "until your next payment due date"
  | "monthly_statement" // NOT a settlement letter: a normal statement, for the near miss
  | "table_statement"; // settlement quotation as a table, with a second, similar-looking amount next to the settlement figure

// How the letter says how long its settlement figure is valid.
export type FigureValidity =
  | { kind: "date"; date: string } // printed valid-until date
  | { kind: "period"; count: number; unit: "calendar_days" | "working_days"; wording: string } // e.g. "three working days"
  | { kind: "next_payment" };

// A fictional creditor, as printed on its letters.
export type LetterCreditor = {
  name: string; // as printed on the letter
  legalName: string; // as on the credit report
  address: string[];
  phone: string;
};

// Everything printed on one synthetic letter: the correct answers.
export type LetterTruth = {
  layout: LetterLayout;
  creditor: LetterCreditor;
  customer: { name: string; address: string[] };
  letterDate: string; // YYYY-MM-DD
  settlementPence: number;
  // Optional breakdown printed on formal letters: balance + interest - rebate.
  breakdown?: { balancePence: number; interestPence: number; rebatePence: number };
  // Printed on table statements next to the settlement figure: "total amount
  // payable under the agreement". A different amount; easy to confuse with it.
  agreementTotalPence?: number;
  validity: FigureValidity;
  accountNumber: string | null; // null: the letter prints no account number
  vehicleReg?: string;
  loanStartDate?: string;
};

// What the system should conclude. `notPassing` lists checks that must come
// back fail or unsure; on an accept it's empty.
export type ExpectedOutcome = { accept: boolean; notPassing: CheckName[] };

// One synthetic test case: a letter, the application around it, and the
// outcome it should get. Written to disk as the label file.
export type TestCase = {
  id: string; // file name: <id>.pdf and <id>.json
  description: string;
  truth: LetterTruth;
  // What the customer entered and the loan being settled, as the verifier sees them.
  application: Application;
  loan: Loan;
  today: string;
  expected: ExpectedOutcome;
};
