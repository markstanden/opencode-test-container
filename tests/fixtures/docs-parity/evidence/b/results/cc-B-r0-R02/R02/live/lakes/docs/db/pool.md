---
Area: DB
Keywords: postgres, pool, tls, sslmode, migrations
Summary: Connection pool limits, startup migrations and the required TLS setting after the 2026 database upgrade.
---

# Connection pool

### Facts

- The pool holds at most 10 connections.
- Acquiring a connection waits up to 5 seconds before failing.
- Migrations run at application startup.
- Since the 2026 database upgrade the proxy no longer terminates TLS, so connections must use `sslmode=require`.
- `sslmode=disable` is obsolete and fails with `TLS_REQUIRED`; the pool size, acquire timeout and startup migrations are unchanged.
