# Agent Instructions

- `orch-server-ts/` is the production orchestrator. The retired Python `orch-server/` tree has been removed; do not recreate it for production changes.
- When changing session status literals or session writes in `orch-server-ts/src` or `packages/db-schema/sql/schema.sql`, run `corepack pnpm -C orch-server-ts run check:session-machine`.
- When changing `soul-server-ts/src`, run `corepack pnpm -C soul-server-ts run check:quick`; if you intentionally change tool names or descriptions, add `-u` to update the snapshot.
- If `check:session-machine` fails, update `orch-server-ts/src/session/state/session_state_writes.ts` and regenerate the documentation with `corepack pnpm -C orch-server-ts run gen:session-docs`.
