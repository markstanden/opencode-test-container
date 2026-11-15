---
Area: Ops
Keywords: csv, bom, utf-8, import, parseCsv, header
Summary: Vendor CSV exports carry a UTF-8 BOM that must be stripped before header validation.
---

# CSV BOM handling

### Facts

- Vendor CSV exports (e.g. `fixtures/orders.csv`) begin with a UTF-8 BOM (`EF BB BF`, i.e. `\uFEFF`) and use CRLF line endings.
- `parseCsv` in `src/csv.ts` strips a single leading `\uFEFF` before splitting lines and validating the `id` header, so the check sees `id` rather than `﻿id`.
- Only a BOM at position 0 is removed; a `\uFEFF` occurring later in the text is preserved.
- Plain UTF-8 input without a BOM is passed through unchanged (`text.startsWith` returns false).

### Inferred

- Stripping inside the parser keeps both the CLI importer and any other caller working without each remembering to pre-process the text.

### Tested

- `npm test` passes both the BOM fixture case and the plain UTF-8 case.
- `npm run import:fixture` reports `2 orders`.
