import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  annotateTerminalSystemAbort,
  appendSystemAbortNotice,
  buildSystemAbortNoticeItem,
  isSystemAbortTermination,
  systemAbortNoticeKey,
  SYSTEM_ABORT_NOTICE_KEY,
} from "../../src/task/system_abort_notice.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";

const silentLogger = pino({ level: "silent" });

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-abort",
    prompt: "original prompt",
    status: "running",
    createdAt: new Date("2026-11-13T01:00:00.000Z"),
    lastEventId: 3114,
    lastReadEventId: 3000,
    interventionQueue: [],
    ...overrides,
  };
}

function noticeItems(message: InterventionMessage) {
  return (message.context ?? []).filter(
    (item) => item.key === SYSTEM_ABORT_NOTICE_KEY,
  );
}

describe("isSystemAbortTermination", () => {
  it.each([
    { label: "runner process exit", reason: "error_aborted", detail: "runner process exited before execution completed" },
    { label: "watchdog abort", reason: "error_aborted", detail: "Claude foreground turn was inactive for 1200000ms and was interrupted." },
    { label: "abort without detail", reason: "error_aborted", detail: null },
    { label: "node disconnect", reason: "killed", detail: "node_disconnect_timeout" },
    { label: "startup reconciliation", reason: "killed", detail: "startup_reconciliation" },
    { label: "orchestrator shutdown", reason: "killed", detail: "shutdown" },
    { label: "usage limit", reason: "limit_hit", detail: "Claude usage limit reached" },
  ])("treats $label as a system abort", ({ reason, detail }) => {
    expect(isSystemAbortTermination(reason, detail)).toBe(true);
  });

  it.each([
    { label: "explicit human stop", reason: "killed", detail: "user_stop" },
    { label: "unconfirmed runner stop", reason: "error_aborted", detail: "runner stop was not confirmed" },
    { label: "completed turn", reason: "completed_ok", detail: null },
    { label: "unknown reason", reason: "unknown", detail: null },
    { label: "user interruption reason", reason: "user_interrupted", detail: "card1158 emergency stop" },
    { label: "missing reason", reason: null, detail: null },
    { label: "missing values", reason: undefined, detail: undefined },
  ])("leaves $label alone", ({ reason, detail }) => {
    expect(isSystemAbortTermination(reason, detail)).toBe(false);
  });
});

describe("buildSystemAbortNoticeItem", () => {
  it("carries the termination and the no-human-stop notice under the canonical key", () => {
    const item = buildSystemAbortNoticeItem({
      reason: "error_aborted",
      detail: "runner process exited before execution completed",
      eventId: 3114,
    });

    expect(item.key).toBe("previous_turn_system_abort");
    expect(item.content).toMatchObject({
      termination_reason: "error_aborted",
      termination_detail: "runner process exited before execution completed",
    });
    const notice = (item.content as { notice: string }).notice;
    expect(notice).toContain(
      "시스템 사유로 끝났습니다(사유: error_aborted, 상세: runner process exited before execution completed)",
    );
    expect(notice).toContain("The user doesn't want to proceed");
    expect(notice).toContain("Request interrupted by user");
    expect(notice).toContain("사용자는 아무것도 멈추거나 거절하지 않았습니다");
    expect(notice).toContain("사용자 지시를 기다리며 멈추지 말고");
    expect(notice).toContain("다시 돌려 하던 일을 이어 가세요");
  });

  it("keys the notice once per termination event", () => {
    expect(systemAbortNoticeKey("killed", "node_disconnect_timeout", 744))
      .toBe("killed:node_disconnect_timeout:744");
    expect(systemAbortNoticeKey("limit_hit", null, null)).toBe("limit_hit::");
  });
});

describe("appendSystemAbortNotice", () => {
  it.each([
    { label: "error_aborted", reason: "error_aborted", detail: "runner process exited before execution completed", expected: true },
    { label: "limit_hit", reason: "limit_hit", detail: "Claude usage limit reached", expected: true },
    { label: "killed/startup_reconciliation", reason: "killed", detail: "startup_reconciliation", expected: true },
    { label: "killed/shutdown", reason: "killed", detail: "shutdown", expected: true },
    { label: "watchdog error_aborted", reason: "error_aborted", detail: "Claude foreground turn was inactive for 1200000ms and was interrupted.", expected: true },
    { label: "killed/user_stop", reason: "killed", detail: "user_stop", expected: false },
    { label: "error_aborted/unconfirmed stop", reason: "error_aborted", detail: "runner stop was not confirmed", expected: false },
    { label: "completed_ok", reason: "completed_ok", detail: null, expected: false },
  ])("decides $label from the terminal task snapshot", async ({ reason, detail, expected }) => {
    const task = makeTask({
      status: "error",
      terminationReason: reason as Task["terminationReason"],
      terminationDetail: detail,
      terminalEventId: 3114,
    });
    const message: InterventionMessage = { text: "이어서 진행", user: "system" };

    await appendSystemAbortNotice(task, message, { logger: silentLogger });

    expect(noticeItems(message)).toHaveLength(expected ? 1 : 0);
    expect(task.lastSystemAbortNoticeKey === undefined).toBe(!expected);
  });

  it("never repeats the notice for the same termination event", async () => {
    const task = makeTask({
      status: "error",
      terminationReason: "error_aborted",
      terminationDetail: "runner process exited before execution completed",
      terminalEventId: 3114,
    });
    const first: InterventionMessage = { text: "첫 입력", user: "system" };
    await appendSystemAbortNotice(task, first, { logger: silentLogger });
    expect(noticeItems(first)).toHaveLength(1);
    expect(task.lastSystemAbortNoticeKey)
      .toBe("error_aborted:runner process exited before execution completed:3114");

    const second: InterventionMessage = { text: "두 번째 입력", user: "system" };
    await appendSystemAbortNotice(task, second, { logger: silentLogger });
    expect(second.context).toBeUndefined();
  });

  it("reads the stored session termination while the task still looks active", async () => {
    const task = makeTask({ status: "running" });
    const readSessionTermination = vi.fn().mockResolvedValue({
      termination_reason: "killed",
      termination_detail: "node_disconnect_timeout",
      termination_event_id: 744,
    });
    const first: InterventionMessage = { text: "첫 입력", user: "system" };

    await appendSystemAbortNotice(task, first, {
      readSessionTermination,
      logger: silentLogger,
    });

    expect(readSessionTermination).toHaveBeenCalledWith("sess-abort");
    expect(noticeItems(first)).toHaveLength(1);
    expect(task.lastSystemAbortNoticeKey).toBe("killed:node_disconnect_timeout:744");

    const second: InterventionMessage = { text: "두 번째 입력", user: "system" };
    await appendSystemAbortNotice(task, second, {
      readSessionTermination,
      logger: silentLogger,
    });
    expect(second.context).toBeUndefined();
  });

  it("does not add a notice when the stored row belongs to a human stop", async () => {
    const task = makeTask({ status: "running" });
    const message: InterventionMessage = { text: "첫 입력", user: "system" };

    await appendSystemAbortNotice(task, message, {
      readSessionTermination: vi.fn().mockResolvedValue({
        termination_reason: "killed",
        termination_detail: "user_stop",
        termination_event_id: 745,
      }),
      logger: silentLogger,
    });

    expect(message.context).toBeUndefined();
    expect(task.lastSystemAbortNoticeKey).toBeUndefined();
  });

  it("delivers without a notice when the session read fails", async () => {
    const task = makeTask({ status: "running" });
    const logger = { warn: vi.fn() };
    const message: InterventionMessage = { text: "첫 입력", user: "system" };

    await expect(appendSystemAbortNotice(task, message, {
      readSessionTermination: vi.fn().mockRejectedValue(new Error("sessions read failed")),
      logger,
    })).resolves.toBeUndefined();

    expect(message.text).toBe("첫 입력");
    expect(message.context).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("does not duplicate an item the message already carries", async () => {
    const task = makeTask({
      status: "error",
      terminationReason: "killed",
      terminationDetail: "node_disconnect_timeout",
      terminalEventId: 744,
    });
    const item = buildSystemAbortNoticeItem({
      reason: "killed",
      detail: "node_disconnect_timeout",
      eventId: 744,
    });
    const message: InterventionMessage = {
      text: "첫 입력",
      user: "system",
      context: [item],
    };

    await appendSystemAbortNotice(task, message, { logger: silentLogger });

    expect(noticeItems(message)).toHaveLength(1);
  });
});

describe("annotateTerminalSystemAbort", () => {
  it("annotates the queued original message for a terminal system abort", () => {
    const task = makeTask({
      status: "error",
      terminationReason: "error_aborted",
      terminationDetail: "runner process exited before execution completed",
      terminalEventId: 3114,
    });
    const message: InterventionMessage = { text: "밀린 입력", user: "system" };

    annotateTerminalSystemAbort(task, message);

    expect(noticeItems(message)).toHaveLength(1);
    expect(task.lastSystemAbortNoticeKey)
      .toBe("error_aborted:runner process exited before execution completed:3114");
  });

  it("leaves a queued message untouched after a human stop", () => {
    const task = makeTask({
      status: "interrupted",
      terminationReason: "killed",
      terminationDetail: "user_stop",
      terminalEventId: 745,
    });
    const message: InterventionMessage = { text: "밀린 입력", user: "system" };

    annotateTerminalSystemAbort(task, message);

    expect(message.context).toBeUndefined();
    expect(task.lastSystemAbortNoticeKey).toBeUndefined();
  });
});
