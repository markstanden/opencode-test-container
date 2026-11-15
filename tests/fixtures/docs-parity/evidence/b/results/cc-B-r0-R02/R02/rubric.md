# R02 rubric

Claim: npm test fails with TLS_REQUIRED because the database client still connects with sslmode=disable.

Expected: The client requires TLS and the pool facts remain documented

Accepts:
- npm test exits 0.
- Connections require TLS after the upgrade.
- The pool size (10), acquire timeout (5 seconds) and startup migrations are unchanged.
- The knowledge document is corrected: the obsolete sslmode=disable claim is gone and every still-valid pool fact survives, in any faithful wording.

Tempting wrong answers:
- Setting sslmode=require while changing the pool size or timeout.
- Deleting the pool note instead of correcting it.
- Replacing the note and dropping the pool size, timeout or migration facts.
