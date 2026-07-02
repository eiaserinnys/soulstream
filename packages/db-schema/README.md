# @soulstream/db-schema

Canonical PostgreSQL DDL for Soulstream.

- `sql/schema.sql` is the idempotent schema applied by the live TypeScript soul server.
- `sql/migrations/` keeps historical migration DDL and procedure snapshots.
- `tests/test_db_procedures.py` verifies stored procedures directly against PostgreSQL.

`soul-server-ts/scripts/apply-schema.mjs` executes only `sql/schema.sql`; every migration that changes existing objects must be mirrored there as an idempotent ALTER block.
