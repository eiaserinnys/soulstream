----------------------- MODULE CardWorkerLaunch -----------------------
EXTENDS Naturals, FiniteSets
CONSTANTS SkipClaimFence, IgnoreAcceptedFence
Workers == 1..2
VARIABLES phase, accepted, expired, pc, launches
vars == <<phase, accepted, expired, pc, launches>>

Init == /\ phase = "admitted"
        /\ accepted = FALSE
        /\ expired = FALSE
        /\ pc = [w \in Workers |-> "idle"]
        /\ launches = 0

ReadSnapshot(w) ==
  /\ pc[w] = "idle" /\ phase = "admitted"
  /\ pc' = [pc EXCEPT ![w] = "snapshot"]
  /\ UNCHANGED <<phase, accepted, expired, launches>>

Claim(w) ==
  /\ pc[w] = "snapshot"
  /\ IF phase = "admitted" \/ SkipClaimFence
        THEN /\ pc' = [pc EXCEPT ![w] = "claimed"]
             /\ phase' = IF phase = "admitted" THEN "launching" ELSE phase
        ELSE /\ pc' = [pc EXCEPT ![w] = "done"]
             /\ UNCHANGED phase
  /\ UNCHANGED <<accepted, expired, launches>>

Send(w) ==
  /\ pc[w] = "claimed"
  /\ launches' = launches + 1
  /\ pc' = [pc EXCEPT ![w] = "done"]
  /\ UNCHANGED <<phase, accepted, expired>>

Accept ==
  /\ phase = "launching" /\ launches > 0 /\ ~accepted /\ ~expired
  /\ accepted' = TRUE
  /\ UNCHANGED <<phase, expired, pc, launches>>

Expire ==
  /\ phase = "launching" /\ ~expired
  /\ expired' = TRUE
  /\ UNCHANGED <<phase, accepted, pc, launches>>

Observe ==
  /\ phase = "launching" /\ accepted
  /\ phase' = "running"
  /\ UNCHANGED <<accepted, expired, pc, launches>>

RejectExpired ==
  /\ phase = "launching" /\ expired
  /\ (~accepted \/ IgnoreAcceptedFence)
  /\ phase' = "rejected"
  /\ UNCHANGED <<accepted, expired, pc, launches>>

Done == /\ phase \in {"running", "rejected"}
        /\ UNCHANGED vars
Next == (\E w \in Workers: ReadSnapshot(w) \/ Claim(w) \/ Send(w))
        \/ Accept \/ Expire \/ Observe \/ RejectExpired \/ Done
TypeOK == /\ phase \in {"admitted","launching","running","rejected"}
          /\ accepted \in BOOLEAN /\ expired \in BOOLEAN
          /\ pc \in [Workers -> {"idle","snapshot","claimed","done"}]
          /\ launches \in 0..2
AtMostOneLaunch == launches <= 1
AcceptedNotRejected == accepted => phase # "rejected"
=============================================================================

