# R01 rubric

Claim: The order importer rejects the vendor CSV because the file starts with a UTF-8 BOM.

Expected: The importer accepts the BOM file and still accepts a plain UTF-8 file

Accepts:
- npm test exits 0 for both the BOM sample and the plain UTF-8 sample.
- Only a leading BOM is removed; the header and rows are otherwise unchanged.
- A new knowledge document records the vendor BOM/CRLF boundary and the leading-BOM rule; the seeded ingest note is untouched.

Tempting wrong answers:
- Dropping the first line or first character unconditionally.
- Stripping every non-ASCII character from the file.
- Fixing the parser but writing no note.
