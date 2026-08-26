# Scenario ceiling reproduction

## Scope

This lab-only record fixes the pre-change failure shape at checkout
`4d30d40a913a094998ef0241c7929245ab7f1e81`. Product source and approved
product tests are outside this record.

## Two matching observations

The completed clean-run repair produced two fresh `all` samples:

- `all-2026-08-26T05-43-29-400Z`
- `all-2026-08-26T05-47-24-472Z`

Both samples passed the clean preflight with zero invariant, session,
ownership, or runner residue. In each sample, `events.jsonl` contains
`harness_started`, `preflight_checked`, and `scenario_started` for
`steady-state`. Neither sample contains `scenario_finished` or `result.json`.

The wrapper applies `LAB_HARNESS_PROCESS_CEILING_SECONDS=180` once to the
entire `all` process. The process exits 124 while the first scenario is still
settling, so the following target inventory is never entered:

| Scenario | `scenario_started` count per sample |
|---|---:|
| F1 | 0 |
| F11 | 0 |
| F9 | 0 |
| dead-owner | 0 |
| F7 | 0 |

This is a harness scheduling failure: one earlier timeout prevents later
scenarios from producing any verdict. The product invariant count remains zero
in both observations.
