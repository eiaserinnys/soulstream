# @soulstream/db-schema

Canonical PostgreSQL DDL for Soulstream.

- `sql/schema.sql` is the idempotent schema applied by the live TypeScript soul server.
- `sql/migrations/` keeps historical migration DDL and procedure snapshots.

The deprecated Python `soul-server` package must not own the live database contract.
