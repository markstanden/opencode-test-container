# DB fixture

The connection pool caps at 10 connections and waits 5 seconds to acquire one. Migrations run at startup. Since the 2026 database upgrade the proxy no longer terminates TLS, so clients must connect with `sslmode=require`; `sslmode=disable` is obsolete.
