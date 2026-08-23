# Soulstream lab node

This directory runs one manually managed Soulstream stack on `eiaserinnys` without Haniel. It owns a dedicated PostgreSQL container, TypeScript orchestrator, and TypeScript worker. The runtime clone and every mutable path stay below `/home/eias/services/soulstream-lab`.

## Isolation contract

| Resource | Lab value |
|---|---|
| Runtime clone | `/home/eias/services/soulstream-lab/repo` |
| Orchestrator | `127.0.0.1:5300` |
| Worker | `127.0.0.1:3116` |
| PostgreSQL | `127.0.0.1:5437` |
| Docker container | `soulstream-lab-postgres` |
| Docker volume | `soulstream-lab-postgres-data` |
| Database and user | `soulstream_lab` |
| State | `/home/eias/services/soulstream-lab/state` |
| Logs | `/home/eias/services/soulstream-lab/logs` |
| Event outbox | `/home/eias/services/soulstream-lab/outbox` |
| Runner state | `/home/eias/services/soulstream-lab/runner-state` |
| Agent workspace | `/home/eias/services/soulstream-lab/workspace` |

The scripts refuse the production ports, refuse a container or volume lacking the `com.soulstream.lab=true` label, and never read an ambient `DATABASE_URL`. They do not call Haniel and do not operate any production container.

## First bootstrap

Clone `main` into the fixed runtime path. Do not point the service at a Git worktree.

```bash
git clone --branch main git@github.com:eiaserinnys/soulstream.git /home/eias/services/soulstream-lab/repo
```

Provide a readable Claude OAuth token file only for bootstrap. Bootstrap copies it to the lab state with mode `0600`; the worker receives only the isolated destination path. Generated PostgreSQL, bearer, and JWT secrets are written to `/home/eias/services/soulstream-lab/.env` with mode `0600` and are never printed.

```bash
LAB_CLAUDE_AUTH_SOURCE=/absolute/path/to/claude-auth.json \
  /home/eias/services/soulstream-lab/repo/scripts/lab-node/bootstrap.sh
```

Bootstrap creates the dedicated Docker resources, initializes the empty database through the canonical migration ledger, verifies migrations, installs dependencies, and builds the worker and orchestrator sequentially under the host verification lock.

Each Git commit receives its own database release journal below `state/database-release/lab-{sha}`. Re-running bootstrap after a fast-forward therefore reconciles the already-current lab schema without colliding with a previous release identity.

The migration command is `migrate.mjs initialize`, not `apply`: the canonical migration implementation explicitly rejects normal `apply` for an empty database and routes `initialize` to a fresh install without manual ledger edits.

## Start, status, and stop

```bash
/home/eias/services/soulstream-lab/repo/scripts/lab-node/start.sh
/home/eias/services/soulstream-lab/repo/scripts/lab-node/status.sh
/home/eias/services/soulstream-lab/repo/scripts/lab-node/stop.sh
```

`start.sh` is idempotent. It starts the owned PostgreSQL container, verifies the schema initialized by `bootstrap.sh`, then starts orch and worker and waits until `GET /api/nodes` contains exactly one `eias-lab` entry.

`stop.sh` sends SIGTERM only to PIDs whose command lines match this runtime clone. It then stops only the labeled lab PostgreSQL container. It never sends SIGKILL.

## Node restart and SDK smoke

The stage-1 proof creates one Claude session, waits for an exact assistant marker, sends SIGTERM to the worker host, restarts it, and delivers a second message to the same session through `/intervene`.

```bash
/home/eias/services/soulstream-lab/repo/scripts/lab-node/smoke.sh
```

The last smoke session ID is stored at `/home/eias/services/soulstream-lab/state/last-smoke-session`. Runtime API responses used by the proof remain below `state/smoke/` and contain no credentials.

To restart only the worker without running the smoke flow:

```bash
/home/eias/services/soulstream-lab/repo/scripts/lab-node/restart-node.sh
```

Keep at most two concurrent lab sessions. Before builds or smoke runs, confirm at least 2GB available memory with `free -m`.

## Fault harness

The stage-2 harness records every injection and every invariant sample below
`/home/eias/services/soulstream-lab/state/fault-harness/{run-id}`. `events.jsonl`
contains the injection timeline, `invariants.jsonl` contains cycle verdicts,
`pairing-inputs.jsonl` contains the sessions and events the verdict was computed
from, appended per sample as deltas, and `result.json` is the run summary. Matching lab log excerpts are copied
beside them with bearer tokens and known lab secrets redacted.

`pairing-inputs.jsonl` is what makes a run re-judgeable later, and
`fault-harness-rejudge.mjs` reads it with no database at all. Each line carries
only what changed since the previous sample, so a long soak stays linear; the
replay merges them and judges at the last sample's `capturedAt`, not at the
wall clock. Evidence written before it existed carries conclusions only, so
once the lab database is rebuilt those runs can no longer be checked -- 39 of
the runs stored on 2026-08-22 are in that state. A short-lived earlier format,
`pairing-inputs.json`, is still read so that evidence is not orphaned by its
own fix.

Run one scenario or the complete prioritized set:

```bash
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh scenario steady-state
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh scenario restart-adopt
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh scenario restart-intervention-window
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh scenario delivery-revival
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh scenario delivery-exact-once
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh scenario delivery-fifo
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh scenario delivery-accepted-cas
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh scenario F9
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh scenario dead-owner
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh scenario runner-death-live-host
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh scenario activate-rollback
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh all
```

`all` first runs steady-state, restart-adopt, and restart-intervention-window.
The transparency oracle is authored before execution from the required normal
general and intervention semantics; it is not copied from the current live
behavior. `steady-state` is judged against that contract too. Restart scenarios
must have the same accepted caller outcome, semantic event order, tool result,
response counts, terminal status, and visible error set. Only timestamps,
per-run identifiers, and delay are ignored. The recovery-window
scenario observes the database adoption transition before sending its single
intervention; it never retries a rejected call.

The four delivery scenarios follow the three normal transparency scenarios and
precede the existing accident reproductions. Each is compared both with an
authored contract and with a steady delivery observation via
`contractDifferences` and `steadyObservationDifferences`; a thrown error alone
is never the verdict. They cover exhausted-delivery revival, stable logical
message exact-once behavior, per-target FIFO, and honest acceptance after a
queued-state CAS race.

The remaining canonical order is runner-death-live-host, activate-rollback,
F9, dead-owner, F1, F11, and F7, followed by one normal traffic cycle. F1
includes both SIGTERM and SIGKILL. F9 toggles only the lab
bearer credential's non-secret generation marker so the release identity
changes without changing runtime behavior. The new generation stays canonical
for the next lab run.

The bounded traffic loop supports at most two concurrent sessions:

```bash
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh \
  cycle --concurrency 2 --cycles 4 --interval-seconds 300
```

The harness exits nonzero when a scenario verdict or invariant fails. It may
write only the dedicated lab PostgreSQL container and may signal only PIDs
whose command line and runtime root match the lab clone.

### Proving the judges still work

```bash
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh mutation
```

Plants a real violating row for every invariant, requires the judge to name it,
then removes the row and requires the judge to go quiet again. Run it before
trusting a green scorecard, and after touching anything under
`fault-harness-verdict.mjs` or the invariant SQL.

This exists because the harness once shipped an invariant, `user_message_loss`,
whose input was a function parameter every caller set to `[]`. It could not
fire, it passed the unit tests over hand-built snapshots, and a full day of
verdicts rested on it.

### Re-judging stored evidence

```bash
scripts/lab-node/fault-harness-rejudge.mjs            # every stored run
scripts/lab-node/fault-harness-rejudge.mjs <run-id>   # one run
```

Replays stored runs against the current verdict, so a change to a judge can be
checked against every run ever taken instead of against a fresh reproduction.
Needs only the lab postgres environment variables.

## Updating the runtime clone

Stop the lab stack, fast-forward `main`, and rerun bootstrap so the worker release manifest is rebuilt against the lab deployment env.

```bash
/home/eias/services/soulstream-lab/repo/scripts/lab-node/stop.sh
git -C /home/eias/services/soulstream-lab/repo pull --ff-only origin main
LAB_CLAUDE_AUTH_SOURCE=/home/eias/services/soulstream-lab/state/claude-auth.json \
  /home/eias/services/soulstream-lab/repo/scripts/lab-node/bootstrap.sh
/home/eias/services/soulstream-lab/repo/scripts/lab-node/start.sh
```

Do not register this stack with Haniel.
