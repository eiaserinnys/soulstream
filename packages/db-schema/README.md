# @soulstream/db-schema

Canonical PostgreSQL DDL for Soulstream.

- `sql/schema.sql` is the idempotent schema applied by the live TypeScript soul server.
- `sql/migrations/` keeps historical migration DDL and procedure snapshots.
- `tests/test_db_procedures.py` verifies stored procedures directly against PostgreSQL.
