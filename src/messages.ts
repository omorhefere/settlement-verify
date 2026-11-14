import type { CheckResult } from "./types.ts";

// What the customer sees when their letter isn't accepted (SPEC.md > Outcomes:
// reasons phrased so they can act on them). Check `reason`s are for logs and
// evals; these are for people.

// The message to show the customer for one check that didn't pass.
export const customerMessageForCheckResult = (checkResult: CheckResult): string => {
  switch (checkResult.check) {
    case "settlement_letter":
      return checkResult.status === "fail"
        ? "This doesn't look like a settlement letter. Please upload the settlement letter from your creditor."
        : "We couldn't tell if this is a settlement letter. Please upload a clear copy of the whole letter.";
    case "known_creditor":
      return checkResult.status === "fail"
        ? "We can't accept settlement letters from this creditor yet."
        : "We couldn't find the creditor's name. Please upload a clear copy of the whole letter.";
    case "amount":
      // Fail reasons from checkSettlementFigureMatchesEntered are already written for the customer.
      return checkResult.status === "fail"
        ? checkResult.reason
        : "We couldn't read the settlement figure clearly. Please upload a clearer copy.";
    case "account":
      return checkResult.status === "fail"
        ? checkResult.reason
        : "We couldn't find your account or agreement number. Please upload a clear copy of the whole letter.";
    case "expiry":
      return checkResult.status === "fail"
        ? "This settlement figure has expired. Please ask your creditor for an up-to-date letter."
        : "We couldn't read the date this figure is valid until. Please upload a clearer copy.";
    case "loan_start_date":
      return "This letter doesn't seem to match your loan. Please check you've uploaded the right letter.";
  }
};

// Messages for every check that didn't pass (fail or unsure), without repeats.
export const customerMessagesForNotPassingChecks = (checkResults: CheckResult[]): string[] => [
  ...new Set(
    checkResults.filter((checkResult) => checkResult.status !== "pass").map(customerMessageForCheckResult),
  ),
];
