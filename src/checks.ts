import type { LetterDate, LetterExtraction } from "./extraction.ts";
import {
  addValidityPeriodToLetterDate,
  crossCheckAmountWithModelReading,
  crossCheckDateWithModelReading,
  crossCheckValidityPeriodWithModelReading,
  type ParsedValidityPeriod,
  type CrossCheckedReading,
} from "./parse.ts";
import type { Application, CheckResult, Loan } from "./types.ts";

// The checks (SPEC.md > Checks). Pure functions: same input, same result.
// The model never decides; it only supplied the LetterExtraction.

// A creditor we support, with the other names its letters may use
// (trading names, old names). Kept in our config, not taken from the credit
// report.
export type KnownCreditor = {
  name: string; // the main name, used in reasons
  aliases: string[]; // other names the same creditor's letters may use
};

// What the checks need besides the letter, the application and the loan.
export type CheckConfig = {
  knownCreditors: KnownCreditor[]; // the creditors we accept letters from
  today: string; // YYYY-MM-DD, injected so checks stay pure and testable
  bankHolidays: readonly string[]; // for working-day validity periods
};

// ---------- Helpers ----------

// Whole pence as pounds for people to read: 398720 → "£3,987.20".
export const formatPenceAsPounds = (pence: number): string =>
  `£${(pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// An account, agreement or reference number in a form that can be compared:
// "12-3456 789" and "123456789" are the same number.
export const normaliseIdentifierNumber = (identifierNumber: string): string =>
  identifierNumber.toUpperCase().replace(/[\s\-/.]/g, "");

// A creditor name in a form that can be compared:
// "Acme Finance Ltd." and "ACME FINANCE" are the same creditor.
export const normaliseCreditorName = (creditorName: string): string =>
  creditorName
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(ltd|limited|plc|llp|uk)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// The known creditor a name refers to, by main name or alias.
const findKnownCreditorByName = (creditorName: string, knownCreditors: KnownCreditor[]): KnownCreditor | undefined => {
  const normalisedName = normaliseCreditorName(creditorName);
  return knownCreditors.find((knownCreditor) =>
    [knownCreditor.name, ...knownCreditor.aliases].map(normaliseCreditorName).includes(normalisedName),
  );
};

// Picking one value from all the letter's values of one category.
type SingleValuePick<T> =
  | { kind: "one"; value: T }
  | { kind: "none" }
  | { kind: "several"; values: T[] }
  | { kind: "unsure"; reason: string };

// An unsure reading as a sentence for the check's reason: why, and what code
// and the model each read.
const describeUnsureReading = <T>(
  unsureReading: Extract<CrossCheckedReading<T>, { status: "unsure" }>,
  formatValue: (value: T) => string,
): string => {
  const codeReadingText = unsureReading.parsed === null ? "unreadable" : formatValue(unsureReading.parsed);
  const modelReadingText = unsureReading.model === null ? "not converted" : formatValue(unsureReading.model);
  return `${unsureReading.reason}: code read ${codeReadingText}, model read ${modelReadingText}`;
};

// The same value printed twice (e.g. in the body and in a summary box) counts
// as one. Different values, or any unsure reading, never get picked.
const pickSingleDistinctValue = <T>(
  crossCheckedReadings: CrossCheckedReading<T>[],
  formatValue: (value: T) => string,
): SingleValuePick<T> => {
  if (crossCheckedReadings.length === 0) return { kind: "none" };
  const distinctValues: T[] = [];
  for (const crossCheckedReading of crossCheckedReadings) {
    if (crossCheckedReading.status === "unsure") {
      return { kind: "unsure", reason: describeUnsureReading(crossCheckedReading, formatValue) };
    }
    if (!distinctValues.includes(crossCheckedReading.value)) distinctValues.push(crossCheckedReading.value);
  }
  const [firstValue, ...otherValues] = distinctValues;
  if (firstValue === undefined) return { kind: "none" };
  return otherValues.length === 0 ? { kind: "one", value: firstValue } : { kind: "several", values: distinctValues };
};

const pickSettlementFigure = (extraction: LetterExtraction): SingleValuePick<number> =>
  pickSingleDistinctValue(
    extraction.amounts.filter((amount) => amount.category === "settlement_figure").map(crossCheckAmountWithModelReading),
    formatPenceAsPounds,
  );

const pickDateOfCategory = (extraction: LetterExtraction, category: LetterDate["category"]): SingleValuePick<string> =>
  pickSingleDistinctValue(
    extraction.dates.filter((letterDate) => letterDate.category === category).map(crossCheckDateWithModelReading),
    (isoDate) => isoDate,
  );

const normalisedIdentifierNumbersOnLetter = (extraction: LetterExtraction): string[] =>
  extraction.identifier_numbers.map((identifierNumber) => normaliseIdentifierNumber(identifierNumber.value));

// ---------- Checks ----------

// Is the document a settlement letter at all? Takes the model's reading;
// returns the "settlement_letter" check result.
export const checkLetterIsSettlementLetter = (extraction: LetterExtraction): CheckResult => {
  const check = "settlement_letter";
  switch (extraction.is_settlement_letter) {
    case "yes": return { check, status: "pass", reason: "Document is a settlement letter" };
    case "no": return { check, status: "fail", reason: "Document is not a settlement letter" };
    case "unsure": return { check, status: "unsure", reason: "Not clear whether this is a settlement letter" };
  }
};

// Is the letter from a creditor we support? Takes the model's reading and our
// known creditors; returns the "known_creditor" check result.
export const checkLetterCreditorIsKnown = (extraction: LetterExtraction, knownCreditors: KnownCreditor[]): CheckResult => {
  const check = "known_creditor";
  if (extraction.creditor === null) return { check, status: "unsure", reason: "No creditor found on the letter" };
  const knownCreditor = findKnownCreditorByName(extraction.creditor.value, knownCreditors);
  return knownCreditor
    ? { check, status: "pass", reason: `Known creditor: ${knownCreditor.name}` }
    : { check, status: "fail", reason: `Unknown creditor: ${extraction.creditor.value}` };
};

// Does the figure the customer entered match the letter's settlement figure
// exactly? Takes the model's reading and the application; returns the
// "amount" check result.
export const checkSettlementFigureMatchesEntered = (extraction: LetterExtraction, application: Application): CheckResult => {
  const check = "amount";
  const settlementFigurePick = pickSettlementFigure(extraction);
  switch (settlementFigurePick.kind) {
    case "none":
      return { check, status: "unsure", reason: "No settlement figure found on the letter" };
    case "unsure":
      return { check, status: "unsure", reason: `Settlement figure not read reliably (${settlementFigurePick.reason})` };
    case "several":
      return {
        check,
        status: "unsure",
        reason: `Several different settlement figures: ${settlementFigurePick.values.map(formatPenceAsPounds).join(", ")}`,
      };
    case "one": {
      const settlementFigurePence = settlementFigurePick.value;
      if (settlementFigurePence === application.enteredPence) {
        return { check, status: "pass", reason: `Entered figure matches the letter: ${formatPenceAsPounds(settlementFigurePence)}` };
      }
      // A reason the customer can act on (SPEC.md > Outcomes).
      const didCustomerEnterBalance = extraction.amounts
        .filter((amount) => amount.category === "balance")
        .map(crossCheckAmountWithModelReading)
        .some((crossCheckedBalance) => crossCheckedBalance.status === "ok" && crossCheckedBalance.value === application.enteredPence);
      return {
        check,
        status: "fail",
        reason: didCustomerEnterBalance
          ? `You entered ${formatPenceAsPounds(application.enteredPence)}, which is the balance on the letter, not the settlement figure (${formatPenceAsPounds(settlementFigurePence)})`
          : `You entered ${formatPenceAsPounds(application.enteredPence)}, but the letter's settlement figure is ${formatPenceAsPounds(settlementFigurePence)}`,
      };
    }
  }
};

// Is the letter for the loan being settled? (SPEC.md > Checks, in order)
// 1. Number: the letter shows the loan's number and the one the customer
//    entered. A different account number on the letter is a fail.
// 2. Creditor, only when the letter shows no account number at all: the
//    letter's creditor and the loan's creditor are the same known creditor.
// 3. Name: deferred. Until it exists, a letter with neither a number nor a
//    creditor is unsure.
// Creditor names are matched through our alias list, never directly against
// the credit report's spelling.
// Takes the model's reading, the application, the loan and our known
// creditors; returns the "account" check result.
export const checkLetterIsForLoanBeingSettled = (
  extraction: LetterExtraction,
  application: Application,
  loan: Loan,
  knownCreditors: KnownCreditor[],
): CheckResult => {
  const check = "account";
  const numbersOnLetter = normalisedIdentifierNumbersOnLetter(extraction);
  const loanAccountNumber = normaliseIdentifierNumber(loan.accountNumber);
  const enteredAgreementNumber = normaliseIdentifierNumber(application.loanAgreementNumber);

  // 1. Number
  if (numbersOnLetter.includes(loanAccountNumber) || numbersOnLetter.includes(enteredAgreementNumber)) {
    if (!numbersOnLetter.includes(enteredAgreementNumber)) {
      return { check, status: "fail", reason: "The letter doesn't show the loan agreement number you entered" };
    }
    if (!numbersOnLetter.includes(loanAccountNumber)) {
      return { check, status: "fail", reason: "The letter isn't for the loan being settled" };
    }
    return { check, status: "pass", reason: `Linked by account number to the loan with ${loan.creditor}` };
  }
  const accountNumbersOnLetter = extraction.identifier_numbers.filter(
    (identifierNumber) =>
      identifierNumber.category === "loan_agreement_number" || identifierNumber.category === "account_number",
  );
  if (accountNumbersOnLetter.length > 0) {
    return { check, status: "fail", reason: "The letter shows a different account number from the loan being settled" };
  }

  // 2. Creditor (the letter shows no account number)
  if (extraction.creditor === null) {
    return { check, status: "unsure", reason: "The letter shows no account number or creditor to link it to the loan" };
  }
  const letterCreditor = findKnownCreditorByName(extraction.creditor.value, knownCreditors);
  const loanCreditor = findKnownCreditorByName(loan.creditor, knownCreditors);
  if (!letterCreditor) {
    return { check, status: "unsure", reason: `Can't link by creditor: "${extraction.creditor.value}" isn't a known creditor` };
  }
  if (!loanCreditor) {
    return { check, status: "unsure", reason: `Can't link by creditor: the loan's creditor "${loan.creditor}" isn't in our list` };
  }
  if (letterCreditor !== loanCreditor) {
    return {
      check,
      status: "fail",
      reason: `The letter is from ${letterCreditor.name}, but the loan being settled is with ${loanCreditor.name}`,
    };
  }
  return { check, status: "pass", reason: `No account number on the letter; linked by creditor (${letterCreditor.name})` };
};

// A validity period for people to read: "3 working days", "until next payment".
const formatValidityPeriod = (period: ParsedValidityPeriod): string =>
  period.unit === "until_next_payment"
    ? "until next payment"
    : `${period.count} ${period.unit === "working_days" ? "working" : "calendar"} days`;

// Is the settlement figure still valid today?
// The expiry is the printed valid-until date, or the letter date plus the
// validity period ("valid for three working days"), or both if they agree.
// Takes the model's reading, today's date and bank holidays; returns the
// "expiry" check result.
export const checkSettlementFigureNotExpired = (
  extraction: LetterExtraction,
  today: string,
  bankHolidays: readonly string[],
): CheckResult => {
  const check = "expiry";
  const unsureResult = (reason: string): CheckResult => ({ check, status: "unsure", reason });
  const expiryDates: string[] = [];

  const printedExpiryPick = pickDateOfCategory(extraction, "figure_valid_until");
  if (printedExpiryPick.kind === "unsure") return unsureResult(`Expiry date not read reliably (${printedExpiryPick.reason})`);
  if (printedExpiryPick.kind === "several") return unsureResult(`Several different expiry dates: ${printedExpiryPick.values.join(", ")}`);
  if (printedExpiryPick.kind === "one") expiryDates.push(printedExpiryPick.value);

  if (extraction.validity_period !== null) {
    const crossCheckedPeriod = crossCheckValidityPeriodWithModelReading(extraction.validity_period);
    if (crossCheckedPeriod.status === "unsure") {
      return unsureResult(`Validity period not read reliably (${describeUnsureReading(crossCheckedPeriod, formatValidityPeriod)})`);
    }
    const letterDatePick = pickDateOfCategory(extraction, "letter_date");
    if (letterDatePick.kind !== "one") return unsureResult("The letter gives a validity period but no single, readable letter date");
    expiryDates.push(addValidityPeriodToLetterDate(letterDatePick.value, crossCheckedPeriod.value, bankHolidays));
  }

  const [expiryDate, ...otherExpiryDates] = [...new Set(expiryDates)];
  if (expiryDate === undefined) return unsureResult("No expiry date or validity period found on the letter");
  if (otherExpiryDates.length > 0) {
    return unsureResult(`The expiry date and validity period disagree: ${[expiryDate, ...otherExpiryDates].join(" vs ")}`);
  }
  // ISO dates compare correctly as strings. Valid on the expiry day itself.
  return expiryDate < today
    ? { check, status: "fail", reason: `Settlement figure expired on ${expiryDate}` }
    : { check, status: "pass", reason: `Valid until ${expiryDate}` };
};

// Does the loan start date on the letter match the credit report's?
// Optional extra evidence. Returns null when it can't run: no date on the
// letter, no date on the credit report, or a date that wasn't read reliably.
// It should add evidence, not send letters to the strong model on its own.
export const checkLoanStartDateMatchesCreditReport = (extraction: LetterExtraction, loan: Loan): CheckResult | null => {
  const check = "loan_start_date";
  const startDatePick = pickDateOfCategory(extraction, "loan_start_date");
  if (startDatePick.kind !== "one" || loan.startDate === null) return null;
  return startDatePick.value === loan.startDate
    ? { check, status: "pass", reason: `Loan start date matches: ${startDatePick.value}` }
    : { check, status: "fail", reason: `Loan start date differs: letter ${startDatePick.value}, credit report ${loan.startDate}` };
};

// Runs every check on one model's reading of a letter. Takes the reading, what
// the customer entered, the loan being settled and the check config; returns
// one result per check that ran, in a fixed order.
export const runAllChecksOnExtraction = (
  extraction: LetterExtraction,
  application: Application,
  loan: Loan,
  checkConfig: CheckConfig,
): CheckResult[] =>
  [
    checkLetterIsSettlementLetter(extraction),
    checkLetterCreditorIsKnown(extraction, checkConfig.knownCreditors),
    checkSettlementFigureMatchesEntered(extraction, application),
    checkLetterIsForLoanBeingSettled(extraction, application, loan, checkConfig.knownCreditors),
    checkSettlementFigureNotExpired(extraction, checkConfig.today, checkConfig.bankHolidays),
    checkLoanStartDateMatchesCreditReport(extraction, loan),
  ].filter((checkResult): checkResult is CheckResult => checkResult !== null);
