import type { LetterExtraction } from "../extraction.ts";

// Every provider adapter has this shape (SPEC.md > Models and routing).
// It sees only the letter (a PDF or a photo), never the figure the customer entered.
// It throws if it can't return a valid LetterExtraction; the caller treats
// that as a service error ("try again later"), never as an accept.
export type LetterExtractor = (letterFile: Buffer) => Promise<LetterExtraction>;
