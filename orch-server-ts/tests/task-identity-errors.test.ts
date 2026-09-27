import { describe, expect, it } from "vitest";

import {
  TaskIdentityAlreadyPromotedError,
  TaskIdentityBindingConflictError,
  TaskIdentityCreateCollisionError,
  TaskIdentityStalePlanConflictError,
  isTaskIdentityAlreadyPromotedError,
  isTaskIdentityBindingConflict,
  isTaskIdentityCreateCollision,
  isTaskIdentityStalePlanConflict,
  taskIdentityHostErrorCode,
  TaskIdentityTitleConflictError,
} from "../src/tasks/task_identity_errors.js";

describe("task identity error classification", () => {
  it("does not classify generic errors by their message", () => {
    expect(isTaskIdentityStalePlanConflict(
      new Error("task version conflict: task-a"),
    )).toBe(false);
    expect(isTaskIdentityBindingConflict(
      new Error("legacy task is already bound to page page-a"),
    )).toBe(false);
  });

  it("keeps create collisions, adopted state, and stale plans in separate classes", () => {
    const createCollision = new TaskIdentityCreateCollisionError("task identity task already exists: task-a");
    const alreadyPromoted = new TaskIdentityAlreadyPromotedError("page is already a task identity: page-a");
    const mountChanged = new TaskIdentityStalePlanConflictError("task mount projection changed: page-a");
    const projectChanged = new TaskIdentityStalePlanConflictError("task identity project mapping changed: folder-a");

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
    ]) expect(isTaskIdentityCreateCollision(new Error(message))).toBe(false);

    expect(isTaskIdentityCreateCollision(
      new TaskIdentityCreateCollisionError("task identity task already exists: task-a"),
    )).toBe(true);
    expect(isTaskIdentityCreateCollision(
      new Error("task identity task already exists: task-a"),
    )).toBe(false);

    for (const message of [
      "task mount projection changed: page-a",
      "task mount projection changed on page-a: block-a",
      "task identity project mapping changed: folder-a",
      "task identity mapping changed: task-a",
      "task identity source folder changed: task-a",
      "task version conflict: task-a",
    ]) expect(isTaskIdentityStalePlanConflict(
      new TaskIdentityStalePlanConflictError(message),
    )).toBe(true);

    for (const message of [
      "legacy task is already bound to page page-a",
      "backfill page already exists: page-a",
    ]) expect(isTaskIdentityBindingConflict(
      new TaskIdentityBindingConflictError(message),
    )).toBe(true);

    expect(isTaskIdentityBindingConflict(
      new Error("page is already a task identity: page-a"),
    )).toBe(false);
  });

  it("preserves the four host conflict classes on the cross-node error wire", () => {
    expect(taskIdentityHostErrorCode(
      new TaskIdentityCreateCollisionError("task identity task already exists: task-a"),
    )).toBe("TASK_IDENTITY_CREATE_COLLISION");
    expect(taskIdentityHostErrorCode(
      new TaskIdentityAlreadyPromotedError("page is already a task identity: page-a"),
    )).toBe("TASK_IDENTITY_ALREADY_PROMOTED");
    expect(taskIdentityHostErrorCode(
      new TaskIdentityStalePlanConflictError("task version conflict: task-a"),
    )).toBe("TASK_IDENTITY_STALE_PLAN_CONFLICT");
    expect(taskIdentityHostErrorCode(
      new TaskIdentityBindingConflictError("legacy task is already bound to page page-a"),
    )).toBe("TASK_IDENTITY_BINDING_CONFLICT");
    expect(taskIdentityHostErrorCode(
      new TaskIdentityTitleConflictError("title conflict"),
    )).toBe("TASK_IDENTITY_TITLE_CONFLICT");
    expect(taskIdentityHostErrorCode(new Error("database unavailable"))).toBe(
      "TASK_IDENTITY_OPERATION_FAILED",
    );
  });
});
