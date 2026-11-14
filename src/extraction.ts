import { z } from "zod";

// What the model returns from reading a settlement letter (SPEC.md > Extraction).
// The model reads; code decides. Nothing here is trusted until code has parsed
// and compared it.
//
// Amounts, dates and validity periods are read twice: `printed` is copied exactly as it appears,
// and the model also gives its own conversion. Code parses `printed` itself and
// compares the two; a disagreement or a parse failure means unsure.
//
// Missing information is `null` (single values) or `[]` (lists): not found,
// never guessed.

const sourceText = z
  .string()
  .describe("The exact line or phrase from the letter this value was read from.");

const printedLabel = z
  .string()
  .nullable()
  .describe("The label printed next to the value, exactly as written. null if there is no label.");

// One monetary amount on the letter, read twice (printed text and pence).
export const Amount = z.object({
  label: printedLabel,
  printed: z
    .string()
    .describe('The amount exactly as printed, including symbols and separators, e.g. "£3,987.20".'),
  pence: z
    .number()
    .int()
    .nullable()
    .describe("The same amount as a whole number of pence, e.g. 398720. null if you cannot convert it."),
  category: z.enum(["settlement_figure", "balance", "arrears", "fee", "other"]),
  source_text: sourceText,
});

// One date on the letter, read twice (printed text and YYYY-MM-DD).
export const LetterDate = z.object({
  label: printedLabel,
  printed: z
    .string()
    .describe('The date exactly as printed, e.g. "03/04/2026" or "3rd April 2026".'),
  iso: z
    .string()
    .nullable()
    .describe("The same date as YYYY-MM-DD. UK letters write day before month. null if you cannot convert it."),
  category: z.enum(["letter_date", "figure_valid_until", "loan_start_date", "other"]),
  source_text: sourceText,
});

// One account, agreement or reference number on the letter.
export const IdentifierNumber = z.object({
  label: printedLabel,
  value: z.string().describe("The number or reference exactly as printed, including spaces and dashes."),
  category: z.enum(["loan_agreement_number", "account_number", "reference_number", "other"]),
  source_text: sourceText,
});

// For letters that give how long the figure lasts instead of a date, e.g.
// "your settlement figure is valid for three working days". Code works out the
// expiry from the letter date.
export const ValidityPeriod = z.object({
  printed: z
    .string()
    .describe(
      'The period exactly as printed, e.g. "three working days", "28 days", "10 business days", "until your next payment due date".',
    ),
  count: z
    .number()
    .int()
    .nullable()
    .describe("The number of days as a number, e.g. 3. null if you cannot convert it, or for until_next_payment."),
  unit: z
    .enum(["calendar_days", "working_days", "until_next_payment"])
    .nullable()
    .describe(
      '"working_days" for working or business days, "calendar_days" for plain days, "until_next_payment" when the figure is valid until the next payment is due. null if unclear.',
    ),
  source_text: sourceText,
});

// Names are not extracted while the name check is deferred (SPEC.md > Checks):
// extract only what a check uses.

// Everything the model read from one letter: the output format it must return.
export const LetterExtraction = z.object({
  is_settlement_letter: z
    .enum(["yes", "no", "unsure"])
    .describe("Is this a settlement (or redemption / payoff) letter from a creditor?"),
  amounts: z.array(Amount).describe("Every monetary amount on the letter."),
  dates: z.array(LetterDate).describe("Every date on the letter, including the letter's own date at the top even if it has no label."),
  validity_period: ValidityPeriod.nullable().describe(
    "How long the settlement figure is valid, if the letter says it as a period. null if it doesn't.",
  ),
  creditor: z
    .object({ value: z.string(), source_text: sourceText })
    .nullable()
    .describe("The creditor who sent the letter. null if not found."),
  identifier_numbers: z
    .array(IdentifierNumber)
    .describe("Every account, agreement or reference number on the letter."),
});

// TypeScript types for the schemas above.
export type Amount = z.infer<typeof Amount>;
export type LetterDate = z.infer<typeof LetterDate>;
export type IdentifierNumber = z.infer<typeof IdentifierNumber>;
export type ValidityPeriod = z.infer<typeof ValidityPeriod>;
export type LetterExtraction = z.infer<typeof LetterExtraction>;
