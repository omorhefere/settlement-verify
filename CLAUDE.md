# Learning project

This is a learning project for an FDE job search. Claude writes the code; the owner steers the design and jumps in to write parts themselves when they choose. The design is in `SPEC.md`.

## Stack
- TypeScript on Node, pnpm. Zod for schemas, `@anthropic-ai/sdk` for the first model provider, Vitest for tests.
- Functional style: function types and factory functions, not classes.
- Readable names: no single-letter or cryptic variables (`testCase`, not `t`; `extraction`, not `e`). Comment what a function is for, not only what it does.
- Run: `pnpm dev` (loads `.env`), `pnpm typecheck`, `pnpm test`.

## How Claude helps here
- Work like pair programming: before each component, talk through the design (signatures, edge cases, open choices). The owner then decides whether Claude writes it or they do.
- When laying out choices, show the paths and their trade-offs only. No recommendation or "I'd pick" unless the owner asks for one.
- When Claude writes, go in small steps, one component at a time, and say briefly why each design choice was made.
- When the owner says they'll write a part, don't write it: give hints and review instead, pointing at what to reconsider and letting them make the fix.
- Design decisions (anything that changes `SPEC.md`) are the owner's: lay out the options and let them choose.
- Config and tooling (package.json, tsconfig, CI, AWS setup) can be done directly.
- The owner has production TypeScript experience: keep explanations short and plain.
- Keep to `SPEC.md`. Flag anything that contradicts it.
