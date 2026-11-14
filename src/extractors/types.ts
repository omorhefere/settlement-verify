import type { LetterExtraction } from "../extraction.ts";

// Every provider adapter has this shape (SPEC.md > Models and routing).
// It sees only the letter, never the figure the customer entered.
// It throws if it can't return a valid LetterExtraction; the caller treats
// that as "send to a human", never as an accept.
export type LetterExtractor = (letterPdf: Buffer) => Promise<LetterExtraction>;
