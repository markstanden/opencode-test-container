Fixed `src/csv.ts` so the parser strips a leading UTF-8 BOM (`U+FEFF`) before reading the header. Plain UTF-8 files are untouched because only the first character is checked.

Verification:
- `npm run import:fixture` → `2 orders`
- `npm test` → 2 passed, 0 failed

Also documented the behavior in the knowledge lake at `ops/csv-bom.md`. Only `src/csv.ts` and the knowledge lake were changed.
