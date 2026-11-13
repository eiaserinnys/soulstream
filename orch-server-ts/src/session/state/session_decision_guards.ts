import { and, not, or, stateIn } from "xstate";

import {
  SESSION_FACT_VALUES,
  type SessionDecisionCommand,
  type SessionDecisionEvent,
} from "./session_decision_facts.js";
import { SESSION_REASON_LABELS } from "./session_decision_labels.js";

export interface SessionGuardEntry {
  guard: string;
  reason: string;
}

export const sessionDecisionGuards: Record<string, any> = {};
export const sessionRejections = Object.fromEntries(
  Object.keys(SESSION_FACT_VALUES).map((command) => [command, []]),
) as unknown as Record<SessionDecisionCommand, SessionGuardEntry[]>;
export const sessionNoops = Object.fromEntries(
  Object.keys(SESSION_FACT_VALUES).map((command) => [command, []]),
) as unknown as Record<SessionDecisionCommand, SessionGuardEntry[]>;

export const inside = (id: string) => stateIn(`#${id}`);
export const anyState = (...ids: string[]) => or(ids.map(inside));
export const fact = (
  key: string,
  value: string | boolean = true,
): any =>
  ({ event }: { event: SessionDecisionEvent }) =>
    (event.facts as Record<string, unknown>)[key] === value;

const ACTIVE = anyState("s_initializing", "s_running");
const TERMINAL = anyState("s_completed", "s_error", "s_interrupted");
const DISCONNECTED = and([inside("s_interrupted"), inside("t_none")]);

function reject(
  command: SessionDecisionCommand,
  name: string,
  reason: string,
  guard: any,
): void {
  const key = `reject.${command}.${name}`;
  sessionDecisionGuards[key] = guard;
  sessionRejections[command].push({ guard: key, reason });
}

function noop(
  command: SessionDecisionCommand,
  name: string,
  reason: string,
  guard: any,
): void {
  const key = `noop.${command}.${name}`;
  sessionDecisionGuards[key] = guard;
  sessionNoops[command].push({ guard: key, reason });
}

reject("register", "exists", "session_exists", not(inside("s_none")));

/** 잇기가 되살리는 유일한 칸: 종료 기록이 없는 끊김 중단. */
const ADOPTED_DISCONNECTED = and([
  fact("adopt", true),
  inside("s_interrupted"),
  inside("t_none"),
]);

for (const command of ["execution_registration", "running_transition"] as const) {
  reject(command, "missing", "session_missing", inside("s_none"));
  reject(command, "owner", "owner_node_changed", fact("owner", "mismatch"));
  reject(
    command,
    "worktreeNotReady",
    "worktree_not_ready",
    or([fact("worktree", "not_ready"), fact("worktree", "setup_required")]),
  );
  reject(command, "worktreeBusy", "worktree_busy", fact("worktreeBusy", true));
  reject(
    command,
    "resumeNotTerminal",
    "terminal_resume_not_terminal",
    and([not(fact("resume", "fresh")), not(TERMINAL)]),
  );
  reject(
    command,
    "revision",
    "terminal_revision_changed",
    and([fact("resume", "terminal_mismatch"), TERMINAL]),
  );
  reject(
    command,
    "noResumeOnTerminal",
    "terminal_without_resume",
    and([fact("resume", "fresh"), TERMINAL, not(ADOPTED_DISCONNECTED)]),
  );
}
reject(
  "running_transition",
  "adoptTerminal",
  "already_terminal",
  and([
    fact("adopt", true),
    or([
      inside("s_completed"),
      inside("s_error"),
      and([inside("s_interrupted"), inside("t_recorded")]),
    ]),
  ]),
);

reject(
  "terminal_transition",
  "invalidEvent",
  "invalid_terminal_event",
  fact("eventId", "non_positive"),
);
reject("terminal_transition", "missing", "session_missing", inside("s_none"));
reject(
  "terminal_transition",
  "owner",
  "owner_node_changed",
  fact("owner", "mismatch"),
);
reject(
  "terminal_transition",
  "fence",
  "status_fence",
  or([
    inside("s_completed"),
    inside("s_error"),
    and([inside("s_interrupted"), inside("t_recorded")]),
  ]),
);
reject(
  "terminal_transition",
  "revision",
  "revision_not_newer",
  or([fact("revision", "equal"), fact("revision", "greater")]),
);

noop(
  "node_disconnect_cleanup",
  "otherNode",
  "other_node",
  not(fact("nodeOwns", true)),
);
noop("node_disconnect_cleanup", "notActive", "not_active", not(ACTIVE));

noop("startup_reconcile_missing", "notActive", "not_active", not(ACTIVE));
noop(
  "startup_reconcile_missing",
  "targetMissing",
  "target_missing",
  not(fact("targetMatches", true)),
);
noop(
  "startup_reconcile_missing",
  "reported",
  "reported_running",
  fact("inRunningList", true),
);

noop(
  "startup_reconcile_restore",
  "notDisconnected",
  "not_disconnected",
  not(DISCONNECTED),
);
noop(
  "startup_reconcile_restore",
  "notReported",
  "not_reported",
  not(fact("inRunningList", true)),
);
noop(
  "startup_reconcile_restore",
  "worktree",
  "worktree_blocked",
  not(fact("worktreeReady", true)),
);

reject("stale_registration", "missing", "session_missing", inside("s_none"));
reject(
  "stale_registration",
  "mismatch",
  "registration_mismatch",
  fact("registration", "stale"),
);

noop("session_update_status", "missing", "session_missing", inside("s_none"));
noop("session_update_status", "terminal", "not_active", TERMINAL);

reject("acknowledge_review", "missing", "session_missing", inside("s_none"));
reject(
  "acknowledge_review",
  "notRequired",
  "review_not_required",
  not(fact("reviewRequired", true)),
);
reject(
  "acknowledge_review",
  "acknowledged",
  "already_acknowledged",
  inside("r_acknowledged"),
);
reject(
  "acknowledge_review",
  "notPending",
  "review_not_pending",
  not(inside("r_needs_review")),
);

reject("delete", "missing", "session_not_found", inside("s_none"));
reject("delete", "rejected", "node_rejected", fact("path", "rejected"));
noop("delete", "timeout", "node_delete_pending", fact("path", "timeout"));
reject(
  "delete",
  "declined",
  "requires_stop",
  and([fact("path", "declined"), ACTIVE]),
);
reject(
  "delete",
  "unavailable",
  "node_connecting",
  and([fact("path", "unavailable"), ACTIVE]),
);

reject(
  "resume_dispatch",
  "revision",
  "invalid_original_revision",
  not(fact("originalRevision", true)),
);
noop(
  "resume_dispatch",
  "busy",
  "local_task_busy",
  fact("localTaskBusy", true),
);
reject("resume_dispatch", "missing", "session_missing", inside("s_none"));
reject(
  "resume_dispatch",
  "awake",
  "session_already_awake",
  ACTIVE,
);
reject(
  "resume_dispatch",
  "notLimit",
  "current_session_not_limit_hit",
  not(
    and([
      inside("s_error"),
      or([fact("termination", "limit_recorded"), fact("termination", "limit_missing_revision")]),
    ]),
  ),
);
reject(
  "resume_dispatch",
  "missingRevision",
  "missing_current_revision",
  fact("termination", "limit_missing_revision"),
);
reject(
  "resume_dispatch",
  "chain",
  "limit_window_or_terminal_chain_changed",
  not(fact("chainContinued", true)),
);

/** 거절과 무시 가드가 모두 거짓일 때만 적용이다. */
export function sessionApplied(command: SessionDecisionCommand): any {
  const guards = [
    ...sessionRejections[command].map((entry) => entry.guard),
    ...sessionNoops[command].map((entry) => entry.guard),
  ];
  return guards.length === 0 ? () => true : not(or(guards));
}

export function applied(
  command: SessionDecisionCommand,
  ...conditions: any[]
): any {
  const base = sessionApplied(command);
  return conditions.length === 0 ? base : and([base, ...conditions]);
}

export function reasonLabel(reason: string): string {
  return SESSION_REASON_LABELS[reason] ?? reason;
}
