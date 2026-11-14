import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  classifyRunnerAdoptRejection,
  TERMINAL_ADOPT_REJECTION_REASONS,
} from "../../../src/task/state/node_adopt_rejection.js";
import * as runnerDecision from "../../../src/runner/state/runner_central_check_decision.js";
import {
  NODE_CLEANUP_INTENTS,
  decideNodeResponse,
} from "../../../src/task/state/node_response_decision.js";
import {
  NODE_RESPONSE_CELLS,
  type NodeResponseFacts,
} from "../../../src/task/state/node_response_machine.js";
import {
  NODE_RESPONSE_COMBINATIONS,
  allNodeResponseFacts,
} from "../../../src/task/state/node_tables.js";

const BASE: NodeResponseFacts = {
  call: "startup_recovery_adopt",
  route: "applied_false",
  reason: "none",
  registration: "same",
  termination: "absent",
  centralSession: "present",
  retained: false,
};

function decide(facts: Partial<NodeResponseFacts>) {
  return decideNodeResponse({ ...BASE, ...facts });
}

describe("node response cell", () => {
  it("gives every input combination exactly one cell and a clean intent list", () => {
    let count = 0;
    for (const facts of allNodeResponseFacts()) {
      const decision = decideNodeResponse(facts);
      expect(NODE_RESPONSE_CELLS).toContain(decision.cell);
      expect(new Set(decision.intents).size).toBe(decision.intents.length);
      expect([...decision.intents]).toEqual(
        NODE_CLEANUP_INTENTS.filter((intent) => decision.intents.includes(intent)),
      );
      if (decision.cell === "applied") expect(decision.intents).toEqual([]);
      count += 1;
    }
    expect(count).toBe(NODE_RESPONSE_COMBINATIONS);
    expect(count).toBe(7560);
  });

  it("scopes permanent rejection cleanup to the rejected registration and command", () => {
    expect(decide({ call: "execution_registration", route: "dead_letter" }).intents)
      .toEqual(["mark_central_error", "reap_runner"]);
    expect(decide({ call: "first_message", route: "transport_quarantine" }).intents)
      .toEqual(["abandon_attempt", "mark_central_error"]);
  });

  it("does not overwrite the new run's central state on owner change or a stale registration", () => {
    const owner = decide({
      call: "execution_registration",
      route: "dead_letter",
      reason: "owner_node_changed",
    });
    expect(owner.intents).not.toContain("mark_central_error");
    const stale = decide({
      call: "execution_registration",
      route: "dead_letter",
      registration: "different",
    });
    expect(stale.intents).not.toContain("mark_central_error");
    expect(stale.intents).not.toContain("reap_runner");
    const ownerRejected = decide({ reason: "owner_node_changed" });
    expect(ownerRejected.cell).toBe("no_retry");
    expect(ownerRejected.intents).not.toContain("mark_central_error");
    for (const facts of allNodeResponseFacts()) {
      if (facts.reason === "owner_node_changed" || facts.registration === "different") {
        expect(decideNodeResponse(facts).intents).not.toContain("mark_central_error");
      }
    }
  });

  it("closes the pending settlement and retires the registration on terminal rejections without resubmitting", () => {
    for (const route of ["dead_letter", "transport_quarantine"] as const) {
      const permanent = decide({ call: "termination", route });
      expect(permanent.intents).toEqual([
        "close_settlement_pending",
        "retire_rejected_registration",
      ]);
    }
    const noRetry = decide({ call: "termination", reason: "already_terminal" });
    expect(noRetry.cell).toBe("no_retry");
    expect(noRetry.intents).toEqual([
      "close_settlement_pending",
      "retire_rejected_registration",
    ]);
    for (const facts of allNodeResponseFacts()) {
      if (facts.call !== "termination") continue;
      const decision = decideNodeResponse(facts);
      if (decision.cell === "permanent" || decision.cell === "quarantine"
        || decision.cell === "no_retry") {
        expect(decision.intents).not.toContain("resubmit_same_termination");
        expect(decision.intents).toContain("close_settlement_pending");
        expect(decision.intents).toContain("retire_rejected_registration");
      }
    }
  });

  it("releases local ownership once the central session is confirmed missing", () => {
    for (const facts of allNodeResponseFacts()) {
      const decision = decideNodeResponse(facts);
      const releases = decision.intents.includes("release_local_ownership");
      expect(releases).toBe(facts.centralSession === "absent" && decision.cell !== "applied");
    }
    expect(decide({ centralSession: "absent", reason: "session_missing" }).intents)
      .toContain("release_local_ownership");
    expect(decide({ centralSession: "unknown", reason: "session_missing" }).intents)
      .not.toContain("release_local_ownership");
  });

  it("treats a missing reason as retryable for old servers", () => {
    for (const call of ["execution_registration", "startup_recovery_adopt",
      "attached_runner_adopt", "resume", "resume_compensation_terminal",
      "first_message"] as const) {
      expect(decide({ call }).cell).toBe("retryable");
    }
    expect(decide({ call: "termination", termination: "absent" }).cell).toBe("retryable");
    // 카드 #1266 U5c: 워크트리 점유는 다시 될 까닭이 없는 거절이다(합의 모형 M:408-412).
    expect(decide({ reason: "worktree_busy" }).cell).toBe("no_retry");
    expect(decide({ reason: "worktree_not_ready" }).cell).toBe("retryable");
    expect(decide({ reason: "session_missing" }).cell).toBe("no_retry");
  });

  it("settles a reasonless termination rejection by the canonical termination event", () => {
    expect(decide({ call: "termination", termination: "same" })).toEqual({
      cell: "applied",
      reason: null,
      intents: [],
    });
    const other = decide({ call: "termination", termination: "different" });
    expect(other.cell).toBe("no_retry");
    expect(other.reason).toBe("already_terminal");
    expect(decide({ call: "resume", termination: "same" }).cell).toBe("retryable");
  });

  it("never reaps a normally retained runner", () => {
    for (const facts of allNodeResponseFacts()) {
      if (facts.retained) expect(decideNodeResponse(facts).intents).not.toContain("reap_runner");
    }
    expect(decide({ reason: "owner_node_changed" }).intents).toEqual(["reap_runner"]);
    expect(decide({ reason: "owner_node_changed", retained: true }).intents).toEqual([]);
  });

  it("keeps the retryable cell for transport retries and a missing response", () => {
    expect(decide({ route: "transport_retryable" })).toEqual({
      cell: "retryable",
      reason: null,
      intents: ["retry_later"],
    });
    expect(decide({ route: "no_response", call: "termination" }).intents)
      .toEqual(["resubmit_same_termination"]);
  });
});

// 카드 #1266 U5c: 합의 모형 M:406-412. 점유로 거절된 잇기는 러너를 거두고, 중앙 세션이 끝남을 기록하지
// 않았으면(끊김 중단) 오류 종료를 올린다. orch가 끝남보다 점유를 먼저 보므로 노드가 중앙 줄로 가른다.
describe("busy worktree adoption rejection", () => {
  const ADOPTS = ["startup_recovery_adopt", "attached_runner_adopt"] as const;

  it("reaps and marks the central error when no end is recorded", () => {
    for (const call of ADOPTS) {
      expect(decide({ call, reason: "worktree_busy" })).toEqual({
        cell: "no_retry",
        reason: "worktree_busy",
        intents: ["mark_central_error", "reap_runner"],
      });
    }
  });

  it("only reaps when the central session already recorded its end", () => {
    for (const call of ADOPTS) {
      expect(decide({ call, reason: "worktree_busy", termination: "different" }).intents)
        .toEqual(["reap_runner"]);
    }
  });

  it("keeps the adoption retryable before the central session is read", () => {
    for (const call of ADOPTS) {
      expect(decide({ call, reason: "worktree_busy", centralSession: "unknown" }).intents)
        .toEqual(["retry_later"]);
    }
  });

  it("does not mark the central error for a stale registration, a retained runner, an execution registration or other reasons", () => {
    expect(decide({ reason: "worktree_busy", registration: "different" }).intents).toEqual([]);
    expect(decide({ reason: "worktree_busy", retained: true }).intents).toEqual([]);
    expect(decide({ call: "execution_registration", reason: "worktree_busy" }).intents)
      .toEqual(["reap_runner"]);
    expect(decide({ reason: "already_terminal" }).intents).toEqual(["reap_runner"]);
    expect(decide({ reason: "worktree_not_ready" }).intents).toEqual(["retry_later"]);
  });
});

describe("adopt rejection classification", () => {
  it("is owned by task/state and keeps its classification", () => {
    expect(TERMINAL_ADOPT_REJECTION_REASONS).toEqual([
      "already_terminal",
      "session_missing",
      "owner_node_changed",
      "worktree_busy",
    ]);
    for (const reason of TERMINAL_ADOPT_REJECTION_REASONS) {
      expect(classifyRunnerAdoptRejection(reason)).toBe("terminal_rejection");
    }
    for (const reason of ["worktree_not_ready", "unknown", "", null, undefined]) {
      expect(classifyRunnerAdoptRejection(reason)).toBe("retryable_rejection");
    }
  });

  it("is called by the runner decision module rather than redefined there", () => {
    expect(runnerDecision.classifyRunnerAdoptRejection).toBe(classifyRunnerAdoptRejection);
    expect(runnerDecision.TERMINAL_ADOPT_REJECTION_REASONS)
      .toBe(TERMINAL_ADOPT_REJECTION_REASONS);
  });

  it("does not import runner/state from task/state", () => {
    const directory = new URL("../../../src/task/state/", import.meta.url);
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".ts")) continue;
      expect(readFileSync(new URL(file, directory), "utf8"), file)
        .not.toMatch(/from\s+"[^"]*\/runner\//);
    }
  });
});
