import { describe, expect, it } from "vitest";
import type { Amount, LetterDate } from "../src/extraction.ts";
import {
  addValidityPeriodToLetterDate,
  parsePrintedAmountToPence,
  parsePrintedUkDate,
  parsePrintedValidityPeriod,
  crossCheckAmountWithModelReading,
  crossCheckDateWithModelReading,
} from "../src/parse.ts";

describe("parsePrintedAmountToPence", () => {
  it.each([
    ["£3,987.20", 398720],
    ["3,987.20", 398720],
    ["£3987.20", 398720],
    ["£ 3,987.20", 398720],
    ["£3,987", 398700],
    ["£1,234,567.89", 123456789],
    ["£0.05", 5],
    ["  £12.00  ", 1200],
  ])("%s → %i", (printed, pence) => {
    expect(parsePrintedAmountToPence(printed)).toBe(pence);
  });

  it.each([
    "3,987.2O", // letter O: currency.js alone would accept this
    "£3,987.2", // one decimal place
    "£3,987.205", // three decimal places
    "1.234,56", // European format
    "£12,34.00", // misplaced comma
    "-£5.00",
    "£5.00 CR",
    "GBP 5.00",
    "$5.00",
    "£3,987.20 - £4,000.00",
    "",
    "£",
  ])("rejects %j", (printed) => {
    expect(parsePrintedAmountToPence(printed)).toBeNull();
  });
});

describe("parsePrintedUkDate", () => {
  it.each([
    ["03/04/2026", "2026-04-03"], // day first: 3 April, not 4 March
    ["3/4/2026", "2026-04-03"],
    ["03-04-2026", "2026-04-03"],
    ["03/04/26", "2026-04-03"],
    ["3rd April 2026", "2026-04-03"],
    ["3 April 2026", "2026-04-03"],
    ["3 Apr 2026", "2026-04-03"],
    ["3 Apr 26", "2026-04-03"],
    ["21st Sept 2026", "2026-09-21"],
    ["21 Sep 2026", "2026-09-21"],
    ["11th March 2026", "2026-03-11"],
    ["  3   April   2026 ", "2026-04-03"],
    ["29/02/2028", "2028-02-29"], // leap year
  ])("%s → %s", (printed, iso) => {
    expect(parsePrintedUkDate(printed)).toBe(iso);
  });

  it.each([
    ["01/01/50", "2050-01-01"],
    ["01/01/51", "1951-01-01"],
    ["01/01/99", "1999-01-01"],
    ["01/01/00", "2000-01-01"],
  ])("two-digit year pivot: %s → %s", (printed, iso) => {
    expect(parsePrintedUkDate(printed)).toBe(iso);
  });

  it.each([
    "31/02/2026", // not a real date
    "29/02/2026", // not a leap year
    "13/13/2026",
    "2026-04-03", // ISO is not a letter format we accept
    "April 3, 2026", // US order
    "3th April 2026", // wrong ordinal
    "3rd of April 2026",
    "03/04/2026 10:00",
    "3/4",
    "",
  ])("rejects %j", (printed) => {
    expect(parsePrintedUkDate(printed)).toBeNull();
  });
});

// A settlement figure as the model would extract it, with its label.
const settlementFigureAmount = (printed: string, pence: number | null): Amount => ({
  label: "Settlement figure",
  printed,
  pence,
  category: "settlement_figure",
  source_text: `Settlement figure: ${printed}`,
});

// A valid-until date as the model would extract it, with its label.
const validUntilDate = (printed: string, iso: string | null): LetterDate => ({
  label: "Valid until",
  printed,
  iso,
  category: "figure_valid_until",
  source_text: `Valid until ${printed}`,
});

describe("crossCheckAmountWithModelReading", () => {
  it("ok when code and model agree", () => {
    expect(crossCheckAmountWithModelReading(settlementFigureAmount("£3,987.20", 398720))).toEqual({ status: "ok", value: 398720 });
  });

  it("unsure: disagree (model off by 10x)", () => {
    expect(crossCheckAmountWithModelReading(settlementFigureAmount("£3,987.20", 39872))).toEqual({
      status: "unsure",
      reason: "disagree",
      parsed: 398720,
      model: 39872,
    });
  });

  it("unsure: model_null", () => {
    expect(crossCheckAmountWithModelReading(settlementFigureAmount("£3,987.20", null))).toMatchObject({ status: "unsure", reason: "model_null" });
  });

  it("unsure: unparseable, even if the model converted it", () => {
    expect(crossCheckAmountWithModelReading(settlementFigureAmount("3,987.2O", 398720))).toMatchObject({
      status: "unsure",
      reason: "unparseable",
      parsed: null,
    });
  });
});

describe("crossCheckDateWithModelReading", () => {
  it("ok when code and model agree", () => {
    expect(crossCheckDateWithModelReading(validUntilDate("03/04/2026", "2026-04-03"))).toEqual({ status: "ok", value: "2026-04-03" });
  });

  it("unsure: disagree (model read it as US order)", () => {
    expect(crossCheckDateWithModelReading(validUntilDate("03/04/2026", "2026-03-04"))).toMatchObject({
      status: "unsure",
      reason: "disagree",
      parsed: "2026-04-03",
      model: "2026-03-04",
    });
  });

  it("unsure: model_null", () => {
    expect(crossCheckDateWithModelReading(validUntilDate("3rd April 2026", null))).toMatchObject({ status: "unsure", reason: "model_null" });
  });

  it("unsure: unparseable", () => {
    expect(crossCheckDateWithModelReading(validUntilDate("31/02/2026", "2026-02-28"))).toMatchObject({ status: "unsure", reason: "unparseable" });
  });
});

describe("parsePrintedValidityPeriod", () => {
  it.each([
    ["three working days", { count: 3, unit: "working_days" }],
    ["3 working days", { count: 3, unit: "working_days" }],
    ["10 business days", { count: 10, unit: "working_days" }],
    ["28 days", { count: 28, unit: "calendar_days" }],
    ["twenty-eight calendar days", { count: 28, unit: "calendar_days" }],
    ["twenty eight days", { count: 28, unit: "calendar_days" }],
    ["one working day", { count: 1, unit: "working_days" }],
    ["  Seven   Days ", { count: 7, unit: "calendar_days" }],
  ])("%s", (printed, period) => {
    expect(parsePrintedValidityPeriod(printed)).toEqual(period);
  });

  it.each(["a few days", "three weeks", "3 working", "0 days", "45 days", "valid for three working days", ""])(
    "rejects %j",
    (printed) => {
      expect(parsePrintedValidityPeriod(printed)).toBeNull();
    },
  );
});

describe("addValidityPeriodToLetterDate", () => {
  const bankHolidays = ["2026-12-25", "2026-12-28"];
  it("letter date is day 0; working days skip weekends", () => {
    // Wed 11 Nov + 3 working days → Thu 12, Fri 13, Mon 16
    expect(addValidityPeriodToLetterDate("2026-11-11", { count: 3, unit: "working_days" }, bankHolidays)).toBe("2026-11-16");
  });
  it("working days skip bank holidays", () => {
    // Thu 24 Dec + 2 working days → (Fri 25 holiday, weekend, Mon 28 holiday) Tue 29, Wed 30
    expect(addValidityPeriodToLetterDate("2026-12-24", { count: 2, unit: "working_days" }, bankHolidays)).toBe("2026-12-30");
  });
  it("calendar days include weekends and holidays", () => {
    expect(addValidityPeriodToLetterDate("2026-11-11", { count: 28, unit: "calendar_days" }, bankHolidays)).toBe("2026-12-09");
  });
});

describe("until next payment", () => {
  it.each(["until your next payment due date", "until next payment is due", "Until your next monthly payment"])("parses %j", (printed) => {
    expect(parsePrintedValidityPeriod(printed)).toEqual({ count: 0, unit: "until_next_payment" });
  });
  it("expires on the letter date itself", () => {
    expect(addValidityPeriodToLetterDate("2026-11-11", { count: 0, unit: "until_next_payment" }, [])).toBe("2026-11-11");
  });
});
