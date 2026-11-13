import { not } from "xstate";

import {
  SESSION_COMMAND_LABELS,
  SESSION_COMMAND_RULES,
} from "./session_decision_labels.js";
import type { SessionDecisionCommand } from "./session_decision_facts.js";
import { applied, fact, inside } from "./session_decision_guards.js";

const regions = ["status", "termination", "review", "reservation"] as const;

export const sessionEffects: Record<string, Record<string, any[]>> =
  Object.fromEntries(regions.map((region) => [region, {}]));

function put(
  region: (typeof regions)[number],
  command: SessionDecisionCommand,
  target: string | undefined,
  conditions: any[],
  label: string,
): void {
  const list = sessionEffects[region]![command] ??= [];
  list.push({
    ...(target ? { target: `#${target}` } : {}),
    guard: applied(command, ...conditions),
    actions: [{ type: "write", params: { region, command } }],
    description: `${SESSION_COMMAND_LABELS[command]}: ${label}`,
    meta: {
      command,
      label,
      region,
      rule: SESSION_COMMAND_RULES[command],
    },
  });
}

const NOT_NONE = not(inside("s_none"));
const ACTIVE = not(inside("s_none"));

put("status", "register", "s_initializing", [inside("s_none")], "줄을 만들었다");
for (const command of ["execution_registration", "running_transition"] as const) {
  put("status", command, "s_running", [NOT_NONE], "실행 중으로 옮겼다");
}
for (const target of ["completed", "error", "interrupted"] as const) {
  put(
    "status",
    "terminal_transition",
    `s_${target}`,
    [fact("target", target)],
    `${target}로 기록했다`,
  );
}
for (const command of [
  "node_disconnect_cleanup",
  "startup_reconcile_missing",
] as const) {
  put("status", command, "s_interrupted", [ACTIVE], "중단으로 기록했다");
}
put("status", "startup_reconcile_restore", "s_running", [], "running으로 되살렸다");
put("status", "session_update_status", "s_running", [NOT_NONE], "상태를 썼다");
put("status", "delete", "s_none", [NOT_NONE], "줄을 지웠다");

for (const command of ["execution_registration", "running_transition"] as const) {
  put(
    "termination",
    command,
    "t_none",
    [fact("resume", "terminal_match")],
    "종료 기록을 지웠다",
  );
}
for (const command of [
  "terminal_transition",
  "node_disconnect_cleanup",
  "startup_reconcile_missing",
] as const) {
  put("termination", command, "t_recorded", [], "종료 리비전을 기록했다");
}
put("termination", "startup_reconcile_restore", "t_none", [], "종료 기록을 지웠다");
put("termination", "delete", "t_none", [], "종료 기록을 지웠다");

for (const command of [
  "register",
  "execution_registration",
  "running_transition",
  "terminal_transition",
  "node_disconnect_cleanup",
  "startup_reconcile_missing",
] as const) {
  for (const review of ["not_required", "needs_review", "acknowledged"] as const) {
    put(
      "review",
      command,
      `r_${review}`,
      [fact("reviewNext", review)],
      `${review}로 썼다`,
    );
  }
}
put(
  "review",
  "startup_reconcile_restore",
  "r_not_required",
  [],
  "검수 불필요로 되돌렸다",
);
put("review", "acknowledge_review", "r_acknowledged", [], "검수를 확인했다");
put("review", "delete", "r_not_required", [], "검수 칸을 지웠다");
