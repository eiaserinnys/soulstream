---
name: verify-soulstream-runner
description: Verify Soulstream runner recovery identity and terminal replay before modifying or reviewing runner cleanup, recovery classification, adoption or retirement.
---

# Verify Soulstream runner

## Covered implementation

- `soul-server-ts/src/runner/runner_process_registry.ts`: `isTerminalRunnerExecutionState`, `classifyRunnerRegistration`.
- `soul-server-ts/src/runner/runner_recovery_disposition.ts`: `heldExecutionSupersedesRegistration`, `terminalizeReapedRunner`, `recoverRunnerByDisposition`.

## Required invariants and bounds

An old registration's cleanup must not touch a task already holding a new execution. A terminal registration must not retire before its durable records were actually replayed. A dead terminal runner must be classified for offline replay, not a live handle.

Execute 192 finite input cases with 194 assertions. Model one recovery observation, old/new identities, alive/held booleans and replay true/false. The TLA+ cleanup action is atomic; state changes across its internal awaits, OS locks, real process death, DB and IPC are excluded. Canonical admission-before-ACK is not covered.

Require source mutants disabling the new-owner guard, replay guard and dead/live classification to fail. Require both owner and replay TLA+ mutants to violate their named invariants.

## Source sync and workflow

The reviewed sync commit is `1f15e59e3747fc5de5e245babf16753cce8a7367`. Read the current covered source and compare its control flow with the bounded model before trusting a rerun. Do not treat passing extraction markers or a model result as proof that the model still matches changed code. Preserve the invariant when updating a model; never weaken it merely to obtain a pass.

Run from the repository root with Node 24.22.1 or newer, Python 3, Java, and network access for the first pinned TLC download (or a local JAR via `--tlc-jar`):

```sh
python tools/state-verification/run.py --source-root . --subsystem runner
```

The runner verifies the JAR SHA-256, reads the actual repository source, and isolates logs, extracted modules and mutants under `tools/state-verification/.output/`. It never modifies production source. Supply `--output-dir` to choose another destination. Review source drift against the sync record before accepting a result.

Inspect `summary.json`, the subsystem's `results.json`, and every failed invariant trace. A source baseline must pass and its deliberate source mutants must fail the intended property. TLC baseline must succeed; a model mutant must exit with invariant violation code 12 and name the expected invariant. A parser, runtime, timeout or incomplete-model error is a failed verification, not a successful mutant detection.

Use the available `/statechart` skill to read the TLA+ result and generate a chart using this subsystem's model, config and `view.mjs`. Resolve that skill's tool locations from its own instructions; do not copy or hardcode its implementation paths here.

Report source execution, model exploration and production reachability separately. Include bounds, dependency assumptions, uncovered concurrency and any counterexample. Keep mutations in generated output. After a source change, review source-to-action mapping, adjust the bounded checker only as required, rerun baseline and mutants, then update the sync record in the same repository change.
