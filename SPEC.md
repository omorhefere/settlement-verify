# Settlement letter verification: spec v0.12

## Goal

Verify that the settlement figure a customer entered matches the settlement figure on their settlement letter.

**Worst error:** automatically accepting a wrong figure (*wrongly accepted*). **Target: zero.**

## Terms

- **Creditor:** the company owed the debt. It sends the settlement letter.
- **Settlement figure:** the exact amount needed to close the debt, valid until a date or for a period.
- **Customer:** enters the settlement figure and the loan agreement number, and uploads the letter.

## Design choices

- **The model reads, code decides.** A model extracts what's printed on the letter; deterministic code compares it with what the customer entered and makes every decision.
- **The letter proves the figure the customer entered; it doesn't replace it.** Two independent sources (the customer and the letter) have to agree, so a misread or a typo is caught.
- **The model never sees the customer's figure,** only the PDF, so it can't be nudged into agreeing.

## Flow

1. The customer enters a settlement figure and the loan agreement number.
2. The customer uploads the settlement letter: a PDF or a photo (JPEG, PNG, GIF or WebP, up to 5 MB). The file type is detected from its contents, not its name; anything else (e.g. iPhone HEIC) is refused with a message saying what to upload.
3. A cheap model reads the letter and returns structured fields.
4. Code picks the settlement figure and runs the checks.
5. Accept, or send back to the customer with a reason so they can retry (see [Outcomes](#outcomes)).

## Never allowed (enforced in code)

No automatic accept on:
- an expired figure,
- an unknown creditor,
- a document that isn't a settlement letter,
- a name mismatch (once the name check exists; deferred, see [Checks](#checks)).

## Extraction

The model returns:
- Whether the document is a settlement letter (yes, no or unsure).
- Every amount on the letter, with its label as printed, its source text, and a category (settlement figure, balance, arrears, fee, other). Code picks the settlement figure.
- The creditor's name.
- Every account, agreement or reference number.
- Every date (letter date, valid-until date, loan start date, other).
- How long the figure is valid, when the letter gives a period instead of a date: e.g. "valid for three working days", or "valid until your next payment due date".

Rules:
- **A field that isn't on the letter comes back as not found, never guessed.**
- **Amounts, dates and validity periods are read twice.** The model returns each as printed (`"£3,987.20"`, `"03/04/2026"`, `"three working days"`) and its own conversion (integer pence, ISO date, count and unit). Code parses the printed text itself (UK day-first dates) and compares. They agree → use the value. They disagree, or the printed text won't parse → unsure.
- **Collect only what a check uses.** Not collected: address (too many formats to match reliably). Addressee names are deferred with the name check.

Real letters vary by creditor. The first real letter tested (a short app-generated note) had no account number, no balance, and a validity period instead of an expiry date.

## Checks

Each check returns pass, fail or unsure, plus a reason.

| Check | Compares | Notes |
|---|---|---|
| Settlement letter | The model's yes, no or unsure | No → fail; unsure → unsure |
| Known creditor | The letter's creditor vs a configured list of known creditors and their aliases | Unknown → never auto-accept |
| Amount | The entered figure vs the letter's settlement figure, exact to the penny | Exactly one settlement figure → use it (the same figure printed twice counts once); none or several different → unsure |
| Account (the letter is for this loan) | In order: **1. number:** the letter shows the loan's number and the number the customer entered → pass; it shows a different account number → fail. **2. creditor**, only if the letter shows no account number: the letter's creditor and the loan's creditor are the same known creditor (via aliases) → pass; different → fail. **3. name**, last, because names vary the most (deferred) | Only the one loan being settled is compared. Known gap until the name step exists: with no number on the letter, another customer's letter from the same creditor would pass |
| Expiry | The expiry vs today | The printed valid-until date, or the letter date plus the validity period. Working days skip weekends and England and Wales bank holidays. The letter date is day 0: a letter dated Wed 11 Nov valid for three working days is valid until Mon 16 Nov. "Until your next payment due date" counts only on the letter date itself. A date and a period that disagree → unsure. Expired → fail; none found → unsure |
| Loan start date (optional) | The letter vs the loan's start date on the credit report | Extra evidence; doesn't run if either date is missing or unreadable |
| Name (deferred) | The applicant vs the letter's addressee, fuzzy, rule-based | Handle initials, titles, joint names, changed surnames and OCR typos. Will be the last step of the account check |

The settlement figure is never compared with a credit report balance: they're different things (a settlement figure includes interest, charges and rebates a balance doesn't).

## Outcomes

- Cheap model's reading passes every check → **accept**.
- Anything else (unsure or fail) → the strong model reads the letter again, from scratch, and the checks run on its reading alone.
- Strong model's reading passes every check → **accept**.
- Otherwise → **back to the customer** with the strong model's reasons, phrased so they can act on them: "that's the balance, not the settlement figure", "please upload a clearer copy", "this letter has expired".
- No human review. The customer can retry up to 5 times; after 5 attempts without an accept, the application ends.
- Model calls are a service like any other: timeouts and errors get normal handling (retry, then "try again later") and don't use up one of the customer's attempts.

**Known risk:** a second reading is a second chance for a misread that happens to match the customer's typo (e.g. both swap the same two digits). Measured by the evals on swapped-digit near misses.

**Open decision: when to ask the strong model.** First results (below) show that escalating every rejection mostly re-checks the customer's own mistakes. The alternative is to escalate only when the cheap reading is *unsure*, which is cheaper and removes the known risk. Decide after testing harder letters.

## Models and routing

- **Model-agnostic.** Extraction sits behind one function type, `(letterPdf) => Promise<LetterExtraction>`; each provider is an adapter. Anthropic API first, then Bedrock; others only if needed.
- The model for each tier (cheap, strong) is configuration, not code. Pin model versions.
- Choose models on measured cost and accuracy from the evals, not on provider.

## Data handling (personal data)

- Extract only fields a check uses.
- Run checks on the real values; store the outcome and masked fields only. Masking is by field: the schema says which fields are personal data.
- Mask personal data in logs and traces; turn off or lock down provider-side logging of prompts and responses.
- Provider settings: UK/EU processing, no training on submitted data, shortest retention available.
- Delete letters after 30 days, and on request. Limit who can see letters.

## Metrics

- **Wrongly accepted:** the system accepted, but the figure was wrong. Target 0.
- **Wrongly rejected:** the system rejected a correct figure.
- **Escalated:** how often the strong model was needed (drives cost).
- **Cost and time per test case.**
- **Reading accuracy:** per field, per model.

### Three levels of testing

1. **The model alone** (extraction evals): run each synthetic letter through the model and compare what it read with what's printed on the letter, field by field (is it a settlement letter, settlement figure, letter date, expiry, account number, creditor).
2. **The code alone** (unit tests): run the checks on a perfect reading of each test case (a mock model) and compare the decision with the expected result. Must be 100%: the code is deterministic.
3. **The system** (end-to-end evals): run each test case through the real flow with real models and compare the decision with the expected result.

In production, also track: drop-out at the upload step, the share of uploads accepted first time, and payments that didn't close the debt (a balance left, or a refund needed).

## Results so far

### Dev set (synthetic)

The dev set now has 18 test cases: a table-style statement (a second amount, "total amount payable under the agreement", printed next to the settlement figure) was added after the first test-set run, using that letter's layout with a fictional creditor and figures.

The original 15 synthetic test cases (5 letter styles, each clean plus near misses):

| Setup | Correct | Wrongly accepted | Escalated | Cost per test case |
|---|---|---|---|---|
| Haiku 5.5 alone | 15/15 | 0 | 0 | $0.00096 |
| Haiku → Sonnet 5.5 on any non-accept | 15/15 | 0 | 11 | $0.01158 |
| Haiku → Sonnet 5.5 only when unsure | 15/15 | 0 | 1 | $0.00201 |

Haiku read every field of every letter correctly. The letters are clean, computer-generated PDFs, so this is a ceiling, not a real-world result.

### Test set (real letters)

First run, 22 Nov 2026: one real lender's settlement letter, uploaded as a phone photo, labelled by hand before running, three test cases (the right figure; the customer entered the letter's other amount, "total amount payable under the agreement"; uploaded the day after expiry).

| Setup | Correct | Wrongly accepted | Escalated | Cost per test case |
|---|---|---|---|---|
| Haiku → Sonnet 5.5 on any non-accept | 3/3 | 0 | 2 | $0.0147 |

Both models read every field correctly from the photo. Both rejections were customer errors and were still escalated, the same pattern as the dev set. One letter is a small sample: report it as 3/3 on one real letter, not as a rate. After this run the letter's layout was used as a template for synthetic letters, so it now counts as dev data; the next real letter is the test set.

## Data

Each source has one job:
- **Synthetic UK letters (dev set):** 18 test cases across 6 letter styles plus a non-letter, to build and tune. Each is generated from a truth (the correct answers), so it comes labelled. Near misses are one-field edits: the balance entered instead of the settlement figure, swapped digits, expired, a different account or creditor, not a settlement letter.
- **The author's own settlement letters (test set):** a small hand-labelled real set, held back to check results on real layouts. Gitignored, never committed.
- **Planned:** scan-like copies of the synthetic letters (rotated, blurred, noisy), more creditor styles, and SEC EDGAR payoff letters (US, corporate) as an out-of-distribution test, where the pass condition is that none is accepted.
- In production, shadow mode (decisions logged, not acted on) and payment results (did the debt close?) would become the main sources of labelled data.

No third-party customer letters or data: only synthetic letters, the author's own letters and public samples.

## Not in scope (v1)

Paying creditors; integrating with a loan or payments system; deciding when to ask for a letter; fraud detection beyond the never-allowed rules (doctored PDFs are discussed in the README).
