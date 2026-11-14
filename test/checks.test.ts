import { describe, expect, it } from "vitest";
import {
  checkLetterCreditorIsKnown,
  checkLetterIsForLoanBeingSettled,
  checkLetterIsSettlementLetter,
  checkLoanStartDateMatchesCreditReport,
  checkSettlementFigureMatchesEntered,
  checkSettlementFigureNotExpired,
  formatPenceAsPounds,
  normaliseCreditorName,
  normaliseIdentifierNumber,
  runAllChecksOnExtraction,
} from "../src/checks.ts";
import {
  appStyleLetterExtraction,
  appStyleLoan,
  checkConfig,
  cleanApplication,
  cleanLetterExtraction,
  cleanLoan,
  fakeAmount,
  fakeIdentifierNumber,
  fakeLetterDate,
} from "./fixtures.ts";

describe("helpers", () => {
  it("formatPenceAsPounds", () => {
    expect(formatPenceAsPounds(398720)).toBe("£3,987.20");
    expect(formatPenceAsPounds(5)).toBe("£0.05");
  });
  it("normaliseIdentifierNumber ignores spaces, dashes, slashes, dots and case", () => {
    expect(normaliseIdentifierNumber("la-1234 5678")).toBe("LA12345678");
    expect(normaliseIdentifierNumber("12/34.56")).toBe("123456");
  });
  it("normaliseCreditorName ignores case, punctuation and company suffixes", () => {
    expect(normaliseCreditorName("Acme Finance Ltd.")).toBe(normaliseCreditorName("ACME FINANCE"));
    expect(normaliseCreditorName("Smith & Co PLC")).toBe("smith and co");
  });
});

describe("clean letter", () => {
  it("passes every check", () => {
    const checkResults = runAllChecksOnExtraction(cleanLetterExtraction(), cleanApplication(), cleanLoan(), checkConfig());
    expect(checkResults.map((checkResult) => [checkResult.check, checkResult.status])).toEqual([
      ["settlement_letter", "pass"],
      ["known_creditor", "pass"],
      ["amount", "pass"],
      ["account", "pass"],
      ["expiry", "pass"],
      ["loan_start_date", "pass"],
    ]);
  });
});

describe("checkLetterIsSettlementLetter", () => {
  it.each([
    ["yes", "pass"],
    ["no", "fail"],
    ["unsure", "unsure"],
  ] as const)("%s → %s", (answer, status) => {
    expect(checkLetterIsSettlementLetter({ ...cleanLetterExtraction(), is_settlement_letter: answer }).status).toBe(status);
  });
});

describe("checkLetterCreditorIsKnown", () => {
  it("passes a known alias, reporting the main name", () => {
    const extraction = { ...cleanLetterExtraction(), creditor: { value: "ACME LOANS LTD", source_text: "ACME LOANS LTD" } };
    expect(checkLetterCreditorIsKnown(extraction, checkConfig().knownCreditors)).toEqual({
      check: "known_creditor",
      status: "pass",
      reason: "Known creditor: Acme Finance",
    });
  });
  it("fails an unknown creditor", () => {
    const extraction = { ...cleanLetterExtraction(), creditor: { value: "Shady Loans", source_text: "Shady Loans" } };
    expect(checkLetterCreditorIsKnown(extraction, checkConfig().knownCreditors)).toMatchObject({ status: "fail" });
  });
  it("unsure when no creditor was found", () => {
    expect(checkLetterCreditorIsKnown({ ...cleanLetterExtraction(), creditor: null }, checkConfig().knownCreditors).status).toBe("unsure");
  });
});

describe("checkSettlementFigureMatchesEntered", () => {
  const cleanLetterWithAmounts = (...amounts: ReturnType<typeof fakeAmount>[]) => ({ ...cleanLetterExtraction(), amounts });

  it("fails with a helpful reason when the balance was entered", () => {
    const checkResult = checkSettlementFigureMatchesEntered(cleanLetterExtraction(), { ...cleanApplication(), enteredPence: 410255 });
    expect(checkResult.status).toBe("fail");
    expect(checkResult.reason).toContain("which is the balance on the letter");
  });

  it("fails on swapped digits", () => {
    const checkResult = checkSettlementFigureMatchesEntered(cleanLetterExtraction(), { ...cleanApplication(), enteredPence: 398270 });
    expect(checkResult).toMatchObject({ status: "fail" });
    expect(checkResult.reason).not.toContain("balance");
  });

  it("is exact: one penny out fails", () => {
    expect(checkSettlementFigureMatchesEntered(cleanLetterExtraction(), { ...cleanApplication(), enteredPence: 398721 }).status).toBe("fail");
  });

  it("unsure when there is no settlement figure", () => {
    expect(checkSettlementFigureMatchesEntered(cleanLetterWithAmounts(fakeAmount("balance", "£4,102.55", 410255)), cleanApplication()).status).toBe("unsure");
  });

  it("the same figure printed twice counts as one", () => {
    const extraction = cleanLetterWithAmounts(fakeAmount("settlement_figure", "£3,987.20", 398720), fakeAmount("settlement_figure", "3,987.20", 398720));
    expect(checkSettlementFigureMatchesEntered(extraction, cleanApplication()).status).toBe("pass");
  });

  it("unsure when there are different settlement figures", () => {
    const extraction = cleanLetterWithAmounts(fakeAmount("settlement_figure", "£3,987.20", 398720), fakeAmount("settlement_figure", "£3,999.00", 399900));
    expect(checkSettlementFigureMatchesEntered(extraction, cleanApplication()).status).toBe("unsure");
  });

  it("unsure when the model misconverted, even if the entered figure matches the model", () => {
    const extraction = cleanLetterWithAmounts(fakeAmount("settlement_figure", "£3,987.20", 39872));
    expect(checkSettlementFigureMatchesEntered(extraction, { ...cleanApplication(), enteredPence: 39872 })).toMatchObject({ status: "unsure" });
  });
});

describe("checkLetterIsForLoanBeingSettled", () => {
  const knownCreditors = checkConfig().knownCreditors;

  describe("1. by number", () => {
    it("passes when the letter shows the loan's number", () => {
      expect(checkLetterIsForLoanBeingSettled(cleanLetterExtraction(), cleanApplication(), cleanLoan(), knownCreditors).reason).toContain("account number");
    });

    it("fails when the entered number isn't on the letter", () => {
      const checkResult = checkLetterIsForLoanBeingSettled(cleanLetterExtraction(), { ...cleanApplication(), loanAgreementNumber: "LA999" }, cleanLoan(), knownCreditors);
      expect(checkResult.status).toBe("fail");
    });

    it("fails when the letter isn't for the loan being settled", () => {
      const extraction = { ...cleanLetterExtraction(), identifier_numbers: [fakeIdentifierNumber("loan_agreement_number", "LA12345678")] };
      expect(checkLetterIsForLoanBeingSettled(extraction, cleanApplication(), { ...cleanLoan(), accountNumber: "XYZ" }, knownCreditors).status).toBe("fail");
    });

    it("fails when the letter shows a different account number, without falling back to the creditor", () => {
      const extraction = { ...cleanLetterExtraction(), identifier_numbers: [fakeIdentifierNumber("account_number", "SOMEONE-ELSE-1")] };
      expect(checkLetterIsForLoanBeingSettled(extraction, cleanApplication(), cleanLoan(), knownCreditors)).toMatchObject({
        status: "fail",
        reason: "The letter shows a different account number from the loan being settled",
      });
    });

    it("passes on a matching number even when the creditor name differs", () => {
      const extraction = { ...cleanLetterExtraction(), creditor: { value: "Something Else", source_text: "Something Else" } };
      expect(checkLetterIsForLoanBeingSettled(extraction, cleanApplication(), cleanLoan(), knownCreditors).status).toBe("pass");
    });
  });

  describe("2. by creditor, when the letter shows no account number", () => {
    it("passes an app-style letter: only regulatory numbers, creditor matches via aliases", () => {
      const checkResult = checkLetterIsForLoanBeingSettled(appStyleLetterExtraction(), cleanApplication(), appStyleLoan(), knownCreditors);
      expect(checkResult).toMatchObject({ status: "pass", reason: "No account number on the letter; linked by creditor (Fluro)" });
    });

    it("fails when the letter's creditor isn't the loan's creditor", () => {
      expect(checkLetterIsForLoanBeingSettled(appStyleLetterExtraction(), cleanApplication(), cleanLoan(), knownCreditors)).toMatchObject({
        status: "fail",
        reason: "The letter is from Fluro, but the loan being settled is with Acme Finance",
      });
    });

    it("unsure when the loan's creditor isn't in our list", () => {
      const checkResult = checkLetterIsForLoanBeingSettled(appStyleLetterExtraction(), cleanApplication(), { ...appStyleLoan(), creditor: "MYSTERY LTD" }, knownCreditors);
      expect(checkResult.status).toBe("unsure");
    });

    it("unsure when there's no number and no creditor (the name step is deferred)", () => {
      const extraction = { ...appStyleLetterExtraction(), creditor: null };
      expect(checkLetterIsForLoanBeingSettled(extraction, cleanApplication(), appStyleLoan(), knownCreditors).status).toBe("unsure");
    });
  });
});

describe("checkSettlementFigureNotExpired", () => {
  const bankHolidays = checkConfig().bankHolidays;
  const cleanLetterWithExpiryDate = (printed: string, iso: string | null) => ({
    ...cleanLetterExtraction(),
    dates: [fakeLetterDate("figure_valid_until", printed, iso)],
  });

  it("fails an expired figure", () => {
    expect(checkSettlementFigureNotExpired(cleanLetterWithExpiryDate("07/11/2026", "2026-11-07"), "2026-11-08", bankHolidays).status).toBe("fail");
  });
  it("passes on the expiry day itself", () => {
    expect(checkSettlementFigureNotExpired(cleanLetterWithExpiryDate("08/11/2026", "2026-11-08"), "2026-11-08", bankHolidays).status).toBe("pass");
  });
  it("unsure when no expiry was found", () => {
    expect(checkSettlementFigureNotExpired({ ...cleanLetterExtraction(), dates: [] }, "2026-11-08", bankHolidays).status).toBe("unsure");
  });
  it("unsure when the model read the date month-first", () => {
    expect(checkSettlementFigureNotExpired(cleanLetterWithExpiryDate("03/12/2026", "2026-03-12"), "2026-11-08", bankHolidays).status).toBe("unsure");
  });

  describe("validity period", () => {
    // Letter dated Wed 11 Nov 2026, valid for three working days → Mon 16 Nov.
    it("valid until the third working day, skipping the weekend", () => {
      expect(checkSettlementFigureNotExpired(appStyleLetterExtraction(), "2026-11-16", bankHolidays)).toEqual({
        check: "expiry",
        status: "pass",
        reason: "Valid until 2026-11-16",
      });
    });
    it("expired the day after", () => {
      expect(checkSettlementFigureNotExpired(appStyleLetterExtraction(), "2026-11-17", bankHolidays).status).toBe("fail");
    });
    it("unsure when the model misread the period", () => {
      const extraction = { ...appStyleLetterExtraction(), validity_period: { ...appStyleLetterExtraction().validity_period!, count: 30 } };
      expect(checkSettlementFigureNotExpired(extraction, "2026-11-12", bankHolidays).status).toBe("unsure");
    });
    it("unsure when there's a period but no letter date", () => {
      expect(checkSettlementFigureNotExpired({ ...appStyleLetterExtraction(), dates: [] }, "2026-11-12", bankHolidays).status).toBe("unsure");
    });
    it("passes when a printed date and the period agree", () => {
      const extraction = { ...appStyleLetterExtraction(), dates: [...appStyleLetterExtraction().dates, fakeLetterDate("figure_valid_until", "16/11/2026", "2026-11-16")] };
      expect(checkSettlementFigureNotExpired(extraction, "2026-11-12", bankHolidays).status).toBe("pass");
    });
    it("unsure when a printed date and the period disagree", () => {
      const extraction = { ...appStyleLetterExtraction(), dates: [...appStyleLetterExtraction().dates, fakeLetterDate("figure_valid_until", "30/11/2026", "2026-11-30")] };
      expect(checkSettlementFigureNotExpired(extraction, "2026-11-12", bankHolidays).status).toBe("unsure");
    });
  });
});

describe("checkLoanStartDateMatchesCreditReport", () => {
  it("fails when the dates differ", () => {
    expect(checkLoanStartDateMatchesCreditReport(cleanLetterExtraction(), { ...cleanLoan(), startDate: "2022-01-01" })?.status).toBe("fail");
  });
  it("doesn't run when the letter has no start date", () => {
    const extraction = { ...cleanLetterExtraction(), dates: cleanLetterExtraction().dates.filter((letterDate) => letterDate.category !== "loan_start_date") };
    expect(checkLoanStartDateMatchesCreditReport(extraction, cleanLoan())).toBeNull();
  });
  it("doesn't run when the credit report has no start date", () => {
    expect(checkLoanStartDateMatchesCreditReport(cleanLetterExtraction(), { ...cleanLoan(), startDate: null })).toBeNull();
  });
});
