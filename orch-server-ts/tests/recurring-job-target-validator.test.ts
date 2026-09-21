import { describe, expect, it, vi } from "vitest";

import { InMemoryNodeRegistry } from "../src/node/registry.js";
import { createRecurringJobTargetValidator } from "../src/recurring-jobs/target_validator.js";
import type { RecurringJobActor } from "../src/recurring-jobs/types.js";

const actor: RecurringJobActor = {
  ownerEmail: "member@example.com",
  actorId: "caller-session",
  callerInfo: { source: "agent", email: "member@example.com" },
  source: "agent",
};

describe("recurring job target validator", () => {
  it("applies connected node/agent/model and the owner's folder access before accepting a folder target", async () => {
    const requireAvailable = vi.fn();
    const validator = createRecurringJobTargetValidator({
      registry: registry(),
      modelPresetAvailability: { requireAvailable },
      listFolders: async () => [
        { id: "allowed-folder" },
        { id: "private-folder" },
      ],
      findUserByEmail: async () => ({
        email: "member@example.com",
        isAdmin: false,
        allowedFolderIds: ["allowed-folder"],
      }),
    });

    await expect(validator({ actor, target: target("allowed-folder") })).resolves.toBeUndefined();
    expect(requireAvailable).toHaveBeenCalledWith("node-a", "codex-default");
    await expect(validator({ actor, target: target("private-folder") })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("checks task ownership against the selected accessible folder", async () => {
    const validator = createRecurringJobTargetValidator({
      registry: registry(),
      modelPresetAvailability: { requireAvailable: vi.fn() },
      listFolders: async () => [{ id: "allowed-folder" }],
      findUserByEmail: async () => ({
        email: "member@example.com",
        isAdmin: true,
        allowedFolderIds: [],
      }),
      getTaskSnapshot: async () => ({ task: { folder_id: "other-folder" } }),
    });

    await expect(validator({
      actor,
      target: {
        ...target("allowed-folder"),
        container: { kind: "task", id: "task-a" },
      },
    })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a deleted, archived, or newly inaccessible task target", async () => {
    let task: Record<string, unknown> | null = { folder_id: "allowed-folder", archived: false };
    let allowed = true;
    const validator = createRecurringJobTargetValidator({
      registry: registry(),
      modelPresetAvailability: { requireAvailable: vi.fn() },
      listFolders: async () => [{ id: "allowed-folder" }],
      findUserByEmail: async () => ({
        email: "member@example.com",
        isAdmin: false,
        allowedFolderIds: allowed ? ["allowed-folder"] : ["other-folder"],
      }),
      getTaskSnapshot: async () => task ? { task } : null,
    });
    const taskTarget = {
      ...target("allowed-folder"),
      container: { kind: "task" as const, id: "task-a" },
    };

    task = null;
    await expect(validator({ actor, target: taskTarget })).rejects.toMatchObject({ code: "NOT_FOUND" });
    task = { folder_id: "allowed-folder", archived: true };
    await expect(validator({ actor, target: taskTarget })).rejects.toMatchObject({ code: "ARCHIVED" });
    task = { folder_id: "allowed-folder", archived: false };
    allowed = false;
    await expect(validator({ actor, target: taskTarget })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("retains folder authorization when an offline persisted target skips live selection", async () => {
    const requireAvailable = vi.fn();
    const validator = createRecurringJobTargetValidator({
      registry: new InMemoryNodeRegistry(),
      modelPresetAvailability: { requireAvailable },
      listFolders: async () => [{ id: "allowed-folder" }, { id: "private-folder" }],
      findUserByEmail: async () => ({
        email: "member@example.com",
        isAdmin: false,
        allowedFolderIds: ["allowed-folder"],
      }),
    });

    await expect(validator({
      actor,
      target: target("allowed-folder"),
      requireAvailableTarget: true,
    })).rejects.toMatchObject({ code: "NODE_UNAVAILABLE" });
    await expect(validator({
      actor,
      target: target("allowed-folder"),
      requireAvailableTarget: false,
    })).resolves.toBeUndefined();
    await expect(validator({
      actor,
      target: target("private-folder"),
      requireAvailableTarget: false,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(requireAvailable).not.toHaveBeenCalled();
  });
});

function registry(): InMemoryNodeRegistry {
  const result = new InMemoryNodeRegistry();
  result.registerNode({
    type: "node_register",
    node_id: "node-a",
    agents: [{ id: "roselin", backend: "codex" }],
    model_presets: [{
      id: "codex-default",
      label: "Codex default",
      backend: "codex",
      available: true,
      usage_provider: null,
    }],
    supported_backends: ["codex"],
  });
  return result;
}

function target(folderId: string) {
  return {
    nodeId: "node-a",
    agentId: "roselin",
    modelPreset: "codex-default",
    container: { kind: "folder" as const, id: folderId },
    folderId,
  };
}
