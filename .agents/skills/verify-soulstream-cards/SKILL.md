---
name: verify-soulstream-cards
description: Verify Soulstream card worker claim and launch-acceptance semantics before modifying or reviewing orchestration worker reconciliation, timeout rejection or concurrent launch.
---

# Verify Soulstream cards

## Covered implementation

- `orch-server-ts/src/cards/card_orchestration_workers.ts`: `CardOrchestrationWorkers.reconcile` and its `reject` path.

## Required invariants and bounds

Only the controller that wins the atomic claim may send the launch. A launch accepted by the transport must not be rejected solely because worker observation is delayed and a timeout expires.

Execute the actual class against injected repository/card/transport ports. Bound to one card, one dispatch, one to three controllers, three repeated reconciliations, eight card statuses and accepted/uncertain/rejected transport outcomes. The TLA+ model has two controllers and one dispatch. SQL claim atomicity and snapshot semantics are assumptions; DB isolation, process execution, authorization and end-to-end exactly-once behavior are excluded.

Require source mutants ignoring the claim result and acceptance timeout guard to fail. TLA+ mutants must violate `AtMostOneLaunch` and `AcceptedNotRejected` respectively. The checker also records old unaccepted dispatch rejection after a later card status change; treat that as source-observed behavior requiring production reachability and policy review, not an established production defect.

## Source sync and workflow

The reviewed sync commit is `1f15e59e3747fc5de5e245babf16753cce8a7367`. Read the current covered source and compare its control flow with the bounded model before trusting a rerun. Do not treat passing extraction markers or a model result as proof that the model still matches changed code. Preserve the invariant when updating a model; never weaken it merely to obtain a pass.

Run from the repository root with Node 24.22.1 or newer, Python 3, Java, and network access for the first pinned TLC download (or a local JAR via `--tlc-jar`):

```sh
python tools/state-verification/run.py --source-root . --subsystem cards
```

The runner verifies the JAR SHA-256, reads the actual repository source, and isolates logs, extracted modules and mutants under `tools/state-verification/.output/`. It never modifies production source. Supply `--output-dir` to choose another destination. Review source drift against the sync record before accepting a result.

Inspect `summary.json`, the subsystem's `results.json`, and every failed invariant trace. A source baseline must pass and its deliberate source mutants must fail the intended property. TLC baseline must succeed; a model mutant must exit with invariant violation code 12 and name the expected invariant. A parser, runtime, timeout or incomplete-model error is a failed verification, not a successful mutant detection.

Use the available `/statechart` skill to read the TLA+ result and generate a chart using this subsystem's model, config and `view.mjs`. Resolve that skill's tool locations from its own instructions; do not copy or hardcode its implementation paths here.

Report source execution, model exploration and production reachability separately. Include bounds, dependency assumptions, uncovered concurrency and any counterexample. Keep mutations in generated output. After a source change, review source-to-action mapping, adjust the bounded checker only as required, rerun baseline and mutants, then update the sync record in the same repository change.
