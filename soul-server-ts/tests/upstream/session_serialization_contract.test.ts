import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { Task } from "../../src/task/task_models.js";
import { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const CONTRACT_PATH = fileURLToPath(
  new URL(
    "../../../packages/wire-schema/fixtures/session_serialization_contract.json",
    import.meta.url,
  ),
);

function loadCase(): Record<string, any> {
  const data = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
  return data.cases[0];
}

function taskFromFixture(raw: Record<string, any>): Task {
  return {
    agentSessionId: raw.agentSessionId,
    prompt: raw.prompt,
    status: raw.status,
    createdAt: new Date(raw.createdAt),
    lastEventId: raw.lastEventId,
    lastReadEventId: raw.lastReadEventId,
    profileId: raw.profileId,
    callerSessionId: raw.callerSessionId,
    metadata: raw.metadata,
    callerInfo: raw.callerInfo,
    interventionQueue: [],
  };
}

describe("session serialization contract fixture", () => {
  it("SessionBroadcaster session_created.session matches the shared fixture", async () => {
    const fixture = loadCase();
    const send = vi.fn().mockResolvedValue(undefined);
    const broadcaster = new SessionBroadcaster(
      send,
      new AgentRegistry([fixture.nodeAgentProfile]),
      fixture.nodeId,
    );

    await broadcaster.emitSessionCreated(
      taskFromFixture(fixture.nodeTask),
      fixture.folderId,
    );

    const message = send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(message.type).toBe("session_created");
    expect(message.session).toEqual(fixture.expectedNodeSessionInfo);
  });
});
