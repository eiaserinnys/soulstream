import { describe, expect, it, vi } from "vitest";

import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { Task } from "../../src/task/task_models.js";
import { PersistentSessionControl } from "../../src/task/persistent_session_control.js";

describe("PersistentSessionControl", () => {
  it("durably replaces the marker before updating the in-memory Task", async () => {
    const task = {
      agentSessionId: "session-persistent",
      sessionType: "claude",
      metadata: [
        { type: "other_metadata", value: { retained: true } },
        { type: "persistent_session", value: { enabled: false, updated_at: "old" } },
      ],
    } as Task;
    const enqueueMetadataEffect = vi.fn().mockResolvedValue(42);
    const control = new PersistentSessionControl({
      getTask: vi.fn((sessionId) => sessionId === task.agentSessionId ? task : undefined),
      loadEvictedTask: vi.fn(),
      rememberTask: vi.fn(),
      persistence: { enqueueMetadataEffect } as unknown as EventPersistence,
    });

    await expect(control.setSessionPersistent(task.agentSessionId, true)).resolves.toEqual({
      sessionId: task.agentSessionId,
      persistent: true,
      generation: 1,
    });

    expect(enqueueMetadataEffect).toHaveBeenCalledWith(
      task.agentSessionId,
      expect.objectContaining({
        type: "persistent_session",
        value: expect.objectContaining({
          enabled: true,
          updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
        }),
      }),
      { replaceExistingType: "persistent_session", waitForAck: true },
    );
    expect(task.metadata).toHaveLength(2);
    expect(task.metadata?.filter((entry) => entry.type === "persistent_session")).toHaveLength(1);
    expect(task.persistent).toBe(true);

    await control.setSessionPersistent(task.agentSessionId, false);
    expect(task.persistent).toBe(false);
    expect(task.metadata?.filter((entry) => entry.type === "persistent_session")).toHaveLength(1);
  });
});
