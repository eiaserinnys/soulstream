# Soulstream bounded state verification

Run from the repository root:

```sh
python tools/state-verification/run.py
```

Requirements: Node 24.22.1 or newer, Python 3, Java 11 or newer. The first run downloads the official `tla2tools` v1.7.4 JAR and checks its pinned SHA-256. For offline use, pass `--tlc-jar` with an existing verified JAR. Optional arguments: `--subsystem runner|cards|delivery|outbox`, `--source-root`, `--output-dir`.

The command runs actual-source checks and their deliberately broken variants, then three bounded TLA+ models and expected invariant violations. A mutant is detected only when the intended check fails; syntax/runtime errors do not count as successful mutation detection. Generated modules, mutants and logs stay under `.output/` by default, and product source is read only.

Read the [audit report](../../docs/verification/2026-11-09/README.md) and the appropriate project-local verification skill before interpreting a pass. The checks do not establish complete-system correctness, engine exactly-once consumption, database isolation, operating-system lock correctness or liveness. Source changes require reviewing the mapping and moving the sync commit deliberately.

Use pstack `/statechart` to inspect the TLA+ models with each subsystem's `view.mjs`; the pstack tool path is intentionally not embedded in this package. Delivery uses direct finite-state exploration of the production queue functions rather than a separately transcribed TLA+ model.
