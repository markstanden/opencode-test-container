---
Area: Ops
Keywords: csv, bom, import, utf-8, vendor
Summary: The CSV importer strips a leading UTF-8 BOM before validating headers; plain UTF-8 is unaffected.
---

# CSV BOM handling

### Facts

- Vendor `fixtures/orders.csv` begins with the bytes `EF BB BF` (a UTF-8 BOM) and uses CRLF line endings.
- `parseCsv` in `src/csv.ts` removes a leading `U+FEFF` only, before splitting lines and checking that the first header cell is `id`.
- Without stripping, the first header cell is `\uFEFFid`, so the importer fails with `unexpected header: ﻿id`.

### Tested

- `npm run import:fixture` reports `2 orders` against the vendor fixture.
- `npm test` passes both the BOM fixture case and the plain UTF-8 case.

### Inferred

- A BOM is only valid at the start of the file, so the strip must not remove `U+FEFF` characters elsewhere in field data.
