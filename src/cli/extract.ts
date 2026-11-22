// pnpm extract <letter file> [model]   (a PDF or a photo: JPEG, PNG, GIF, WebP)
//
// Sends one letter to a model and prints what it read, next to code's own
// reading of each printed amount and date. For trying real letters by hand.
// The output holds the letter's PII: run it in your own terminal and don't
// paste it anywhere you wouldn't paste the letter.

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { formatPenceAsPounds } from "../checks.ts";
import { makeAnthropicExtractor, type TokenUsage } from "../extractors/anthropic.ts";
import { checkLetterFile } from "../extractors/letter-file.ts";
import {
  crossCheckAmountWithModelReading,
  crossCheckDateWithModelReading,
  crossCheckValidityPeriodWithModelReading,
  type CrossCheckedReading,
} from "../parse.ts";
import { costUsdOfTokenUsage } from "../pricing.ts";

const [letterPath, modelId = "claude-haiku-5-5"] = process.argv.slice(2);
if (!letterPath) {
  console.error("Usage: pnpm extract <letter file: PDF, JPEG, PNG, GIF or WebP> [model]");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY isn't set. Add it to .env (pnpm extract loads it).");
  process.exit(1);
}

// One cross-checked reading as a line of output: ✓ and the agreed value, or ? and
// what code and the model each read.
const describeCrossCheckedReading = <T>(crossCheckedReading: CrossCheckedReading<T>, formatValue: (value: T) => string): string =>
  crossCheckedReading.status === "ok"
    ? `✓ ${formatValue(crossCheckedReading.value)}`
    : `? ${crossCheckedReading.reason} (code: ${crossCheckedReading.parsed === null ? "unreadable" : formatValue(crossCheckedReading.parsed)}, model: ${crossCheckedReading.model === null ? "none" : formatValue(crossCheckedReading.model)})`;

let tokenUsage: TokenUsage | undefined;
const extractLetter = makeAnthropicExtractor({
  client: new Anthropic(),
  model: modelId,
  onUsage: (callUsage) => (tokenUsage = callUsage),
});

const letterFile = await readFile(letterPath);
const fileCheck = checkLetterFile(letterFile);
if (!fileCheck.isSupported) {
  console.error(fileCheck.reason);
  process.exit(1);
}
console.log(`Reading ${fileCheck.mediaType} with ${modelId}…`);

const startedAt = Date.now();
const extraction = await extractLetter(letterFile);
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log(`\nSettlement letter? ${extraction.is_settlement_letter}`);
console.log(`Creditor: ${extraction.creditor?.value ?? "(not found)"}`);

console.log(`\nAmounts (${extraction.amounts.length})`);
for (const amount of extraction.amounts) {
  console.log(
    `  [${amount.category}] ${amount.label ?? "(no label)"}: "${amount.printed}" → ${describeCrossCheckedReading(crossCheckAmountWithModelReading(amount), formatPenceAsPounds)}`,
  );
}

console.log(`\nDates (${extraction.dates.length})`);
for (const letterDate of extraction.dates) {
  console.log(
    `  [${letterDate.category}] ${letterDate.label ?? "(no label)"}: "${letterDate.printed}" → ${describeCrossCheckedReading(crossCheckDateWithModelReading(letterDate), (isoDate) => isoDate)}`,
  );
}

const validityPeriod = extraction.validity_period;
console.log(
  `\nValidity period: ${validityPeriod === null ? "(none)" : `"${validityPeriod.printed}" → ${describeCrossCheckedReading(crossCheckValidityPeriodWithModelReading(validityPeriod), (period) => `${period.count} ${period.unit}`)}`}`,
);

console.log(`\nNumbers (${extraction.identifier_numbers.length})`);
for (const identifierNumber of extraction.identifier_numbers) {
  console.log(`  [${identifierNumber.category}] ${identifierNumber.label ?? "(no label)"}: ${identifierNumber.value}`);
}

if (tokenUsage) {
  const costUsd = costUsdOfTokenUsage(tokenUsage);
  console.log(
    `\n${tokenUsage.model}: ${tokenUsage.inputTokens} in, ${tokenUsage.outputTokens} out, ${seconds}s` +
      (costUsd === undefined ? "" : `, about $${costUsd.toFixed(4)}`),
  );
}
