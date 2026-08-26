# Clean-run baseline reproduction

## Scope

This record captures the lab-only baseline failure before the clean-run repair.
The runtime checkout, built bundle, and freshly fetched `origin/main` were all
`9f846e5ba5b1b077686a1e6aecf8afba4d18cd3e`.

The documented setup sequence was used without product-code changes:

```bash
scripts/lab-node/bootstrap.sh
scripts/lab-node/start.sh
scripts/lab-node/fault-harness.sh all
```

## Observed refusal

The harness refused before entering any fault scenario:

```json
{
  "status": "refused_dirty_baseline",
  "preflightReasons": [
    "runner_process:1083941"
  ]
}
```

The stored preflight completed 2.35 seconds after `harness_started`. Its full
state was:

```json
{
  "violations": [],
  "nonterminalSessions": [],
  "openOwnerships": [],
  "runnerProcesses": [
    {
      "pid": 1083941
    }
  ]
}
```

Evidence is stored outside the repository at:

```text
/home/eias/services/soulstream-lab/state/fault-harness/all-2026-08-26T05-14-10-631Z
```

## Causal chain

The isolated lab retained 16 `runner-state` directories from earlier runs.
Starting the worker allowed product recovery to resume an old session. The
node log recorded a new ownership generation for session
`46b15b96-43f5-4d43-b302-1dfb6268d531` in this order:

```text
reserve applied=true canonicalPhase=reserved
prove applied=true canonicalPhase=identity_proven
activate applied=true canonicalPhase=active
activeRunnerOperations sessionId=46b15b96-43f5-4d43-b302-1dfb6268d531 operation=execution:execute
```

The runner later respawned as PID `1084710`. The product recovery path did what
persisted runner state asked it to do. The contamination belongs to the lab
lifecycle, not the product recovery implementation.

## Clean-state inventory

| State axis | Before repair | Required clean-run behavior |
|---|---|---|
| Runtime checkout | `main@9f846e5b`, clean | Print checkout and freshly fetched `origin/main` |
| Built bundle | `9f846e5b` | Keep the existing bundle-to-checkout guard |
| Lab database | No invariant, nonterminal-session, or open-ownership residue at preflight | Recreate only the labeled lab database volume before every run |
| Runner processes | Recovered PID present | Stop only lab-owned process groups before reset |
| Runner state | 16 retained directories | Empty the isolated runner-state root before worker start |
| Outbox | 2 retained entries in the independent observation | Empty the isolated outbox root before worker start |
| PID and runtime state | Prior runs can leave files and releases | Empty mutable state while preserving the lab OAuth credential |
| Evidence | 281 earlier run directories in the independent observation | Start each command from a new empty lab state; keep the completed run until the next clean-run |

The existing `refused_dirty_baseline` preflight remains the post-reset guard.
No scenario, mock, verdict, timeout, or product source is changed by the repair.

