import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadKnownCreditorsFromFolder, loadLabelledTestCasesFromFolder } from "../src/evals/dataset.ts";

// A real-letter test case label, as someone would write it by hand.
const realLetterLabel = (id: string, overrides: object = {}) => ({
  id,
  description: "Real letter, right figure entered",
  letterFile: "letter-2.jpg",
  application: { enteredPence: 250000, loanAgreementNumber: "AB123" },
  loan: { creditor: "EXAMPLE BANK PLC", accountNumber: "AB123", startDate: null },
  today: "2026-11-22",
  expected: { accept: true, notPassing: [] },
  onLetter: {
    isSettlementLetter: true,
    settlementPence: 250000,
    letterDate: "2026-11-20",
    validity: { kind: "date", date: "2026-12-04" },
    accountNumber: "AB123",
    creditorNames: ["Example Bank"],
  },
  ...overrides,
});

describe("loading a folder of real letters", () => {
  let datasetFolder: string;
  beforeEach(async () => {
    datasetFolder = await mkdtemp(join(tmpdir(), "settlement-verify-dataset-"));
    await writeFile(join(datasetFolder, "letter-2.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  });
  afterEach(() => rm(datasetFolder, { recursive: true, force: true }));

  it("lets several test cases share one photo, and reads the hand-written facts", async () => {
    await writeFile(join(datasetFolder, "letter-2-clean.json"), JSON.stringify(realLetterLabel("letter-2-clean")));
    await writeFile(
      join(datasetFolder, "letter-2-expired.json"),
      JSON.stringify(realLetterLabel("letter-2-expired", { today: "2026-12-05", expected: { accept: false, notPassing: ["expiry"] } })),
    );
    const testCases = await loadLabelledTestCasesFromFolder(datasetFolder);
    expect(testCases.map((testCase) => testCase.id)).toEqual(["letter-2-clean", "letter-2-expired"]);
    expect(testCases[0]!.letterFile.equals(testCases[1]!.letterFile)).toBe(true);
    expect(testCases[0]!.letterFacts).toMatchObject({ settlementPence: 250000, creditorNames: ["Example Bank"] });
  });

  it("reads known-creditors.json, and doesn't treat it as a test case", async () => {
    await writeFile(join(datasetFolder, "letter-2-clean.json"), JSON.stringify(realLetterLabel("letter-2-clean")));
    await writeFile(join(datasetFolder, "known-creditors.json"), JSON.stringify([{ name: "Example Bank", aliases: ["Example Bank plc"] }]));
    expect(await loadKnownCreditorsFromFolder(datasetFolder)).toEqual([{ name: "Example Bank", aliases: ["Example Bank plc"] }]);
    expect(await loadLabelledTestCasesFromFolder(datasetFolder)).toHaveLength(1);
  });

  it("names the label file when a hand-written label has a mistake", async () => {
    await writeFile(join(datasetFolder, "letter-2-clean.json"), JSON.stringify(realLetterLabel("letter-2-clean", { today: "22/11/2026" })));
    await expect(loadLabelledTestCasesFromFolder(datasetFolder)).rejects.toThrow(/letter-2-clean\.json/);
  });

  it("names the missing letter file", async () => {
    await writeFile(join(datasetFolder, "letter-3-clean.json"), JSON.stringify(realLetterLabel("letter-3-clean", { letterFile: "letter-3.jpg" })));
    await expect(loadLabelledTestCasesFromFolder(datasetFolder)).rejects.toThrow(/letter-3\.jpg/);
  });
});
