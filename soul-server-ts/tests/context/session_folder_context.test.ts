import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { compileContexts, type ContextFilterParameters } from "../../src/context/compiler/index.js";
import type { AtomFetchConfig } from "../../src/context/atom_context.js";
import { buildContextFilterParameters } from "../../src/context/context_builder_helpers.js";
import { resolvePrimarySessionFolderContext } from "../../src/context/session_folder_context.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { Task } from "../../src/task/task_models.js";

const logger = pino({ level: "silent" });
const config: AtomFetchConfig = { enabled: true, serverUrl: "https://atom.test", apiKey: "key" };
const agent = { id: "roselin", name: "roselin", backend: "codex", workspace_dir: "/tmp/roselin" } as AgentProfile;
const task = { agentSessionId: "session-1", prompt: "p", status: "running", profileId: "roselin",
  createdAt: new Date(), lastEventId: 0, lastReadEventId: 0, interventionQueue: [] } as Task;

function dbWith(session: Record<string, unknown>, card: Record<string, unknown> | null) {
  return {
    getSession: vi.fn().mockResolvedValue({ folder_id: "folder-1", card_id: card ? "card-1" : null, ...session }),
    getFolderById: vi.fn().mockResolvedValue({ id: "folder-1", name: "폴더" }),
    getCard: vi.fn().mockResolvedValue({ card: { id: "card-1", folderId: "folder-1", title: "카드", status: "running", ...card } }),
  } as unknown as SessionDB;
}

describe("card role in the session information", () => {
  it.each([
    ["the card's assignee session is this session", { agent_id: "roselin", caller_session_id: "caller" },
      { assigneeSessionId: "session-1", assigneeKind: "session", assigneeAgentId: "roselin" }, "assignee"],
    ["a just-created automatic-assignment session has no assignee yet, matches the agent, and has no caller", { agent_id: "roselin", caller_session_id: null },
      { assigneeSessionId: null, assigneeKind: "agent", assigneeAgentId: "roselin" }, "assignee"],
    ["a work session attached by a caller while the card has no assignee session", { agent_id: "roselin", caller_session_id: "assignee-session" },
      { assigneeSessionId: null, assigneeKind: "agent", assigneeAgentId: "roselin" }, "member"],
    ["the card is assigned to another session", { agent_id: "roselin", caller_session_id: null },
      { assigneeSessionId: "other-session", assigneeKind: "session", assigneeAgentId: "roselin" }, "member"],
    ["the unassigned card belongs to another agent", { agent_id: "roselin", caller_session_id: null },
      { assigneeSessionId: null, assigneeKind: "agent", assigneeAgentId: "seosoyoung" }, "member"],
    ["the unassigned card is assigned to a human", { agent_id: "roselin", caller_session_id: null },
      { assigneeSessionId: null, assigneeKind: "human", assigneeAgentId: null }, "member"],
  ])("resolves the role when %s", async (_name, session, card, role) => {
    const context = await resolvePrimarySessionFolderContext(dbWith(session, card), logger, "session-1");
    expect(context?.card).toEqual({ id: "card-1", title: "카드", status: "running", role });
    expect(context).not.toHaveProperty("cardGuidance");
    expect(context).not.toHaveProperty("folderGuidance");
  });

  it("has no card for a session without one", async () => {
    const context = await resolvePrimarySessionFolderContext(dbWith({ agent_id: "roselin" }, null), logger, "session-1");
    expect(context).toEqual({ folder: { id: "folder-1", title: "폴더" }, card: null });
  });
});

describe("applies_when card_role through the real session-to-compile path", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ markdown: "# included" }), { status: 200 })) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  async function statusFor(db: SessionDB): Promise<string | undefined> {
    const primaryFolder = await resolvePrimarySessionFolderContext(db, logger, "session-1");
    const parameters: ContextFilterParameters = buildContextFilterParameters({ task, agent, nodeId: "eiaserinnys", primaryFolder }, "linux");
    const compiled = await compileContexts(config, [{
      nodeId: "node-assignee-only", depth: 1, titlesOnly: false, appliesWhen: { card_role: ["assignee"] },
    }], logger, parameters);
    return compiled.manifest.sources[0]?.status;
  }

  it("includes the source only for an assignee session and filters members and sessions without a card", async () => {
    const assignee = dbWith({ agent_id: "roselin" }, { assigneeSessionId: "session-1" });
    const member = dbWith({ agent_id: "roselin", caller_session_id: "assignee-session" }, { assigneeSessionId: "assignee-session" });
    const noCard = dbWith({ agent_id: "roselin" }, null);
    expect(await statusFor(assignee)).toBe("ok");
    expect(await statusFor(member)).toBe("filtered");
    expect(await statusFor(noCard)).toBe("filtered");
  });

  it("puts card_role into the filter parameters only when the session has a card", async () => {
    const withCard = await resolvePrimarySessionFolderContext(dbWith({ agent_id: "roselin" }, { assigneeSessionId: "session-1" }), logger, "session-1");
    const withoutCard = await resolvePrimarySessionFolderContext(dbWith({ agent_id: "roselin" }, null), logger, "session-1");
    expect(buildContextFilterParameters({ task, agent, nodeId: "n", primaryFolder: withCard }, "linux")).toMatchObject({ card_role: "assignee" });
    expect(buildContextFilterParameters({ task, agent, nodeId: "n", primaryFolder: withoutCard }, "linux")).not.toHaveProperty("card_role");
  });

  it("warns and ignores a card_role value other than assignee or member", async () => {
    const warn = vi.fn();
    const compiled = await compileContexts(config, [{
      nodeId: "node-bad-role", depth: 1, titlesOnly: false, appliesWhen: { card_role: ["owner"] },
    }], { warn }, { node_id: "eiaserinnys" });
    expect(compiled.manifest.sources[0]).toMatchObject({ status: "ok" });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ field: "card_role", value: "owner" }),
      "[context compiler] unknown applies_when value — ignoring condition",
    );
  });
});
