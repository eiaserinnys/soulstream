---
name: verify-soulstream-outbox
description: Verify Soulstream outbox connection-generation fencing and ACK identity before modifying or reviewing event publication across reconnects or durable cursor advancement.
---

# Verify Soulstream outbox

## Covered implementation

- `soul-server-ts/src/upstream/event_outbox_pump.ts`: `EventOutboxPump.connect`, `disconnect`, `flush`, `handleAck`.
- `soul-server-ts/src/upstream/event_outbox_pump_protocol.ts`: protocol helpers imported by the pump.

## Required invariants and bounds

An await started on a previous connection generation must not publish on that stale connection after reconnect. An ACK with a wrong stream, per-event sequence or range must not advance the durable cursor; a matching ACK must advance it.

Run six deterministic asynchronous cases with one event: pause after outbox read or local publication, disconnect/reconnect, then resolve the old await; separately check wrong-stream, wrong-sequence, wrong-range and valid ACK. The TLA+ model covers the read/local-publication fences with a bounded connection change. Real disk, PostgreSQL transactions, larger batches, arbitrary packet reordering, OS failure and liveness are excluded.

Require source mutants removing the post-publication fence, ACK stream check and ACK event-sequence mapping to fail. The TLA+ mutant removes the post-publication guard and must violate `NeverPublishOnStaleConnection`. Deadlock checking is disabled for this deliberately finite scenario; do not report liveness or deadlock freedom.

## Source sync and workflow

The reviewed sync commit is `1f15e59e3747fc5de5e245babf16753cce8a7367`. Read the current covered source and compare its control flow with the bounded model before trusting a rerun. Do not treat passing extraction markers or a model result as proof that the model still matches changed code. Preserve the invariant when updating a model; never weaken it merely to obtain a pass.

Run from the repository root with Node 24.22.1 or newer, Python 3, Java, and network access for the first pinned TLC download (or a local JAR via `--tlc-jar`):

```sh
python tools/state-verification/run.py --source-root . --subsystem outbox
```

The runner verifies the JAR SHA-256, reads the actual repository source, and isolates logs, extracted modules and mutants under `tools/state-verification/.output/`. It never modifies production source. Supply `--output-dir` to choose another destination. Review source drift against the sync record before accepting a result.

Inspect `summary.json`, the subsystem's `results.json`, and every failed invariant trace. A source baseline must pass and its deliberate source mutants must fail the intended property. TLC baseline must succeed; a model mutant must exit with invariant violation code 12 and name the expected invariant. A parser, runtime, timeout or incomplete-model error is a failed verification, not a successful mutant detection.

Use the available `/statechart` skill to read the TLA+ result and generate a chart using this subsystem's model, config and `view.mjs`. Resolve that skill's tool locations from its own instructions; do not copy or hardcode its implementation paths here.

Report source execution, model exploration and production reachability separately. Include bounds, dependency assumptions, uncovered concurrency and any counterexample. Keep mutations in generated output. After a source change, review source-to-action mapping, adjust the bounded checker only as required, rerun baseline and mutants, then update the sync record in the same repository change.
