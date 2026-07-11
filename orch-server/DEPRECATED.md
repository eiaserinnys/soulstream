# Deprecated Python Orchestrator

> `orch-server/` is not the production orchestrator runtime. Production runs `orch-server-ts/`.

## Runtime code is frozen

Do not add features or fix runtime bugs in this directory. Make every production orchestrator change in `orch-server-ts/` instead.

Do not delete or rename this directory as part of ordinary maintenance. Removal is a separate cleanup task.

## Maintained exception: contract tests

`orch-server/tests/test_contract_*` remains part of the standard verification suite. These tests use shared fixtures to verify wire contracts against the TypeScript orchestrator and must be maintained when a contract intentionally changes.

The contract tests are the only maintained code surface under `orch-server/`. Their presence does not make the Python runtime active.

## Migration references

- TypeScript orchestrator transition runbook: `rb-orch-ts-20260707`
- Production entrypoint and cutover gate: [PR #370](https://github.com/eiaserinnys/soulstream/pull/370), [PR #371](https://github.com/eiaserinnys/soulstream/pull/371)
- Board Y.Doc ownership migration: [PR #385](https://github.com/eiaserinnys/soulstream/pull/385) through [PR #388](https://github.com/eiaserinnys/soulstream/pull/388), completed at `7c4c05b0`
