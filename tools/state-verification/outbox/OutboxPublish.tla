-------------------------- MODULE OutboxPublish --------------------------
EXTENDS Naturals

\* Code correspondence: EventOutboxPump.flush() in event_outbox_pump.ts.
\* One durable nonempty batch; at most two connection-generation changes.
\* A read and the local beforePublish callback are separate await boundaries.
CONSTANTS GuardAfterRead, GuardAfterPublish
VARIABLES generation, connected, phase, captured, inFlight, stalePublished
vars == <<generation, connected, phase, captured, inFlight, stalePublished>>

Init == /\ generation = 0 /\ connected = TRUE /\ phase = "idle"
        /\ captured = 0 /\ inFlight = FALSE /\ stalePublished = FALSE

BeginFlush == /\ connected /\ ~inFlight /\ phase \in {"idle", "dropped"}
              /\ captured' = generation /\ phase' = "reading"
              /\ UNCHANGED <<generation, connected, inFlight, stalePublished>>

Disconnect == /\ connected /\ generation < 2
              /\ generation' = generation + 1 /\ connected' = FALSE
              /\ inFlight' = FALSE
              /\ UNCHANGED <<phase, captured, stalePublished>>

Reconnect == /\ ~connected /\ generation < 2
             /\ generation' = generation + 1 /\ connected' = TRUE
             /\ UNCHANGED <<phase, captured, inFlight, stalePublished>>

ReadCompletes == /\ phase = "reading"
                 /\ phase' = IF GuardAfterRead /\ (captured # generation \/ ~connected)
                             THEN "dropped" ELSE "local-consumption"
                 /\ UNCHANGED <<generation, connected, captured, inFlight, stalePublished>>

LocalConsumptionCompletes ==
    /\ phase = "local-consumption"
    /\ IF GuardAfterPublish /\ (captured # generation \/ ~connected)
       THEN /\ phase' = "dropped" /\ UNCHANGED <<inFlight, stalePublished>>
       ELSE /\ phase' = "published" /\ inFlight' = TRUE
            /\ stalePublished' = (stalePublished \/ (captured # generation) \/ ~connected)
    /\ UNCHANGED <<generation, connected, captured>>

Acknowledged == /\ phase = "published" /\ inFlight /\ connected
                /\ phase' = "idle" /\ inFlight' = FALSE
                /\ UNCHANGED <<generation, connected, captured, stalePublished>>

Next == BeginFlush \/ Disconnect \/ Reconnect \/ ReadCompletes
        \/ LocalConsumptionCompletes \/ Acknowledged

TypeOK == /\ generation \in 0..2 /\ captured \in 0..2
          /\ connected \in BOOLEAN /\ inFlight \in BOOLEAN /\ stalePublished \in BOOLEAN
          /\ phase \in {"idle", "reading", "local-consumption", "published", "dropped"}
NeverPublishOnStaleConnection == ~stalePublished
=============================================================================
