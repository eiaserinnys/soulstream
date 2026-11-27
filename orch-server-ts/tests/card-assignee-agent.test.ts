import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InMemoryNodeRegistry } from "../src/node/registry.js";
import { registerCardRoutes } from "../src/cards/card_routes.js";
import { createCardAssigneeAgentEnricher } from "../src/cards/card_assignee_agent.js";
import type { FolderRouteOptions } from "../src/folders/folder_routes.js";
import { serializeSessionRow } from "../src/runtime/live_session_serialization.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const node = {
  nodeId: "node-1",
  agents: [{
    id: "roselin",
    name: "로젤린",
    backend: "claude",
    portrait_url: "https://example.test/roselin.png",
  }],
  modelPresets: [{ id: "opus", label: "Opus 4.6", backend: "anthropic" }],
};
const registry = {
  getConnectedNode: (nodeId: string) => nodeId === "node-1" ? node : undefined,
  listConnectedNodes: () => [node],
  getConnectedNodeAdvertised: (nodeId: string) => nodeId === "node-1" ? node : undefined,
  listConnectedNodesAdvertised: () => [node],
  getUserInfo: () => ({ name: null, hasPortrait: false }),
} as unknown as InMemoryNodeRegistry;

const createdAt = new Date("2026-11-19T00:00:00.000Z");

function cardRow(overrides: Record<string, unknown>) {
  return {
    id: "card",
    number: null,
    color: "slate",
    folder_id: "folder-1",
    position_key: "a",
    title: "카드",
    request: "요청",
    attachments: [],
    items: [],
    now: null,
    queue_position_key: null,
    brief: "",
    blocked_kind: null,
    blocked_detail: null,
    wake_at: null,
    waiting_for: null,
    limit_resume_session_id: null,
    limit_resume_at: null,
    node_id: null,
    model_preset: null,
    status: "todo",
    archived: false,
    version: 1,
    created_session_id: null,
    created_event_id: null,
    updated_session_id: null,
    updated_event_id: null,
    completed_kind: null,
    completed_session_id: null,
    completed_event_id: null,
    completed_user_id: null,
    completed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    assignee_kind: null,
    assignee_agent_id: null,
    assignee_session_id: null,
    assignee_user_id: null,
    ...overrides,
  };
}

const sessionCard = cardRow({
  id: "card-session",
  assignee_kind: "session",
  assignee_session_id: "session-1",
});
const agentCard = cardRow({
  id: "card-agent",
  assignee_kind: "agent",
  assignee_agent_id: "roselin",
  node_id: "node-1",
  model_preset: "opus",
});
const unassignedCard = cardRow({ id: "card-none" });

const sessionRow = {
  session_id: "session-1",
  card_id: "card-session",
  display_name: "담당 세션",
  node_id: "node-1",
  agent_id: "roselin",
  status: "running",
  created_at: createdAt,
  caller_session_id: null,
  updated_at: createdAt,
};

function setup() {
  const loadSessions = vi.fn(async (sessionIds: readonly string[]) =>
    sessionIds.includes("session-1")
      ? [{ session_id: "session-1", node_id: "node-1", agent_id: "roselin", model_preset: "opus" }]
      : []);
  const enricher = createCardAssigneeAgentEnricher({
    loadSessions,
    serializeSessions: (rows) => rows.map((row) => serializeSessionRow(row, {
      registry,
      agentProfiles: [],
      agentPortraitUrl: (agentId) => agentId === "roselin" ? `/api/agent-portraits/roselin?v=${"e".repeat(64)}` : "",
    })),
  });
  const detail = {
    card: sessionCard,
    reports: [],
    questions: [],
    comments: [],
    sessions: [sessionRow],
    notes: [],
    nowHistory: [],
  };
  const service = {
    listCards: vi.fn(async () => [sessionCard, agentCard, unassignedCard]),
    projectCards: vi.fn(async (cards: readonly unknown[]) => [...cards]),
    getCard: vi.fn(async () => detail),
    getFolder: vi.fn(async () => null),
  };
  const app = Fastify({ logger: false });
  apps.push(app);
  registerCardRoutes(app, {
    provider: { listFolders: () => [{ id: "folder-1" }] },
    accessProvider: { resolveAccess: () => ({ restricted: false }) },
    cardServiceProvider: async () => service,
    assigneeAgentEnricher: enricher,
  } as unknown as FolderRouteOptions);
  return { app, loadSessions, service };
}

describe("card assignee agent display", () => {
  it("fills the session assignee from its session and the agent assignee from the card", async () => {
    const { app, loadSessions } = setup();
    const response = await app.inject("/api/cards");
    expect(response.statusCode).toBe(200);
    const cards = response.json().cards as Array<Record<string, unknown>>;
    const byId = new Map(cards.map((card) => [card.id, card]));
    expect(byId.get("card-session")?.assigneeAgent).toEqual({
      agentId: "roselin",
      nodeId: "node-1",
      agentName: "로젤린",
      portraitUrl: `/api/agent-portraits/roselin?v=${"e".repeat(64)}`,
      modelPreset: "opus",
      modelLabel: "Opus 4.6",
    });
    expect(byId.get("card-agent")?.assigneeAgent).toEqual({
      agentId: "roselin",
      nodeId: "node-1",
      agentName: "로젤린",
      portraitUrl: `/api/agent-portraits/roselin?v=${"e".repeat(64)}`,
      modelPreset: "opus",
      modelLabel: "Opus 4.6",
    });
    expect(byId.get("card-none")?.assigneeAgent).toBeNull();
    expect(loadSessions).toHaveBeenCalledTimes(1);
    expect(loadSessions).toHaveBeenCalledWith(["session-1"]);
  });

  it("adds the assignee agent to the card and session display fields to the detail", async () => {
    const { app, loadSessions } = setup();
    const response = await app.inject("/api/cards/card-session");
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      card: Record<string, unknown>;
      sessions: Array<Record<string, unknown>>;
    };
    expect(body.card.assigneeAgent).toEqual({
      agentId: "roselin",
      nodeId: "node-1",
      agentName: "로젤린",
      portraitUrl: `/api/agent-portraits/roselin?v=${"e".repeat(64)}`,
      modelPreset: "opus",
      modelLabel: "Opus 4.6",
    });
    expect(body.sessions[0]).toMatchObject({
      sessionId: "session-1",
      agentName: "로젤린",
      agentPortraitUrl: `/api/agent-portraits/roselin?v=${"e".repeat(64)}`,
      modelPreset: "opus",
      modelLabel: "Opus 4.6",
      backend: "anthropic",
    });
    expect(loadSessions).toHaveBeenCalledTimes(1);
  });
});
