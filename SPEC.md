Settlement letter verification: spec v0.10
Goal
The amount paid to the creditor closes the debt exactly, and the lender doesn't lend on false data.

Worst error: automatically accepting a wrong figure (wrongly accepted). Target: zero.

Capability
Verify customer-entered settlement figures against the creditor's settlement letter, so the amount paid matches the amount needed to close the debt.

Terms
Creditor: the existing debt being paid off; sends the settlement letter.
Lender: provides the new debt-consolidation loan and pays off the existing debts.

Assumed setting
A hypothetical debt-consolidation lender. When a customer consolidates, the lender pays each existing creditor the settlement figure. The customer enters each figure. Assume the lender can already estimate settlement figures from credit report data, so figures close to the estimate need no further proof. This project covers the remaining case: the customer's figure differs from the estimate and there is no way to prove it.

Baseline
Share of consolidated accounts that still show a balance, or needed a refund, after payoff. Measured from credit report data after payoff. (A learning project: this describes how it would be measured, not a measured number.)

Design choices
The letter proves the figure the customer entered; it doesn't replace it. Two independent sources (the customer and the letter) have to agree, so a misread or a typo is caught.
The letter is offered as the fast route for a figure that differs from the estimate, not as an extra hurdle for everyone.

Flow
Customer enters a settlement figure and the loan agreement number.
If the figure differs from the estimate, the customer is asked for their settlement letter (when to ask is out of scope).
The customer uploads the letter.
A cheap model reads the letter without seeing the entered figure and returns structured fields.
Code picks the settlement figure and runs the checks.
Accept, or send back to the customer with a reason so they can retry (see Outcomes).
Never allowed (enforced in code)
Automatic accept on a name mismatch (once the name check exists; deferred, see Checks).
Automatic accept on an expired figure.
Automatic accept on an unknown creditor.
Automatic accept on a document that isn't a settlement letter.

Extraction
The model reads; code decides. The model returns:

Whether the document is a settlement letter (yes, no or unsure).
Every amount on the letter, with its label as printed, its source text, and a category from a fixed list (settlement, balance, arrears, fee, other). Code picks the settlement figure.
Addressee names as printed (not split into first and last name). Deferred with the name check: not extracted until it exists.
Creditor name and account or loan agreement number.
Letter date and the date the figure expires.
How long the figure is valid, when the letter gives a period instead of a date (e.g. "valid for three working days"): the period as printed, plus the model's reading of it (a count, and calendar or working days).
Optional: loan start date.
Not collected: address (too many formats to match reliably; collect only what a check needs).
A field that isn't on the letter comes back as not found, never guessed.
Amounts, dates and validity periods are read twice. The model returns each value as printed (e.g. "£3,987.20", "03/04/2026", "three working days") and its own conversion (integer pence; ISO date; count and unit). Code parses the printed text itself (UK DD/MM for dates) and compares. They agree → use the value. They disagree, or the printed text won't parse → unsure.
Real letters vary by creditor: the first real letter tested (a short app-generated note) had no account number, no balance and a validity period instead of an expiry date.

Checks
Check	Comparison	Notes
Settlement letter	Model's yes, no or unsure	No → back to the customer; unsure → stronger model
Amount	Entered figure vs letter, exact	Exactly one settlement amount → use it; none or several → unsure
Account (letter is for this loan)	In order: 1. number: the letter shows the loan's number and the number the customer entered → pass; it shows a different account number → fail. 2. creditor, only if the letter shows no account number: the letter's creditor and the loan's creditor map to the same known creditor (via aliases) → pass; different creditors → fail. 3. name, last, because names vary the most (deferred: until it exists, cases that need it are unsure)	Only the one loan being settled is compared, never the whole report. Known gap until the name step exists: with no number on the letter, another customer's letter from the same creditor would pass this check
Name (deferred)	Applicant vs letter addressees, fuzzy, rule-based	Normalise; handle initials, titles, joint names, changed surnames, OCR typos; return a reason. Will be the last step of the account check
Known creditor	Letter creditor vs a configured list of known creditors and their aliases (kept in config, not taken from the credit report)	Unknown → never auto-accept
Expiry	Expiry date vs today	The expiry is the printed valid-until date, or the letter date plus the validity period. Working days skip weekends and England and Wales bank holidays (gov.uk list, in config). The letter date is day 0: a letter dated Wed 11 Nov valid for three working days is valid until Mon 16 Nov. "Valid until your next payment due date" (no date printed): the figure counts only on the letter date itself; the upload screen tells customers to upload on the day the letter arrives. A date and a period that give different expiries → unsure. Expired → fail; no expiry found → unsure. Checked against today (the system is near instant, so payment follows within the window)
Loan start date (optional)	Letter vs credit report	Extra evidence that the letter matches the accountEach check returns pass, fail or unsure, plus a reason.

Outcomes
The models only read; code decides every outcome.
Cheap model reads, checks all pass → accept automatically.
Anything else (unsure or fail) → the stronger model reads the letter again from scratch and the checks run on its reading.
Stronger model's reading passes all checks → accept.
Known risk: a second reading is a second chance for a misread that happens to match the customer's typo (e.g. both swap the same two digits). Measured by the evals on swapped-digit near misses. If any letter is wrongly accepted, tighten the rule: the stronger model re-reads only when the first result was unsure, not a clear fail.
Otherwise → back to the customer with the stronger model's reasons, phrased so they can act on them (e.g. "that's the balance, not the settlement figure", "we couldn't read your letter, please upload a clearer copy", "this letter has expired").
No human review. The customer can retry up to 5 times. After 5 attempts without an accept, the application ends.
Model calls are a service like any other: timeouts and errors are handled as normal service errors (retry, then a "try again later" message). They don't count as one of the customer's attempts.
The settlement figure is never compared with the credit report balance: they are different things (a settlement figure includes interest, charges and rebates the balance doesn't).
Models and routing
Model-agnostic. Extraction sits behind a LetterExtractor interface; each provider is an adapter that returns the same LetterExtraction. Anthropic API first (development), then Bedrock; others (Google Vertex, Microsoft Foundry) only if needed. Provider and model for each tier (cheap, strong) are configuration, not code.
Pin model versions.
Choose models on measured cost and accuracy from the evals, not on provider.

Data handling (PII)
Extract only fields that a check uses.
Run checks on the real values, then store the outcome and masked fields only. Masking is by field, in code: the schema says which fields are PII.
Mask PII in application logs and traces, and turn off or lock down provider-side logging of prompts and responses.
Provider settings: EU processing only, no training on submitted data, shortest retention available.
Delete letters after 30 days. Limit who can see letters.

Metrics
Evals, measured on letters with a known correct answer: wrongly accepted rate (target 0, including on the out-of-distribution set), wrongly rejected rate, share needing a retry, share stopped after 5 attempts, cost per letter, all by provider and model.
Wrongly accepted: the system accepted, but the figure was wrong. Wrongly rejected: the system rejected a correct figure.
Three levels of testing:
1. The model alone (extraction evals): run each synthetic letter through the model and compare what it read with what is printed on the letter, field by field (settlement figure, letter date, expiry, account number, creditor, is it a settlement letter). Gives reading accuracy per field, per model.
2. The code alone (unit tests): run the checks on a perfect reading of each test case (a mock model) and compare the decision with the expected result. Must be 100%: the code is deterministic.
3. The system (end-to-end evals): run each test case through the real flow with real models and compare the decision with the expected result. Gives wrongly accepted (target 0), wrongly rejected, share escalated to the strong model, and cost per test case.
Product: drop-out at the upload step; share of uploads accepted first time.
Business: payoff error rate (accounts with a balance left, or refunded, after payoff).
Data
Each source has one job.
Synthetic UK letters, to build and test. Each is generated from a truth object (the correct answers), so it comes labelled. Near misses are edits to the truth object: balance entered instead of the settlement figure, swapped digits, expired, wrong name, not a settlement letter.
The owner's own settlement letters: a small hand-labelled real set, to check extraction on real layouts. They hold real PII: gitignored, never committed, masked in logs.
SEC EDGAR payoff letters (US, corporate, per-diem): an out-of-distribution test. The system isn't built for them, so the pass condition is that none is auto-accepted.
In production, shadow mode (run alongside the existing manual process, decisions logged but not acted on) and payoff results (did the debt close?) would become the main sources of labelled data.
No third-party customer letters or data: only synthetic letters, the author's own letters and public samples.
Not in scope (v1)
Paying creditors; integrating with a real loan system; deciding when to ask for a letter, and how the estimate is made (both assumed upstream); fraud detection beyond the never-allowed rules.
