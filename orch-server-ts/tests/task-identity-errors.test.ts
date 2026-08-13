import { describe, expect, it } from "vitest";

import {
  isTaskIdentityAlreadyPromotedError,
  isTaskIdentityBindingConflict,
  isTaskIdentityCreateCollision,
  isTaskIdentityStalePlanConflict,
} from "../src/tasks/task_identity_errors.js";

describe("task identity error classification", () => {
  it("keeps create collisions, adopted state, and stale plans in separate classes", () => {
    const createCollision = new Error("task identity task already exists: task-a");
    const alreadyPromoted = new Error("page is already a task identity: page-a");
    const mountChanged = new Error("task mount projection changed: page-a");
    const projectChanged = new Error("task identity project mapping changed: folder-a");

    expect(isTaskIdentityCreateCollision(createCollision)).toBe(true);
    expect(isTaskIdentityAlreadyPromotedError(createCollision)).toBe(false);
    expect(isTaskIdentityStalePlanConflict(createCollision)).toBe(false);

    expect(isTaskIdentityCreateCollision(alreadyPromoted)).toBe(false);
    expect(isTaskIdentityAlreadyPromotedError(alreadyPromoted)).toBe(true);
    expect(isTaskIdentityStalePlanConflict(alreadyPromoted)).toBe(false);

    for (const error of [mountChanged, projectChanged]) {
      expect(isTaskIdentityCreateCollision(error)).toBe(false);
      expect(isTaskIdentityAlreadyPromotedError(error)).toBe(false);
      expect(isTaskIdentityStalePlanConflict(error)).toBe(true);
    }
  });

  it("classifies every explicit host conflict without broad message matching", () => {
    for (const message of [
      "task identity task already exists: task-a",
      "task identity already exists: task-a",
    ]) expect(isTaskIdentityCreateCollision(new Error(message))).toBe(true);

    for (const message of [
      "task mount projection changed: page-a",
      "task mount projection changed on page-a: block-a",
      "task identity project mapping changed: folder-a",
      "task identity mapping changed: task-a",
      "task identity source folder changed: task-a",
      "task version conflict: task-a",
    ]) expect(isTaskIdentityStalePlanConflict(new Error(message))).toBe(true);

    for (const message of [
      "legacy task is already bound to page page-a",
      "backfill page already exists: page-a",
    ]) expect(isTaskIdentityBindingConflict(new Error(message))).toBe(true);

    expect(isTaskIdentityBindingConflict(
      new Error("page is already a task identity: page-a"),
    )).toBe(false);
  });
});
