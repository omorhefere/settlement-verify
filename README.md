# settlement-verify

Verifying loan settlement letters with LLMs, where the worst mistake is accepting a wrong figure.

It verifies that the amount a customer entered matches the settlement figure on their settlement letter.

The design rule throughout: **the model reads, code decides.** A model extracts what's printed on the letter; deterministic code compares it with what the customer entered and decides.

## Results so far

**Dev set:** the original 15 synthetic test cases (5 letter styles, each clean plus near misses), run end to end with real models:

| Setup | Correct | Wrongly accepted | Escalated to strong model | Cost per test case |
|---|---|---|---|---|
| Haiku 5.5 alone | 15/15 | 0 | 0 | $0.00096 |
| Haiku → Sonnet 5.5 on any rejection | 15/15 | 0 | 11 | $0.01158 |
| Haiku → Sonnet 5.5 only when unsure | 15/15 | 0 | 1 | $0.00201 |

Haiku read every field of every letter correctly. Escalating every rejection cost 12× for no gain, because rejections were the customer's mistakes (wrong figure typed, expired letter), not misreads. So escalation should trigger on *uncertainty*, not on *rejection*.

Caveat: these letters are clean, computer-generated PDFs, so this is a ceiling.

**Test set:** the first real letter, a lender's settlement letter uploaded as a phone photo and labelled by hand before running. Three test cases (the right figure; the customer typed the letter's *other* amount; uploaded the day after expiry): **3/3 correct, 0 wrongly accepted**, every field read correctly from the photo, about $0.015 per test case with the Haiku → Sonnet flow. Both rejections were customer errors and were escalated anyway, the same pattern as above. It's one letter, so it's a real result but a small one.

## How it works

```
customer enters figure + agreement number
        │
        ▼
cheap model reads the PDF ──► code checks ──► all pass? ──► accept
        │ (anything unsure or failed)
        ▼
strong model reads the same PDF from scratch ──► code checks ──► all pass? ──► accept
        │
        ▼
back to the customer with a reason they can act on (5 tries, then the application ends)
```

- **The model never sees the customer's figure**, only the letter (a PDF or a photo), so it can't be nudged into agreeing.
- **Every amount and date is read twice.** The model copies the printed text (`"£3,987.20"`) and gives its own conversion (`398720` pence). Code parses the printed text itself and compares. If they disagree, the result is unsure, never a guess. This catches a dropped digit or a day/month swap.
- **Checks are pure functions** returning pass, fail or unsure with a reason: is it a settlement letter, known creditor, amount (exact), the letter is for this loan (account number, then creditor), and expiry (a printed date, or a period like "valid for three working days", counted with UK bank holidays).
- **Never allowed:** an automatic accept on an expired figure, an unknown creditor, or a document that isn't a settlement letter.
- **Model-agnostic:** extraction sits behind one function type, `(pdf) => Promise<LetterExtraction>`. Anthropic's API is the first adapter, with Bedrock next. Models are chosen on measured cost and accuracy.

The full design, including the decisions and why, is in [SPEC.md](SPEC.md).

## Testing at three levels

| Level | Question | How |
|---|---|---|
| The code alone | Given a perfect reading, does the code decide correctly? | Unit tests with a mock model that reads perfectly. Must be 100%: the code is deterministic. |
| The model alone | Did the model read the letter correctly? | Compare what it read with what's printed on the synthetic letter, field by field. |
| The system | Model and code together: is the decision right? | Run each test case through the real flow with real models; count letters wrongly accepted (target 0), wrongly rejected, escalations and cost. |

Each synthetic letter is generated from a *truth* (the correct answers), so every test case comes labelled. Near misses are one-field edits: the customer typed the balance instead of the settlement figure, swapped two digits, uploaded after expiry, or the letter is for a different account.

## Data and privacy

- No real letters, personal data or employer data are in this repo. All test letters are synthetic, with fictional creditors and people.
- Real letters (for the held-out test set) live in a gitignored folder. Eval results are gitignored too, because they hold what the model read.
- The prompt treats the document as data, not instructions, as a guard against prompt injection in uploaded files.

## Taking it to production

The core here (extraction, checks, flow, evals) is what a first pilot needs. Running it for real adds the following.

### Running it as a service
- **API in front of the verifier:** the app posts the PDF with the customer's figure and gets an outcome back. If model time grows, move to a **queue**: save the upload, enqueue a job, and let a worker run the verifier, so jobs survive restarts and concurrency is capped.
- **Retries with exponential backoff** on model calls, and a **timeout** on each call. A call that still fails is a service error ("try again later"), not one of the customer's attempts.
- **Idempotency:** each upload has an ID, and a retried request with the same ID returns the stored result instead of calling the models again. A retry never charges twice, uses up two of the customer's tries, or stores two answers.
- **Rate limits:** cap letters in flight to stay under the provider's request and token limits, and back off when told to.

### Audit trail and evidence
A lender needs to show why it trusted each figure, so every decision leaves a record of why. The verifier already returns most of it (each model reading and each check with its reason); an audit record adds:

```ts
type AuditRecord = {
  uploadId: string;
  decidedAt: string;             // ISO timestamp
  outcome: "accept" | "retry" | "ended" | "service_error";
  attemptNumber: number;
  models: { role: "cheap" | "strong"; modelId: string; promptVersion: string }[];
  readings: {
    role: "cheap" | "strong";
    extraction: MaskedLetterExtraction;   // e.g. "£3,9**.20", "HC-****-2290"
    checks: { check: CheckName; status: "pass" | "fail" | "unsure"; reason: string }[];
  }[];
  letterStorageKey: string;      // the PDF itself, deleted after 30 days
};
```

- **Built from the verification outcome** by one pure function, with masking applied by field (the schema marks which fields are personal data). The checks run on real values; only masked values are kept.
- **Append-only:** written once, never edited (an insert-only table or write-once object storage), so the record can be trusted in a dispute.
- **Used for:** evidence that a figure was checked, answering "why was my letter rejected?", reviewing model changes, and showing a regulator how an automated decision was made.

### Data protection
- **Masking** of personal data in stored records, logs and traces (above). Logging libraries can redact named fields (for example pino's `redact`); services such as AWS Comprehend or Microsoft Presidio detect personal data in free text.
- **Encrypted storage** for letters (for example S3 with encryption on), **access control** so only the verifier service reads letters by default, and every access logged.
- **Deletion:** letters removed automatically after 30 days by a storage lifecycle rule, and on request.
- **Model provider settings:** no training on submitted data, the shortest retention available, and UK/EU processing (on Bedrock, an EU region and EU inference profile).
- **A data protection impact assessment (DPIA)** before launch, since this sends personal financial documents to a third-party model.

### Doctored letters
An edited letter could inflate a figure to borrow more. Signals worth checking before trusting a letter: PDF metadata showing an editing tool, a creation date after the letter date, mismatched fonts or text layers around the figure, and image areas that differ from the rest of a scan. None is proof; each is a reason to look closer.

### Data and monitoring
- Hundreds of labelled letters across every supported creditor, run in **shadow mode** (decisions logged, not acted on) before switching on.
- Evals in CI on every prompt or model change; model versions pinned and rolled out gradually.
- Monitoring for new letter layouts and a rising unsure rate, plus a random audit of accepted letters, because a wrongly accepted letter is otherwise invisible until the debt still shows a balance after payoff.

## Dev set and test set

- **Dev set:** the 15 synthetic test cases in `letters/synthetic`. Run as often as needed, and tune against them.
- **Test set:** real settlement letters, labelled by hand in `letters/private/test` (gitignored). Run rarely, and never tune against them: if a real letter's failure leads to a code change, that letter moves to the dev set and the next real letter takes its place. Results are reported separately from the dev set.

### Adding a real letter to the test set

1. Put the letter (PDF or photo) in `letters/private/test/`, e.g. `letter-2.jpg`.
2. **Before running anything**, write the label files by hand, starting from [letters/TEMPLATE.json](letters/TEMPLATE.json):
   - `onLetter`: what's printed on the letter (settlement figure in pence, letter date, how long it's valid, the account number or `null`, the creditor's names). Fields not on the letter are `null`.
   - `application`, `loan`, `today`: the situation to test.
   - `expected`: accept, or reject and which checks should catch it.
3. Make several test cases from one letter by changing the situation, not the letter: the right figure (accept), a different figure (reject, `amount`), "today" after it expires (reject, `expiry`), a different loan (reject, `account`). Each is its own label file pointing at the same `letterFile`.
4. Add the letter's creditor to `letters/private/test/known-creditors.json` (see [letters/known-creditors.TEMPLATE.json](letters/known-creditors.TEMPLATE.json)).
5. Run: `pnpm eval haiku --dataset letters/private/test`. The output includes what the model read, which is personal data: don't paste it anywhere public.

## Running it

Needs Node 25+ and pnpm. Add `ANTHROPIC_API_KEY=...` to a `.env` file (gitignored).

```bash
pnpm install
pnpm test                 # unit tests (no API calls)
pnpm generate             # write the 15 synthetic test cases to letters/synthetic/
pnpm eval mock            # dry run of the eval with the mock model (free)
pnpm eval haiku           # one model
pnpm eval haiku:sonnet    # cheap model first, strong model when needed
pnpm eval haiku:sonnet --unsure-only
pnpm eval haiku --dataset letters/private/test   # the test set of real letters (run rarely)
pnpm extract path/to/letter.pdf [model-id]   # see what a model reads from one letter (PDF or photo)
```

## Project layout

```
src/
  extraction.ts        what the model returns (Zod schema)
  parse.ts             code's own reading of printed amounts, dates and periods; cross-checks
  checks.ts            the checks
  outcome.ts           one reading's check results → accept, unsure or fail
  verify.ts            the product flow: cheap model, strong model, back to the customer
  messages.ts          reasons the customer sees
  extractors/          model adapters (Anthropic), shared prompt
  synthetic/           synthetic letters: truths, test cases, PDF rendering, mock model
  evals/               eval runner, grading, reading accuracy, scorecard
test/                  unit tests
SPEC.md                the design
```

## Next

- Harder test letters: scan-like copies (rotated, blurred, noisy) and more creditor styles.
- A held-out test set of real settlement letters.
- The name check (applicant vs addressee), which closes the gap for letters with no account number.
- PII masking for stored evidence and logs; a second provider (Bedrock) for cost comparison.

Built with TypeScript, Zod, Vitest, the Anthropic SDK, Luxon, currency.js and PDFKit.
