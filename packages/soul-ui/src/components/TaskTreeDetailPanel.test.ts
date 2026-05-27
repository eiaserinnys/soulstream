/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskItem } from "../shared";
import { TaskTreeDetailPanel, type TaskEditDraft } from "./TaskTreeDetailPanel";

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: "task-1",
    parentId: null,
    positionKey: 1,
    title: "Original title",
    description: "Original description",
    acceptanceCriteria: "Original acceptance",
    verificationOwner: "agent",
    status: "open",
    linkedSessionId: null,
    linkedNodeId: null,
    activeForSessionId: null,
    createdFromSessionId: "session-1",
    createdFromEventId: null,
    navigationSessionId: "session-1",
    navigationNodeId: "node-1",
    navigationEventId: null,
    archived: false,
    pinned: false,
    version: 1,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    ...overrides,
  };
}

function changeControlValue(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype = control instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!valueSetter) throw new Error("DOM value setter is unavailable");
  valueSetter.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TaskTreeDetailPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSave: ReturnType<typeof vi.fn<[TaskItem, TaskEditDraft], void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onSave = vi.fn();
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
  });

  it("edits title, description, and acceptance criteria without reading a cleared React event target", () => {
    const task = makeTask();
    flushSync(() => {
      root.render(createElement(TaskTreeDetailPanel, { task, onSave }));
    });

    const titleInput = container.querySelector("input");
    const textareas = container.querySelectorAll("textarea");
    const [descriptionInput, acceptanceInput] = Array.from(textareas);
    if (!titleInput || !descriptionInput || !acceptanceInput) {
      throw new Error("Task detail inputs did not render");
    }

    expect(() => {
      flushSync(() => {
        changeControlValue(titleInput, "Renamed task");
        changeControlValue(descriptionInput, "Updated description");
        changeControlValue(acceptanceInput, "Updated acceptance criteria");
      });
    }).not.toThrow();

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("저장"),
    );
    if (!saveButton) throw new Error("Save button did not render");

    flushSync(() => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSave).toHaveBeenCalledWith(task, {
      title: "Renamed task",
      description: "Updated description",
      acceptanceCriteria: "Updated acceptance criteria",
    });
  });
});
