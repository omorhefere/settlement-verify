import currency from "currency.js";
import { DateTime } from "luxon";
import type { Amount, LetterDate, ValidityPeriod } from "./extraction.ts";

// Code's own reading of what the model copied from the letter (SPEC.md >
// Extraction: amounts and dates are read twice). Parsers are strict: anything
// outside the accepted formats is null, which the cross-checks turn into unsure.

// ---------- Money ----------

// Accepted: optional £, optional space, digits with correct thousands commas
// or none, then no decimals or exactly two. "£1,234.56", "1234.56", "£1,234".
// Rejected: "£1,234.5", "1.234,56", "£12,34.00", "-£5", "3,987.2O", "GBP 5".
const STRICT_GBP = /^£? ?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?$/;

// Turns an amount as printed on the letter ("£3,987.20") into whole pence
// (398720). Returns null if the text isn't one of the accepted formats.
export const parsePrintedAmountToPence = (printedAmount: string): number | null => {
  const trimmedAmount = printedAmount.trim();
  // currency.js is lenient (it reads "3,987.2O" as 398720), so the regex gate
  // is what makes this strict. currency.js then does the conversion in integers.
  if (!STRICT_GBP.test(trimmedAmount)) return null;
  return currency(trimmedAmount.replace(/^£ ?/, "")).intValue;
};

// ---------- Dates ----------

// Two-digit years: up to the cutoff are 20yy, above it 19yy.
// 26 → 2026, 50 → 2050, 51 → 1951.
export const TWO_DIGIT_YEAR_CUTOFF = 50;

// UK order only (day first). d and M accept 1 or 2 digits.
const NUMERIC_FORMATS = ["d/M/yyyy", "d-M-yyyy"];
const WRITTEN_FORMATS = ["d MMMM yyyy", "d MMM yyyy"];
// en-GB knows "Sept" but not "Sep"; en-US knows "Sep". The locale only affects
// month names here; day/month order comes from the format string.
const WRITTEN_LOCALES = ["en-GB", "en-US"];

// The correct ordinal suffix for a day of the month: 1 → "st", 12 → "th".
const ordinalSuffixForDay = (dayOfMonth: number): string => {
  if (dayOfMonth >= 11 && dayOfMonth <= 13) return "th";
  switch (dayOfMonth % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
};

// "3rd April 2026" → "3 April 2026". A wrong suffix ("3th") is rejected.
const stripOrdinalSuffix = (printedDate: string): string | null => {
  const ordinalMatch = /^(\d{1,2})(st|nd|rd|th)(\s.*)$/i.exec(printedDate);
  if (!ordinalMatch) return printedDate;
  const [, day, suffix, restOfDate] = ordinalMatch as unknown as [string, string, string, string];
  return suffix.toLowerCase() === ordinalSuffixForDay(Number(day)) ? day + restOfDate : null;
};

// "03/04/26" → "03/04/2026", "3 Apr 26" → "3 Apr 2026".
const expandTwoDigitYear = (printedDate: string): string =>
  printedDate.replace(/([/\- ])(\d{2})$/, (_, separator: string, twoDigitYear: string) => {
    const yearWithinCentury = Number(twoDigitYear);
    return `${separator}${yearWithinCentury <= TWO_DIGIT_YEAR_CUTOFF ? 2000 + yearWithinCentury : 1900 + yearWithinCentury}`;
  });

// The first format and locale that reads the text as a real date, as
// YYYY-MM-DD, or null if none does.
const tryDateFormats = (dateText: string, formats: string[], locales: string[]): string | null => {
  for (const locale of locales) {
    for (const format of formats) {
      const parsedDate = DateTime.fromFormat(dateText, format, { locale, zone: "UTC" });
      if (parsedDate.isValid) return parsedDate.toISODate();
    }
  }
  return null;
};

// Turns a date as printed on a UK letter ("03/04/2026", "3rd April 2026")
// into YYYY-MM-DD. Returns null if the text isn't one of the accepted formats
// or isn't a real date (31/02/2026).
export const parsePrintedUkDate = (printedDate: string): string | null => {
  const collapsedDate = printedDate.trim().replace(/\s+/g, " ");
  const dateWithoutOrdinal = stripOrdinalSuffix(collapsedDate);
  if (dateWithoutOrdinal === null) return null;
  const dateWithFullYear = expandTwoDigitYear(dateWithoutOrdinal);
  return /^\d/.test(dateWithFullYear) && /[A-Za-z]/.test(dateWithFullYear)
    ? tryDateFormats(dateWithFullYear, WRITTEN_FORMATS, WRITTEN_LOCALES)
    : tryDateFormats(dateWithFullYear, NUMERIC_FORMATS, ["en-GB"]);
};

// ---------- Cross-check: compare code's reading with the model's ----------

// Why code's reading and the model's reading couldn't be settled on one value.
export type UnsureReadingReason =
  | "unparseable" // code couldn't parse the printed text
  | "model_null" // code parsed it, the model didn't convert it
  | "disagree"; // both converted, different results

// The outcome of comparing code's reading of a printed value with the model's:
// "ok" with the agreed value, or "unsure" with why and what each side read.
export type CrossCheckedReading<T> =
  | { status: "ok"; value: T }
  | { status: "unsure"; reason: UnsureReadingReason; parsed: T | null; model: T | null };

// Settles code's reading and the model's reading on one value, or says why
// it can't. Code's reading must exist and agree with the model's.
const crossCheckCodeReadingWithModelReading = <T>(
  codeReading: T | null,
  modelReading: T | null,
  areSameReading: (firstReading: T, secondReading: T) => boolean = (firstReading, secondReading) =>
    firstReading === secondReading,
): CrossCheckedReading<T> => {
  if (codeReading === null) return { status: "unsure", reason: "unparseable", parsed: codeReading, model: modelReading };
  if (modelReading === null) return { status: "unsure", reason: "model_null", parsed: codeReading, model: modelReading };
  if (!areSameReading(codeReading, modelReading)) {
    return { status: "unsure", reason: "disagree", parsed: codeReading, model: modelReading };
  }
  return { status: "ok", value: codeReading };
};

// Cross-checks one amount the model extracted: our code parses the text the
// model copied (e.g. "£3,987.20" → 398720) and compares it with the pence the
// model worked out itself. Both agree → "ok" with that pence. Our parse fails,
// the model gave no pence, or they differ → "unsure" with why.
export const crossCheckAmountWithModelReading = (amount: Amount): CrossCheckedReading<number> =>
  crossCheckCodeReadingWithModelReading(parsePrintedAmountToPence(amount.printed), amount.pence);

// Cross-checks one date the model extracted: our code parses the text the
// model copied (UK day-first, e.g. "03/04/2026" → "2026-04-03") and compares it
// with the ISO date the model worked out itself. Same rules as for amounts.
export const crossCheckDateWithModelReading = (letterDate: LetterDate): CrossCheckedReading<string> =>
  crossCheckCodeReadingWithModelReading(parsePrintedUkDate(letterDate.printed), letterDate.iso);

// ---------- Validity periods ----------

// How long a settlement figure is valid, as code understands it.
// "until_next_payment" ("valid until your next payment due date") has no
// count: the letter doesn't say when that is, so the figure only counts on the
// letter date itself (customers are told to upload on the day; SPEC.md).
export type ParsedValidityPeriod =
  | { count: number; unit: "calendar_days" | "working_days" }
  | { count: 0; unit: "until_next_payment" };

const UNIT_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEEN_WORDS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];

// "3", "three", "twenty-eight", "twenty eight" → number. Up to 31: validity
// periods are days to weeks, so anything bigger is treated as a misread.
const parseDayCount = (countText: string): number | null => {
  if (/^\d{1,2}$/.test(countText)) return Number(countText);
  const unitNumber = UNIT_WORDS.indexOf(countText);
  if (unitNumber > 0) return unitNumber;
  const teenIndex = TEEN_WORDS.indexOf(countText);
  if (teenIndex >= 0) return 10 + teenIndex;
  const tensMatch = /^(twenty|thirty)(?:[- ](\w+))?$/.exec(countText);
  if (!tensMatch) return null;
  const tens = tensMatch[1] === "twenty" ? 20 : 30;
  if (tensMatch[2] === undefined) return tens;
  const ones = UNIT_WORDS.indexOf(tensMatch[2]);
  return ones > 0 ? tens + ones : null;
};

// Turns a validity period as printed on the letter into a count and unit.
// Accepted: "<count> [working|business|calendar] day(s)", or "until [your]
// next payment [is] [due] [date]".
// "three working days" → 3 working days; "28 days" → 28 calendar days.
// Returns null for anything else.
export const parsePrintedValidityPeriod = (printedPeriod: string): ParsedValidityPeriod | null => {
  const normalisedPeriod = printedPeriod.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^until (your )?next (monthly )?payment( is)?( due)?( date)?$/.test(normalisedPeriod)) {
    return { count: 0, unit: "until_next_payment" };
  }
  const daysMatch = /^(.+?) (?:(working|business|calendar) )?days?$/.exec(normalisedPeriod);
  if (!daysMatch) return null;
  const count = parseDayCount(daysMatch[1]!);
  if (count === null || count < 1 || count > 31) return null;
  return { count, unit: daysMatch[2] === "working" || daysMatch[2] === "business" ? "working_days" : "calendar_days" };
};

// The model's own conversion of the validity period, in the same shape as
// code's, or null if the model didn't convert it.
const validityPeriodFromModelReading = (validityPeriod: ValidityPeriod): ParsedValidityPeriod | null => {
  if (validityPeriod.unit === "until_next_payment") return { count: 0, unit: "until_next_payment" };
  return validityPeriod.count === null || validityPeriod.unit === null
    ? null
    : { count: validityPeriod.count, unit: validityPeriod.unit };
};

// Compares code's reading of a printed validity period with the model's.
// Takes the extracted period; returns the agreed period or why it's unsure.
export const crossCheckValidityPeriodWithModelReading = (validityPeriod: ValidityPeriod): CrossCheckedReading<ParsedValidityPeriod> =>
  crossCheckCodeReadingWithModelReading(
    parsePrintedValidityPeriod(validityPeriod.printed),
    validityPeriodFromModelReading(validityPeriod),
    (firstPeriod, secondPeriod) => firstPeriod.count === secondPeriod.count && firstPeriod.unit === secondPeriod.unit,
  );

// Letter date + period → last valid day (YYYY-MM-DD). The letter date is day 0.
// Working days skip Saturdays, Sundays and the given bank holidays.
export const addValidityPeriodToLetterDate = (
  letterDate: string,
  period: ParsedValidityPeriod,
  bankHolidays: readonly string[],
): string => {
  const letterDay = DateTime.fromISO(letterDate, { zone: "UTC" });
  if (period.unit === "until_next_payment") return letterDate;
  if (period.unit === "calendar_days") return letterDay.plus({ days: period.count }).toISODate()!;
  let currentDay = letterDay;
  let workingDaysLeft = period.count;
  while (workingDaysLeft > 0) {
    currentDay = currentDay.plus({ days: 1 });
    const currentIsoDate = currentDay.toISODate()!;
    if (currentDay.weekday <= 5 && !bankHolidays.includes(currentIsoDate)) workingDaysLeft--;
  }
  return currentDay.toISODate()!;
};
