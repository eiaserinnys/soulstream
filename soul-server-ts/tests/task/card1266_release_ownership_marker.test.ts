import { describe, expect, it, vi } from "vitest";

import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";

import { makeTask, silentLogger } from "./card1266_settlement_harness.js";

/**
 * 카드 #1266 U2b 8-가. 로컬 소유 정리가 task를 잊으면 메모리에만 있는 거절된 종료 표시도 사라져
 * 러너 복구가 같은 종료를 한 번 더 올린다. 잊기 전에 그 등록을 은퇴시키고, 은퇴하지 못해 표시가
 * 남으면 task를 잊지 않는다.
 */
function setup(options: { retire?: (task: Task, registrationId: string) => Promise<void> } = {}) {
  const order: string[] = [];
  const forget = vi.fn((_id: string) => { order.push("forget"); });
  const retire = vi.fn(async (task: Task, registrationId: string) => {
    order.push("retire");
    if (options.retire) await options.retire(task, registrationId);
    else task.rejectedTerminationRegistrationId = undefined;
  });
  const transition = new TaskLifecycleTransition({
    logger: silentLogger,
    retireRejectedRegistration: retire,
    forgetTask: forget,
  } as never);
  return { transition, order, forget, retire };
}

describe("card #1266 U2b local ownership release keeps the rejected terminal mark safe", () => {
  it("retires the rejected registration before it forgets the task", async () => {
    const subject = setup();
    const task = makeTask({ status: "running", executionRegistration: undefined, rejectedTerminationRegistrationId: "registration-1" });

    await subject.transition.releaseLocalOwnership(task);

    expect(subject.retire).toHaveBeenCalledWith(task, "registration-1");
    expect(subject.order).toEqual(["retire", "forget"]);
  });

  it("does not forget the task while the mark is still set because the retirement failed", async () => {
    const subject = setup({ retire: async () => { throw new Error("retire failed"); } });
    const task = makeTask({ status: "running", executionRegistration: undefined, rejectedTerminationRegistrationId: "registration-1" });

    await subject.transition.releaseLocalOwnership(task);

    expect(subject.forget).not.toHaveBeenCalled();
    expect(task.rejectedTerminationRegistrationId).toBe("registration-1");
  });

  it("does not forget a task whose registration is held by a runner that keeps background work", async () => {
    const subject = setup();
    const task = makeTask({
      status: "running", executionRegistration: undefined,
      rejectedTerminationRegistrationId: "registration-1", runnerRetainedForDetachedWork: true,
    });

    await subject.transition.releaseLocalOwnership(task);

    expect(subject.retire).not.toHaveBeenCalled();
    expect(subject.forget).not.toHaveBeenCalled();
  });

  it("forgets the task as before on a node without runner recovery, where nothing could ever clear the mark", async () => {
    const forget = vi.fn();
    const transition = new TaskLifecycleTransition({ logger: silentLogger, forgetTask: forget } as never);
    const task = makeTask({ status: "running", executionRegistration: undefined, rejectedTerminationRegistrationId: "registration-1" });

    await transition.releaseLocalOwnership(task);

    expect(forget).toHaveBeenCalledWith(task.agentSessionId);
  });

  it("forgets a task that has no rejected terminal mark exactly as before", async () => {
    const subject = setup();
    const task = makeTask({ status: "running", executionRegistration: undefined });

    await subject.transition.releaseLocalOwnership(task);

    expect(subject.retire).not.toHaveBeenCalled();
    expect(subject.forget).toHaveBeenCalledWith(task.agentSessionId);
  });
});
