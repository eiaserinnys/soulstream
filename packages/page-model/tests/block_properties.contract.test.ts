import { describe, expect, it } from "vitest";

import {
  checklistTaskBlockProperties,
  validatePageBlockProperties,
} from "../src/index.js";

describe("page block property contract", () => {
  it("builds a bound checklist accepted by the canonical runtime validator", () => {
    const properties = checklistTaskBlockProperties(
      { taskId: "task-1", itemId: "item-1" },
      true,
    );

    expect(properties).toEqual({
      checked: true,
      taskId: "task-1",
      itemId: "item-1",
    });
    expect(validatePageBlockProperties("checklist", properties)).toBeNull();
    expect(validatePageBlockProperties("checklist", {
      taskId: "task-1",
      itemId: "item-1",
    })).toBe("checklist.checked must be a boolean");
  });

  it("keeps every required known block property in the same canonical validator", () => {
    expect(validatePageBlockProperties("session_ref", {
      sessionId: "session-1",
      primary: true,
    })).toBeNull();
    expect(validatePageBlockProperties("atom_ref", {
      instance: "atom",
      nodeId: "node-1",
    })).toBeNull();
    expect(validatePageBlockProperties("guidance", {
      enabled: true,
      scope: "folder:folder-1",
    })).toBeNull();
    expect(validatePageBlockProperties("session_defaults", {
      scope: "folder:folder-1",
    })).toBeNull();
    expect(validatePageBlockProperties("task_ref", {
      taskId: "task-1",
      primary: true,
    })).toBeNull();
    expect(validatePageBlockProperties("custom_view", {
      customViewId: "custom-view-1",
    })).toBeNull();
    expect(validatePageBlockProperties("image", {
      assetId: "asset-1",
      alt: "preview",
    })).toBeNull();

    expect(validatePageBlockProperties("session_defaults", {}))
      .toBe("session_defaults.scope must be a string");
    expect(validatePageBlockProperties("task_ref", { taskId: "task-1" }))
      .toBe("task_ref.primary must be a boolean");
  });
});
