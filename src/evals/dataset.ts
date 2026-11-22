import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { KnownCreditor } from "../checks.ts";
import type { LetterTruth } from "../synthetic/types.ts";
import type { Application, CheckName, Loan } from "../types.ts";
import { letterFactsFromTruth, type LetterFacts } from "./reading-accuracy.ts";

// Loading a dataset from disk: a folder of test cases, each a JSON label file
// plus the letter it's about (a PDF or a photo). Reading from disk means every
// run scores exactly the same files.
//
// - Synthetic set (letters/synthetic, written by `pnpm generate`): each
//   <id>.json comes with its own <id>.pdf, and a `truth` the PDF was drawn from.
// - Real letters (e.g. letters/private/test, labelled by hand): several test
//   cases can share one letter, naming it in `letterFile`, with the letter's
//   facts written by hand in `onLetter`. See letters/TEMPLATE.json.
// - A folder can also hold known-creditors.json: the creditors (and aliases)
//   the checks should accept for that dataset.

const CHECK_NAMES = ["settlement_letter", "known_creditor", "amount", "account", "expiry", "loan_start_date"] as const;
const KNOWN_CREDITORS_FILE = "known-creditors.json";
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");

// What's printed on a real letter, written by hand: the answers its reading is
// scored against. Matches LetterFacts.
const OnLetterLabels = z.object({
  isSettlementLetter: z.boolean(),
  settlementPence: z.number().int().nullable(),
  letterDate: isoDate.nullable(),
  validity: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("date"), date: isoDate }),
      z.object({ kind: z.literal("period"), count: z.number().int().positive(), unit: z.enum(["calendar_days", "working_days"]) }),
      z.object({ kind: z.literal("next_payment") }),
    ])
    .nullable(),
  accountNumber: z.string().nullable(),
  creditorNames: z.array(z.string()).min(1),
});

// The label file. Checked with Zod because real letters are labelled by hand,
// and a typo in a label would otherwise show up as a confusing score.
const LabelFile = z.object({
  id: z.string(),
  description: z.string(),
  letterFile: z.string().optional(), // the letter in this folder; defaults to <label name>.pdf
  application: z.object({ enteredPence: z.number().int(), loanAgreementNumber: z.string() }),
  loan: z.object({ creditor: z.string(), accountNumber: z.string(), startDate: isoDate.nullable() }),
  today: isoDate,
  expected: z.object({ accept: z.boolean(), notPassing: z.array(z.enum(CHECK_NAMES)) }),
  onLetter: OnLetterLabels.optional(), // real letters: what's printed, by hand
  truth: z.unknown().optional(), // synthetic letters: what the PDF was drawn from
});

// One test case from a dataset: its labels, the letter's facts (when known)
// and the letter file itself.
export type LabelledTestCase = {
  id: string;
  description: string;
  application: Application;
  loan: Loan;
  today: string;
  expected: { accept: boolean; notPassing: CheckName[] };
  letterFacts?: LetterFacts; // for scoring the model's reading
  truth?: LetterTruth; // synthetic only: lets the mock model read the letter
  letterFile: Buffer;
};

const KnownCreditorsFile = z.array(z.object({ name: z.string(), aliases: z.array(z.string()) }));

// The dataset's own known creditors, or undefined if the folder has none.
export const loadKnownCreditorsFromFolder = async (datasetFolder: string): Promise<KnownCreditor[] | undefined> => {
  const fileNames = await readdir(datasetFolder);
  if (!fileNames.includes(KNOWN_CREDITORS_FILE)) return undefined;
  return KnownCreditorsFile.parse(JSON.parse(await readFile(join(datasetFolder, KNOWN_CREDITORS_FILE), "utf8")));
};

// Reads every test case in a dataset folder. Returns them sorted by label file
// name. Throws on a bad label or a missing letter file, naming the label file.
export const loadLabelledTestCasesFromFolder = async (datasetFolder: string): Promise<LabelledTestCase[]> => {
  const labelFiles = (await readdir(datasetFolder))
    .filter((fileName) => fileName.endsWith(".json") && fileName !== KNOWN_CREDITORS_FILE)
    .sort();
  return Promise.all(
    labelFiles.map(async (labelFile) => {
      const parsed = LabelFile.safeParse(JSON.parse(await readFile(join(datasetFolder, labelFile), "utf8")));
      if (!parsed.success) throw new Error(`${labelFile}: ${z.prettifyError(parsed.error)}`);
      const { truth, onLetter, letterFile: letterFileName, ...labels } = parsed.data;

      const letterFile = await readFile(join(datasetFolder, letterFileName ?? labelFile.replace(/\.json$/, ".pdf"))).catch(() => {
        throw new Error(`${labelFile}: can't find the letter file "${letterFileName ?? labelFile.replace(/\.json$/, ".pdf")}"`);
      });
      const syntheticTruth = truth as LetterTruth | undefined;
      const letterFacts = onLetter ?? (syntheticTruth ? letterFactsFromTruth(syntheticTruth) : undefined);

      return {
        ...labels,
        letterFile,
        ...(letterFacts ? { letterFacts } : {}),
        ...(syntheticTruth ? { truth: syntheticTruth } : {}),
      };
    }),
  );
};
