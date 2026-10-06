import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostSessionRow } from "../src/control_plane/repositories/session_read_repository.js";
import { PersistentSessionSettingsService } from "../src/session/persistent_session_settings_service.js";
import { registerPersistentSessionSettingsRoutes } from "../src/session/persistent_session_settings_routes.js";

type Instruction = {
  id: string;
  text: string;
  source_turns: string[];
  source_event_ids: number[];
  created_at: string;
  updated_at: string;
  status: "active" | "removed";
  origin: "extracted" | "agent" | "user";
};

const persistentOn = { type: "persistent_session", value: { enabled: true } };
const older: Instruction = {
  id: "instruction-old",
  text: "Keep answers short.",
  source_turns: ["T10"],
  source_event_ids: [10],
  created_at: "2026-10-01T10:00:00.000Z",
  updated_at: "2026-10-01T10:00:00.000Z",
  status: "active",
  origin: "extracted",
};
const newer: Instruction = {
  id: "instruction-new",
  text: "Use Korean by default.",
  source_turns: ["T12"],
  source_event_ids: [12],
  created_at: "2026-10-01T10:00:00.000Z",
  updated_at: "2026-10-02T10:00:00.000Z",
  status: "active",
  origin: "user",
};
const removed: Instruction = {
  ...older,
  id: "instruction-removed",
  status: "removed",
  updated_at: "2026-10-03T10:00:00.000Z",
};

describe("persistent instruction routes", () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it("lists active instructions by updated_at descending with the public fields only", async () => {
    harness.rows.set("pas-1", makeSession([older, newer, removed]));

    const response = await harness.app.inject({ method: "GET", url: "/api/persistent-sessions/pas-1/instructions" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      instructions: [
        {
          id: newer.id,
          text: newer.text,
          source_turns: newer.source_turns,
          created_at: newer.created_at,
          updated_at: newer.updated_at,
          origin: newer.origin,
        },
        {
          id: older.id,
          text: older.text,
          source_turns: older.source_turns,
          created_at: older.created_at,
          updated_at: older.updated_at,
          origin: older.origin,
        },
      ],
    });
    expect(harness.routeExisting).not.toHaveBeenCalled();
  });

  it("returns an empty list when metadata has no instruction entries", async () => {
    harness.rows.set("pas-1", makeSession([]));

    const response = await harness.app.inject({ method: "GET", url: "/api/persistent-sessions/pas-1/instructions" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ instructions: [] });
  });

  it("adds through the standard existing-session command envelope and returns the node item", async () => {
    const item: Instruction = { ...newer, id: "instruction-added", text: "Please keep the reply short.", origin: "user" };
    harness.results = [{ status: "ok", item }];

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/persistent-sessions/pas-1/instructions",
      payload: { text: "  Please keep the reply short.  " },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ instruction: item });
    expect(harness.routeExisting).toHaveBeenCalledWith({
      type: "apply_persistent_session_instructions",
      agentSessionId: "pas-1",
      origin: "user",
      ops: [{ op: "add", text: "Please keep the reply short.", source_turns: [], source_event_ids: [] }],
    }, { timeoutMs: 5_000 });
    expect(harness.sent).toEqual([{
      type: "apply_persistent_session_instructions",
      agentSessionId: "pas-1",
      origin: "user",
      ops: [{ op: "add", text: "Please keep the reply short.", source_turns: [], source_event_ids: [] }],
      requestId: "instructions-1",
    }]);
  });

  it("maps the node cap result to 409", async () => {
    harness.results = [{ status: "cap_reached" }];

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/persistent-sessions/pas-1/instructions",
      payload: { text: "Add one more rule." },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "cap_reached" });
  });

  it("rejects blank text and unknown POST keys with 400 before sending a command", async () => {
    const blank = await harness.app.inject({
      method: "POST",
      url: "/api/persistent-sessions/pas-1/instructions",
      payload: { text: "  " },
    });
    const unknown = await harness.app.inject({
      method: "POST",
      url: "/api/persistent-sessions/pas-1/instructions",
      payload: { text: "Add one more rule.", extra: true },
    });

    expect(blank.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
    expect(harness.routeExisting).not.toHaveBeenCalled();
  });

  it("updates text or status, including removed, and returns 404 for a missing instruction", async () => {
    const item: Instruction = { ...newer, status: "removed" };
    harness.results = [{ status: "ok", item }];

    const updated = await harness.app.inject({
      method: "PUT",
      url: "/api/persistent-sessions/pas-1/instructions/instruction-new",
      payload: { status: "removed" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ instruction: item });
    expect(harness.sent[0]).toEqual({
      type: "apply_persistent_session_instructions",
      agentSessionId: "pas-1",
      origin: "user",
      ops: [{ op: "update", id: "instruction-new", status: "removed" }],
      requestId: "instructions-1",
    });

    harness.results = [{ status: "not_found" }];
    const missing = await harness.app.inject({
      method: "PUT",
      url: "/api/persistent-sessions/pas-1/instructions/no-such-instruction",
      payload: { text: "Replacement text." },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects empty update bodies, blank text, and unknown PUT keys with 400", async () => {
    const base = "/api/persistent-sessions/pas-1/instructions/instruction-new";
    const empty = await harness.app.inject({ method: "PUT", url: base, payload: {} });
    const blank = await harness.app.inject({ method: "PUT", url: base, payload: { text: "  " } });
    const unknown = await harness.app.inject({ method: "PUT", url: base, payload: { status: "removed", extra: true } });

    expect([empty.statusCode, blank.statusCode, unknown.statusCode]).toEqual([400, 400, 400]);
    expect(harness.routeExisting).not.toHaveBeenCalled();
  });

  it("uses existing settings errors for missing and non-persistent sessions", async () => {
    harness.rows.set("ordinary", makeSession([], false));

    const missing = await harness.app.inject({ method: "GET", url: "/api/persistent-sessions/missing/instructions" });
    const ordinaryGet = await harness.app.inject({ method: "GET", url: "/api/persistent-sessions/ordinary/instructions" });
    const ordinaryPut = await harness.app.inject({ method: "PUT", url: "/api/persistent-sessions/ordinary", payload: {} });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "SESSION_NOT_FOUND" } });
    expect(ordinaryGet.statusCode).toBe(409);
    expect(ordinaryGet.json()).toMatchObject({ error: { code: "NOT_PERSISTENT" } });
    expect(ordinaryPut.statusCode).toBe(409);
    expect(ordinaryPut.json()).toMatchObject({ error: { code: "NOT_PERSISTENT" } });
  });
});

async function createHarness() {
  const rows = new Map<string, HostSessionRow>();
  rows.set("pas-1", makeSession([]));
  const sent: Array<Record<string, unknown>> = [];
  let results: Array<{ status: "ok" | "cap_reached" | "not_found"; item?: Instruction }> = [
    { status: "ok", item: newer },
  ];
  let sequence = 0;
  const routeExisting = vi.fn(async (payload: Record<string, unknown>, _options: unknown) => ({
    command: {
      message: { ...payload, requestId: `instructions-${++sequence}` },
    },
  }));
  const sendPendingCommand = vi.fn(async (routed: unknown) => {
    const message = (routed as { command: { message: Record<string, unknown> } }).command.message;
    sent.push(message);
    return {
      type: "persistent_session_instructions_applied",
      requestId: message.requestId,
      agentSessionId: message.agentSessionId,
      results,
    };
  });
  const service = new PersistentSessionSettingsService({
    reads: async () => ({
      getSession: async (sessionId) => rows.get(sessionId) ?? null,
      listPersistentSessions: async () => [],
    }),
    access: {
      requireSessionAccess: async () => undefined,
      requireFolderAccess: async () => undefined,
      resolveAccess: async () => ({ restricted: false, allowedFolderIds: [] }),
    } as never,
    catalog: { renameSession: async () => undefined } as never,
    commands: {
      router: { routeExistingSessionPendingCommand: routeExisting },
      bridge: { sendPendingCommand },
      timeoutMs: 5_000,
    } as never,
    createSession: async () => ({ status: 500, body: {} }) as never,
    presets: {} as never,
    profiles: { listAgentProfiles: async () => undefined },
  });
  const app = Fastify();
  registerPersistentSessionSettingsRoutes(app, { service });
  await app.ready();
  return {
    app,
    rows,
    sent,
    routeExisting,
    get results() { return results; },
    set results(value: typeof results) { results = value; },
  };
}

function makeSession(instructions: Instruction[], persistent = true): HostSessionRow {
  return {
    session_id: "pas-1",
    session_type: "claude",
    metadata: [
      ...(persistent ? [persistentOn] : []),
      { type: "persistent_instructions", value: instructions },
    ],
  } as unknown as HostSessionRow;
}
