import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { LetterTruth } from "../synthetic/types.ts";
import type { Application, CheckName, Loan } from "../types.ts";

// Loading a dataset from disk: a folder of test cases, each a letter PDF with a JSON
// file of the same name holding its labels. `pnpm generate` writes the
// synthetic set this way; hand-labelled real letters can use the same format.
// Reading from disk (rather than drawing the PDFs each run) means every run
// scores exactly the same files.

const CHECK_NAMES = ["settlement_letter", "known_creditor", "amount", "account", "expiry", "loan_start_date"] as const;

// The label file. Checked with Zod because real letters are labelled by hand,
// and a typo in a label would otherwise show up as a confusing score.
const LabelFile = z.object({
  id: z.string(),
  description: z.string(),
  application: z.object({ enteredPence: z.number().int(), loanAgreementNumber: z.string() }),
  loan: z.object({ creditor: z.string(), accountNumber: z.string(), startDate: z.string().nullable() }),
  today: z.string(),
  expected: z.object({ accept: z.boolean(), notPassing: z.array(z.enum(CHECK_NAMES)) }),
  // Synthetic letters only: what's printed on the letter, used by the mock model.
  truth: z.unknown().optional(),
});

// One test case from a dataset: its labels (customer input, loan, date, expected
// result) and the letter PDF.
export type LabelledTestCase = {
  id: string;
  description: string;
  application: Application;
  loan: Loan;
  today: string;
  expected: { accept: boolean; notPassing: CheckName[] };
  truth?: LetterTruth;
  pdf: Buffer;
};

// Reads every test case in a dataset folder: each <id>.json label file and its
// <id>.pdf. Returns the test cases sorted by file name. Throws on a bad label.
export const loadLabelledTestCasesFromFolder = async (datasetFolder: string): Promise<LabelledTestCase[]> => {
  const labelFiles = (await readdir(datasetFolder)).filter((fileName) => fileName.endsWith(".json")).sort();
  return Promise.all(
    labelFiles.map(async (labelFile) => {
      const testCaseLabels = LabelFile.parse(JSON.parse(await readFile(join(datasetFolder, labelFile), "utf8")));
      const pdf = await readFile(join(datasetFolder, labelFile.replace(/\.json$/, ".pdf")));
      const { truth, ...labelsWithoutTruth } = testCaseLabels;
      return truth === undefined ? { ...labelsWithoutTruth, pdf } : { ...labelsWithoutTruth, truth: truth as LetterTruth, pdf };
    }),
  );
};
