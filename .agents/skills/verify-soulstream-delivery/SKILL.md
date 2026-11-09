---
name: verify-soulstream-delivery
description: Verify Soulstream intervention queue identity, ordering and batching before modifying or reviewing pending message deduplication, priority or runtime-followup delivery.
---

# Verify Soulstream delivery

## Covered implementation

- `soul-server-ts/src/task/task_intervention_queue.ts`: directly call `enqueueInterventionOnce` and `dequeueNextTurnInterventions`; their priority, sorting and runtime-followup helpers execute transitively.

## Required invariants and bounds

Keep each pending logical identity unique. Re-enqueue must be idempotent. Draining must preserve all messages, isolate runtime followups, respect high/low priority with stable FIFO, and return a nonempty batch from a nonempty queue.

Run breadth-first exploration of the actual synchronous production functions with four logical messages, at most two enqueue calls per identity, and delivery/runner/both identity modes. Do not enqueue again after removal for consumption; downstream receipts and deduplication are outside this model. Network, SQL, backend execution and crashes are excluded.

Require all six source mutants to be detected: duplicate insertion, removed identity deduplication, lost retained runtime followup, mixed runtime/ordinary batch, reversed priority, and a drain that never progresses. There is no separate delivery TLA+ model: the actual-code BFS is the verification body. Do not claim verification of every delivery ledger state.

## Source sync and workflow

The reviewed sync commit is `1f15e59e3747fc5de5e245babf16753cce8a7367`. Read the current covered source and compare its control flow with the bounded model before trusting a rerun. Do not treat passing extraction markers or a model result as proof that the model still matches changed code. Preserve the invariant when updating a model; never weaken it merely to obtain a pass.

Run from the repository root with Node 24.22.1 or newer, Python 3, Java, and network access for the first pinned TLC download (or a local JAR via `--tlc-jar`):

```sh
python tools/state-verification/run.py --source-root . --subsystem delivery
```

The runner verifies the JAR SHA-256, reads the actual repository source, and isolates logs, extracted modules and mutants under `tools/state-verification/.output/`. It never modifies production source. Supply `--output-dir` to choose another destination. Review source drift against the sync record before accepting a result.

Inspect `summary.json`, the subsystem's `results.json`, and every failed invariant trace. A source baseline must pass and its deliberate source mutants must fail the intended property. TLC baseline must succeed; a model mutant must exit with invariant violation code 12 and name the expected invariant. A parser, runtime, timeout or incomplete-model error is a failed verification, not a successful mutant detection.

Use the available `/statechart` skill to read the TLA+ result and generate a chart using this subsystem's model, config and `view.mjs`. Resolve that skill's tool locations from its own instructions; do not copy or hardcode its implementation paths here. For delivery, report the actual-code BFS graph and counterexample traces; this package intentionally has no hand-transcribed delivery TLA+ model.

Report source execution, model exploration and production reachability separately. Include bounds, dependency assumptions, uncovered concurrency and any counterexample. Keep mutations in generated output. After a source change, review source-to-action mapping, adjust the bounded checker only as required, rerun baseline and mutants, then update the sync record in the same repository change.
