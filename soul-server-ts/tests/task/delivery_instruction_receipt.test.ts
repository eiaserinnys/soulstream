import { describe, expect, it } from "vitest";

import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import type { Task } from "../../src/task/task_models.js";
import { hasLiveRunner } from "../../src/task/delivery_instruction_receipt.js";

const row = { target_session_id: "session-a" } as SessionDeliveryRow;

describe("hasLiveRunner", () => {
  it("returns false when the target task is absent", () => {
    expect(hasLiveRunner(row, () => undefined)).toBe(false);
  });

  it("returns false when the task has no runner", () => {
    expect(hasLiveRunner(row, () => ({}) as Task)).toBe(false);
  });

  it.each([false, true])("returns the runner's active execution value %s", (active) => {
    const task = { runner: { dispatcher: { hasActiveExecution: () => active } } } as Task;
    expect(hasLiveRunner(row, () => task)).toBe(active);
  });
});
