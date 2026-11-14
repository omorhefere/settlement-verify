// Shared domain types. Money is integer pence; dates are ISO "YYYY-MM-DD".

// What the customer entered (SPEC.md > Flow).
export type Application = {
  enteredPence: number; // the settlement figure the customer typed in, in pence
  loanAgreementNumber: string; // the loan agreement number the customer typed in
};

// The one loan being settled, as it appears on the applicant's credit report.
// Checks compare the letter against this loan only, never the whole report.
export type Loan = {
  creditor: string; // as spelled on the credit report
  accountNumber: string;
  startDate: string | null; // YYYY-MM-DD, or null if the credit report has none
};

// The name of each check, as it appears in check results, labels and evals.
export type CheckName =
  | "settlement_letter"
  | "known_creditor"
  | "amount"
  | "account"
  | "expiry"
  | "loan_start_date";

// What a check concluded: the letter passes it, fails it, or code can't tell.
export type CheckStatus = "pass" | "fail" | "unsure";

// Every check returns pass, fail or unsure, plus a reason (SPEC.md > Checks).
export type CheckResult = {
  check: CheckName;
  status: CheckStatus;
  reason: string;
};
