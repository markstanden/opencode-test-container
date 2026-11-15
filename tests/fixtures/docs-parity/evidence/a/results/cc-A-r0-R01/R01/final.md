I'll start by exploring the repo to understand the importer and the failing test.
The file starts with a UTF-8 BOM (`EF BB BF`), and `parseCsv` compares the first header cell raw, so `"\uFEFFid"` fails. I'll strip a single leading BOM only, leaving all other content untouched.
Both pass. Now let me record this in the knowledge lake, matching existing docs.
Done.

**Fix** — `src/csv.ts`: `parseCsv` now strips a single leading UTF-8 BOM (`\uFEFF`) before line-splitting and header validation. It only acts when the text actually starts with a BOM, so plain UTF-8 input is untouched, and any `\uFEFF` later in the file is preserved.

```ts
const content = text.startsWith("\uFEFF") ? text.slice(1) : text;
const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
```

**Verification**
- `npm test` → 2 passed, 0 failed (BOM fixture + plain UTF-8 cases).
- `npm run import:fixture` → `2 orders`.

**Scope** — Only `src/csv.ts` changed in the repo; tests, fixtures, and other tracked files were left alone. I added a short knowledge-lake doc at `ops/csv-bom.md` describing the BOM behavior and the test results; `docs check` reports both lake docs compliant.
