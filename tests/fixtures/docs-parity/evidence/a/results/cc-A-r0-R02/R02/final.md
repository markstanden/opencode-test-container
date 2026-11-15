Changed `src/db.ts` to require TLS:

```diff
-    ssl: "disable",
+    ssl: "require",
```

Pool size (`10`), acquire timeout (`5000ms`) and startup migrations are untouched. Updated the DB knowledge doc (`db/pool.md`) to record that the proxy no longer terminates TLS, so `sslmode=require` is now required.

`npm test` passes: **3/3 tests**.
