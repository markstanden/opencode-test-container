Done.

- Changed `src/db.ts` so `poolConfig.ssl` is `"require"` instead of `"disable"`.
- Left pool size (`max: 10`), acquire timeout (`5000`), and startup migration behavior untouched.
- Updated the knowledge-lake doc `db/pool.md` to record the TLS requirement and the `TLS_REQUIRED` trap.
- `npm test`: **3 passed, 0 failed**.
