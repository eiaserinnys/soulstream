# Claude Code Instructions

- `orch-server-ts/` is the production orchestrator. The retired Python `orch-server/` tree has been removed; do not recreate it for production changes.
- When changing session status literals or session writes in `orch-server-ts/src` or `packages/db-schema/sql/schema.sql`, run `corepack pnpm -C orch-server-ts run check:session-machine`.
- When changing `soul-server-ts/src`, run `corepack pnpm -C soul-server-ts run check:quick`; if you intentionally change tool names or descriptions, add `-u` to update the snapshot.
- If `check:session-machine` fails, update `orch-server-ts/src/session/state/session_state_writes.ts` and regenerate the documentation with `corepack pnpm -C orch-server-ts run gen:session-docs`.
- Do not hardcode specific model names (preset IDs, provider model IDs, aliases, or display names) in production code, configuration, installers, or scripts; read them from the model catalog and global settings. Fable limit handling is the sole exception; `soul-server-ts/tests/model_catalog_code_tables.test.ts` enforces this rule.
