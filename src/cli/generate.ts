// pnpm generate
//
// Writes the synthetic dev set to letters/synthetic/, once: one PDF per
// test case, plus a JSON file of the same name with its labels (what the
// customer entered, the loan, today's date, the expected outcome) and what's
// printed on the letter. `pnpm eval` reads these files. Re-run after changing
// the test cases or the layouts.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderLetterTruthAsPdf } from "../synthetic/render.ts";
import { TEST_CASES } from "../synthetic/test-cases.ts";

const OUTPUT_FOLDER = "letters/synthetic";

await mkdir(OUTPUT_FOLDER, { recursive: true });
for (const testCase of TEST_CASES) {
  const pdf = await renderLetterTruthAsPdf(testCase.truth, testCase.description);
  await writeFile(join(OUTPUT_FOLDER, `${testCase.id}.pdf`), pdf);
  await writeFile(join(OUTPUT_FOLDER, `${testCase.id}.json`), JSON.stringify(testCase, null, 2) + "\n");
  const expectedOutcomeLabel = testCase.expected.accept ? "accept" : "reject";
  console.log(`${expectedOutcomeLabel}  ${testCase.id.padEnd(24)} ${testCase.description}`);
}
console.log(`\n${TEST_CASES.length} test cases written to ${OUTPUT_FOLDER}/`);
