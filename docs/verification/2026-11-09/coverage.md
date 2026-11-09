# Source-to-check coverage

All source mappings were reviewed at `1f15e59e3747fc5de5e245babf16753cce8a7367`. The verification tools read actual repository source; they do not contain a copy of product implementation. Source mutants are generated in the output directory only.

## Runner recovery

Sources:

- `soul-server-ts/src/runner/runner_process_registry.ts`: `isTerminalRunnerExecutionState`, `classifyRunnerRegistration`.
- `soul-server-ts/src/runner/runner_recovery_disposition.ts`: `heldExecutionSupersedesRegistration`, `terminalizeReapedRunner`, `recoverRunnerByDisposition`.

The actual-source checker mechanically extracts these function bodies, supplies explicit dependency stubs, and executes the unchanged baseline with Node's TypeScript support. It enumerates 96 classification inputs, 48 cleanup inputs, and 48 recovery-disposition inputs. It asserts an independent classification table, protects a task holding a newer execution, and requires replay evidence before retirement.

| TLA+ action | Source boundary | Modeling assumption |
|---|---|---|
| Init | Hydrated registration and current task | One recovery observation, old/new identities, fixed liveness and held-execution inputs |
| SkipReapedCleanup | `heldExecutionSupersedesRegistration` guard and return | No side effects on the guarded path |
| ApplyReapedCleanup | retire/terminate/invalidate/recover calls after the guard | Multiple awaits collapse into one action; intervening ownership changes are excluded |
| BeginReplay / ReplayResult | `recoverOffline(...).replayed` | Both outcomes are considered; actual replay implementation is a dependency |
| Retire | `retireTerminal` | Modeled only on the relevant terminal branch |
| KeepForRetry | Return when replay did not run | Future scans and their eventual progress are excluded |

Source mutants remove new-owner protection, bypass the replay guard, or classify a dead terminal runner as live. TLA+ mutants remove the first two guards. Expected invariants: `NoNewExecutionDamage`, `NoRetirementBeforeReplay`.

## Card worker launch

Sources:

- `orch-server-ts/src/cards/card_orchestration_workers.ts`: `CardOrchestrationWorkers.reconcile`, `reject`.
- Mapping dependencies: `card_orchestration_repository.ts` (`pendingWorkers`, `claimWorker`, authorization, `workerObserved`) and `card_work_lifecycle.ts` (accepted work receipt).

The actual class executes through in-memory repository, card and transport ports. Its 25 scenarios cover eight card states times two deadline values, plus one/two/three controllers times three transport outcomes. Reconciliation repeats three times on reconstructed controllers. The repository port assumes an atomic claim; PostgreSQL itself is not executed.

| TLA+ action | Source boundary | Modeling assumption |
|---|---|---|
| ReadSnapshot | `pendingWorkers` SELECT | Two controllers may retain the same stale admitted snapshot |
| Claim | `UPDATE ... WHERE state='admitted' RETURNING` and boolean guard | One atomic SQL operation; claim and later send remain distinct |
| Send | `launchWorker` or `sendMessage` | External call after claim |
| Accept | Successful launch authorization | Policy/card/token/deadline checks are abstracted as a successful external event |
| Expire | `launch_deadline <= NOW()` | A one-way time crossing |
| Observe | Committed valid work receipt and `workerObserved` | Correlation and transaction internals excluded |
| RejectExpired | `launching && expired && !launch_accepted` | Only dispatch result is modeled; card write and dispatch write are separate in production |

One dispatch, two controllers, at most two sends, safety only. Source/model mutants bypass the claim result or reject accepted work on timeout. Expected invariants: `AtMostOneLaunch`, `AcceptedNotRejected`. The extra observation of an old rejection affecting a current card is a function-level behavior, not a confirmed production-reachable bug.

## Intervention queue

Source: `soul-server-ts/src/task/task_intervention_queue.ts`, principally `enqueueInterventionOnce` and `dequeueNextTurnInterventions`.

The checker executes production functions directly; it does not translate them to a hand model. Breadth-first search enumerates four logical messages (two normal inputs, a completion notification, a runtime follow-up), at most two enqueues per logical message, and every eligible enqueue/dequeue order. It separately checks delivery ID, runner ID, and both identities. Each mode has 3,529 states and 7,236 transitions.

| Property | Oracle | Source mutation |
|---|---|---|
| QueueIdentityUnique | Unique logical IDs in pending queue | Push a new entry twice |
| ReenqueueIsIdempotent | Re-enqueue leaves an existing pending identity unchanged | Remove identity deduplication |
| DrainConservesMessages | Returned batch plus remaining queue equals previous queue | Drop deferred runtime follow-up |
| RuntimeFollowupIsIsolated | Runtime follow-up occurs in a singleton batch | Mix it with ordinary input |
| QueuePriorityAndStableFifo | Stable order within each priority lane | Reverse priority |
| NonemptyQueueMakesProgress | A nonempty queue yields a nonempty batch | Return an empty batch without changing the queue |

The exploration's `consumed` field only excludes already-dequeued identities from future enqueues. It is not evidence of engine consumption. Re-enqueue after dequeue, payload changes, identity collision, engine receipt, persistence and end-to-end delivery are excluded. The source digest normalizes CRLF and final newlines and otherwise fails closed on drift.

## Outbox publication and ACK

Sources:

- `soul-server-ts/src/upstream/event_outbox_pump.ts`: `connect`, `disconnect`, `flush`, `handleAck`.
- `soul-server-ts/src/upstream/event_outbox_pump_protocol.ts`: actual protocol helper implementations.

The actual class and protocol helpers execute after type erasure. Six deterministic scenarios pause on either `readBatch` or `beforePublish`, change connections, and release the await; or send wrong-stream, wrong-sequence, wrong-range and matching ACKs. Stores and transports are explicit in-memory ports; the test checks the pump's validation before invoking its store.

| TLA+ action | Source boundary | Modeling assumption |
|---|---|---|
| BeginFlush | Capture sender and generation after the flush-active guard | One nonempty durable batch, one flush operation |
| ReadCompletes | Resume after `await outbox.readBatch()` | Distinct await boundary and current-connection guard |
| LocalConsumptionCompletes | Resume after `await beforePublish(batch)` | Distinct await boundary; fence is checked before sender is invoked |
| Disconnect / Reconnect | Generation changes and in-flight reset | At most two changes from the initially connected state |
| Acknowledged | Return to idle after a matching ACK | Payload, durable commit, larger batches and full replay protocol excluded |

Expected safety invariant: `NeverPublishOnStaleConnection`. Deadlock checking is disabled because the model bounds external connection events and does not model full post-publication reconnect/replay. Source mutations remove the post-await fence, stream validation, or sequence mapping. ACK properties belong to actual-source scenarios and are not claimed as TLA+ properties.

## Interpretation rules

Require baseline success and all deliberate mutants to violate their intended property. A TLA+ mutant must return exit code 12 and the expected invariant name. Syntax, incomplete successor assignment, runtime errors and timeouts must fail the verification harness.

A pass applies to the stated function inputs, schedules and models. Source-to-model review remains necessary after implementation changes, especially when await boundaries, ownership fields or database transactions change. Update the sync commit only after that review and a successful rerun.
