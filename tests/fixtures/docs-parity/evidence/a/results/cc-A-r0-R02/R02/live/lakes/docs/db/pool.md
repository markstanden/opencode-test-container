---
Area: DB
Keywords: postgres, pool, tls, migrations
Summary: Connection pool limits, startup migrations and the TLS setting.
---

# Connection pool

### Facts

- The pool holds at most 10 connections.
- Acquiring a connection waits up to 5 seconds before failing.
- Migrations run at application startup.
- Connections use `sslmode=require` because since the 2026 database upgrade the proxy no longer terminates TLS; `sslmode=disable` is obsolete.

### Failed approaches

- Keeping `sslmode=disable` for the old proxy: after the upgrade it fails with `TLS_REQUIRED`.
