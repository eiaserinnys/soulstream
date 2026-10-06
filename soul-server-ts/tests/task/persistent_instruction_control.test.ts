import { describe, expect, it, vi } from "vitest";

import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { Task } from "../../src/task/task_models.js";
import { PersistentSessionControl } from "../../src/task/persistent_session_control.js";

function makeControl(metadata: Array<Record<string, unknown>> = []) {
  const task = {
    agentSessionId: "session-instructions",
    sessionType: "claude",
    status: "running",
    persistent: true,
    metadata: [{ type: "persistent_session", value: { enabled: true } }, ...metadata],
  } as Task;
  const saved: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const enqueueMetadataEffect = vi.fn(async (_sessionId: string, entry: Record<string, unknown>) => {
    saved.push(entry);
    return 42;
  });
  const enqueueEvent = vi.fn(async (_sessionId: string, event: Record<string, unknown>) => {
    events.push(event);
    return {} as never;
  });
  const control = new PersistentSessionControl({
    getTask: (sessionId) => sessionId === task.agentSessionId ? task : undefined,
    loadEvictedTask: vi.fn(),
    rememberTask: vi.fn(),
    persistence: { enqueueMetadataEffect, enqueueEvent } as unknown as EventPersistence,
  });
  return { control, task, saved, events, enqueueMetadataEffect, enqueueEvent };
}

describe("PersistentSessionControl persistent instructions", () => {
  it("adds, updates, touches evidence once, and keeps removed items out of the active list", async () => {
    const { control, task, saved, enqueueMetadataEffect } = makeControl();
    const added = await control.applyPersistentInstructions("session-instructions", {
      origin: "agent",
      ops: [{ op: "add", text: "  Keep replies concise.  " }],
    });
    expect(added.results[0]).toMatchObject({
      status: "ok",
      item: { text: "Keep replies concise.", source_turns: [], source_event_ids: [], origin: "agent" },
    });
    const id = added.results[0]?.item?.id;
    expect(id).toEqual(expect.any(String));

    await control.applyPersistentInstructions("session-instructions", {
      origin: "agent",
      ops: [{ op: "update", id: id!, text: "Use short replies." }],
    });
    const touched = await control.applyPersistentInstructions("session-instructions", {
      origin: "extracted",
      anchor: "input-2",
      ops: [{ op: "touch", id: id!, source_turns: ["T195", "T195", "T210"], source_event_ids: [42, 42, 51] }],
    });
    expect(touched.results[0]).toMatchObject({
      status: "ok",
      item: {
        text: "Use short replies.",
        source_turns: ["T195", "T210"],
        source_event_ids: [42, 51],
      },
    });

    await control.applyPersistentInstructions("session-instructions", {
      origin: "agent",
      ops: [{ op: "update", id: id!, status: "removed" }],
    });
    expect(await control.listPersistentInstructions("session-instructions")).toEqual([]);
    expect(task.metadata?.find((entry) => entry.type === "persistent_instructions")?.value)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id, status: "removed" })]));
    expect(saved).toHaveLength(4);
    expect(enqueueMetadataEffect).toHaveBeenCalledTimes(4);
  });

  it("caps active items at 50, excludes removed items, and returns not_found", async () => {
    const existing = Array.from({ length: 49 }, (_, index) => makeInstruction(`active-${index}`));
    existing.push({ ...makeInstruction("removed-1"), status: "removed" });
    const { control, task } = makeControl([{ type: "persistent_instructions", value: existing }]);

    const added = await control.applyPersistentInstructions("session-instructions", {
      origin: "agent",
      ops: [{ op: "add", text: "The fiftieth active rule." }],
    });
    expect(added.results[0]?.status).toBe("ok");
    expect((await control.listPersistentInstructions("session-instructions"))).toHaveLength(50);

    const capped = await control.applyPersistentInstructions("session-instructions", {
      origin: "agent",
      ops: [{ op: "add", text: "The fifty-first active rule." }],
    });
    expect(capped.results[0]).toEqual({ status: "cap_reached" });
    expect(task.metadata?.find((entry) => entry.type === "persistent_instructions")?.value)
      .toHaveLength(51);

    const missing = await control.applyPersistentInstructions("session-instructions", {
      origin: "agent",
      ops: [{ op: "update", id: "missing", status: "removed" }],
    });
    expect(missing.results[0]).toEqual({ status: "not_found" });
  });

  it("publishes one anchored debug event for extracted changes, never agent or user edits", async () => {
    const { control, events } = makeControl();
    const extracted = await control.applyPersistentInstructions("session-instructions", {
      origin: "extracted",
      anchor: "input-195",
      ops: [{ op: "add", text: "Keep replies concise.", source_turns: ["T195"], source_event_ids: [700] }],
    });
    expect(events).toEqual([expect.objectContaining({
      type: "debug",
      kind: "persistent_instruction_recorded",
      input_id: "input-195",
      instructions: [{
        id: extracted.results[0]?.item?.id,
        text: "Keep replies concise.",
        source_turns: ["T195"],
        action: "added",
      }],
      cap_reached: false,
    })]);

    const instructionId = extracted.results[0]?.item?.id;
    await control.applyPersistentInstructions("session-instructions", {
      origin: "extracted",
      anchor: "input-210",
      ops: [{ op: "touch", id: instructionId!, source_turns: ["T210"], source_event_ids: [701] }],
    });
    expect(events[1]).toMatchObject({
      kind: "persistent_instruction_recorded",
      input_id: "input-210",
      instructions: [{ id: instructionId, action: "updated", source_turns: ["T195", "T210"] }],
      cap_reached: false,
    });

    await control.applyPersistentInstructions("session-instructions", {
      origin: "agent",
      ops: [{ op: "add", text: "Agent rule." }],
    });
    await control.applyPersistentInstructions("session-instructions", {
      origin: "user",
      ops: [{ op: "add", text: "User rule." }],
    });
    expect(events).toHaveLength(2);
  });

  it("records cap_reached in the extracted event even when no item is added", async () => {
    const initial = Array.from({ length: 50 }, (_, index) => makeInstruction(`active-${index}`));
    const { control, events } = makeControl([{ type: "persistent_instructions", value: initial }]);

    const result = await control.applyPersistentInstructions("session-instructions", {
      origin: "extracted",
      anchor: "input-300",
      ops: [{ op: "add", text: "Beyond the cap." }],
    });

    expect(result.results).toEqual([{ status: "cap_reached" }]);
    expect(events).toEqual([expect.objectContaining({
      type: "debug",
      kind: "persistent_instruction_recorded",
      input_id: "input-300",
      instructions: [],
      cap_reached: true,
    })]);
  });
});

function makeInstruction(id: string) {
  return {
    id,
    text: `Rule ${id}`,
    source_turns: [],
    source_event_ids: [],
    created_at: "2026-10-06T12:00:00.000Z",
    updated_at: "2026-10-06T12:00:00.000Z",
    status: "active",
    origin: "agent",
  };
}
