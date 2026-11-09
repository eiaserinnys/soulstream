----------------------------- MODULE Recovery -----------------------------
EXTENDS TLC

CONSTANTS SkipOwnerGuard, SkipReplayGuard
VARIABLES pc, branch, currentIdentity, oldAlive, holdsExecution,
          replayed, retired, touchedNewExecution

vars == <<pc, branch, currentIdentity, oldAlive, holdsExecution,
          replayed, retired, touchedNewExecution>>

Init ==
  /\ pc = "observed"
  /\ branch \in {"reaped", "terminalRetirement"}
  /\ currentIdentity \in {"old", "new"}
  /\ oldAlive \in BOOLEAN
  /\ holdsExecution \in BOOLEAN
  /\ replayed = FALSE
  /\ retired = FALSE
  /\ touchedNewExecution = FALSE

Superseded == holdsExecution /\ (oldAlive \/ currentIdentity # "old")

SkipReapedCleanup ==
  /\ pc = "observed" /\ branch = "reaped"
  /\ Superseded /\ ~SkipOwnerGuard
  /\ pc' = "done"
  /\ UNCHANGED <<branch, currentIdentity, oldAlive, holdsExecution,
                replayed, retired, touchedNewExecution>>

ApplyReapedCleanup ==
  /\ pc = "observed" /\ branch = "reaped"
  /\ (~Superseded \/ SkipOwnerGuard)
  /\ pc' = "done"
  /\ touchedNewExecution' = (holdsExecution /\ currentIdentity = "new")
  /\ UNCHANGED <<branch, currentIdentity, oldAlive, holdsExecution,
                replayed, retired>>

BeginReplay ==
  /\ pc = "observed" /\ branch = "terminalRetirement"
  /\ pc' = "replaying"
  /\ UNCHANGED <<branch, currentIdentity, oldAlive, holdsExecution,
                replayed, retired, touchedNewExecution>>

ReplayResult(ok) ==
  /\ pc = "replaying"
  /\ pc' = "retireCheck"
  /\ replayed' = ok
  /\ UNCHANGED <<branch, currentIdentity, oldAlive, holdsExecution,
                retired, touchedNewExecution>>

Retire ==
  /\ pc = "retireCheck" /\ (replayed \/ SkipReplayGuard)
  /\ retired' = TRUE
  /\ pc' = "done"
  /\ UNCHANGED <<branch, currentIdentity, oldAlive, holdsExecution,
                replayed, touchedNewExecution>>

KeepForRetry ==
  /\ pc = "retireCheck" /\ ~replayed /\ ~SkipReplayGuard
  /\ pc' = "done"
  /\ UNCHANGED <<branch, currentIdentity, oldAlive, holdsExecution,
                replayed, retired, touchedNewExecution>>

Finished == pc = "done" /\ UNCHANGED vars

Next == SkipReapedCleanup \/ ApplyReapedCleanup \/ BeginReplay
        \/ ReplayResult(TRUE) \/ ReplayResult(FALSE) \/ Retire
        \/ KeepForRetry \/ Finished

Spec == Init /\ [][Next]_vars
TypeOK ==
  /\ pc \in {"observed", "replaying", "retireCheck", "done"}
  /\ branch \in {"reaped", "terminalRetirement"}
  /\ currentIdentity \in {"old", "new"}
  /\ oldAlive \in BOOLEAN /\ holdsExecution \in BOOLEAN
  /\ replayed \in BOOLEAN /\ retired \in BOOLEAN
  /\ touchedNewExecution \in BOOLEAN
NoNewExecutionDamage == ~touchedNewExecution
NoRetirementBeforeReplay == retired => replayed
=============================================================================
