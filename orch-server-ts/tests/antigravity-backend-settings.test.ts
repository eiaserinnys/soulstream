import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  ANTIGRAVITY_ACKNOWLEDGEMENT,
  AntigravityBackendSettings,
  seedAntigravityBackend,
} from "../src/settings/antigravity_backend_settings.js";
import { registerAntigravityBackendRoutes } from "../src/admin/antigravity_backend_routes.js";

type Row = { value: { enabled: boolean; acknowledged_at?: string }; version: number };

/** In-memory stand-in for system_settings plus the two tables the seed looks at. */
function database(initial: { row?: Row; sessionPresets?: string[]; profilePresets?: string[] } = {}) {
  const state = { row: initial.row, sessionPresets: initial.sessionPresets ?? [], profilePresets: initial.profilePresets ?? [] };
  const sql = Object.assign(async (strings: TemplateStringsArray, ...args: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("FROM sessions")) {
      if (state.row) return [];
      const ids = args[1] as string[];
      const enabled = state.sessionPresets.some(id => ids.includes(id)) || state.profilePresets.some(id => ids.includes(id));
      state.row = { value: { enabled }, version: 1 };
      return [{ value: state.row.value }];
    }
    if (query.includes("SELECT value, version")) return state.row ? [{ ...state.row }] : [];
    if (query.includes("INSERT")) {
      if (state.row) return [];
      state.row = { value: args[1] as Row["value"], version: 1 };
      return [{ ...state.row }];
    }
    if (query.includes("UPDATE")) {
      if (!state.row || state.row.version !== args[3]) return [];
      state.row = { value: args[0] as Row["value"], version: state.row.version + 1 };
      return [{ ...state.row }];
    }
    throw new Error(query);
  }, { json: (value: unknown) => value });
  return { sql: sql as never, state };
}

const agyPresets = ["gemini-4-neon", "gemini-4-carbon"];

describe("startup seed of the Antigravity switch", () => {
  it("starts off on an empty database", async () => {
    const db = database();
    const info = vi.fn();
    await seedAntigravityBackend(db.sql, agyPresets, info);
    const settings = new AntigravityBackendSettings(async () => db.sql, vi.fn());
    await settings.start();
    expect(settings.enabled()).toBe(false);
    expect(await settings.get()).toMatchObject({ value: { enabled: false }, version: 1, source: "settings" });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("enabled=false"));
    settings.close();
  });

  it.each([
    ["a session", { sessionPresets: ["gemini-4-neon"] }],
    ["an agent profile", { profilePresets: ["gemini-4-carbon"] }],
  ])("starts on when %s already uses an Antigravity preset", async (_name, existing) => {
    const db = database(existing);
    await seedAntigravityBackend(db.sql, agyPresets, vi.fn());
    const settings = new AntigravityBackendSettings(async () => db.sql, vi.fn());
    await settings.start();
    expect(settings.enabled()).toBe(true);
    settings.close();
  });

  it("leaves an existing row alone", async () => {
    const db = database({ row: { value: { enabled: false }, version: 4 }, sessionPresets: ["gemini-4-neon"] });
    const info = vi.fn();
    await seedAntigravityBackend(db.sql, agyPresets, info);
    expect(db.state.row).toEqual({ value: { enabled: false }, version: 4 });
    expect(info).not.toHaveBeenCalled();
  });

  it("reads as off without a row", async () => {
    const settings = new AntigravityBackendSettings(async () => database().sql, vi.fn());
    await settings.start();
    expect(settings.enabled()).toBe(false);
    expect(await settings.get()).toEqual({ value: { enabled: false }, version: 0, source: "default" });
    settings.close();
  });
});

describe("Antigravity switch admin API", () => {
  async function app(adminEmail: string | null = "admin@example.com") {
    const db = database();
    const settings = new AntigravityBackendSettings(async () => db.sql, vi.fn());
    await settings.start();
    const server = Fastify();
    registerAntigravityBackendRoutes(server, {
      currentEmail: () => adminEmail, isAdminEmail: email => email === "admin@example.com", service: settings,
    });
    return { server, settings };
  }
  const url = "/api/admin/settings/antigravity-backend";

  it("requires the exact acknowledgement to turn on, and nothing to turn off", async () => {
    const { server, settings } = await app();
    const missing = await server.inject({ method: "PUT", url, payload: { value: { enabled: true }, expectedVersion: 0 } });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().detail.error.code).toBe("ANTIGRAVITY_ACKNOWLEDGEMENT_REQUIRED");
    const wrong = await server.inject({ method: "PUT", url, payload: { value: { enabled: true, acknowledgement: "인지" }, expectedVersion: 0 } });
    expect(wrong.statusCode).toBe(422);
    expect(settings.enabled()).toBe(false);

    const on = await server.inject({ method: "PUT", url, payload: { value: { enabled: true, acknowledgement: ANTIGRAVITY_ACKNOWLEDGEMENT }, expectedVersion: 0 } });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ value: { enabled: true, acknowledged_at: expect.any(String) }, version: 1 });
    expect(settings.enabled()).toBe(true);
    expect((await server.inject({ method: "GET", url })).json()).toEqual(on.json());

    const off = await server.inject({ method: "PUT", url, payload: { value: { enabled: false }, expectedVersion: 1 } });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ value: { enabled: false }, version: 2 });
    expect(settings.enabled()).toBe(false);
    await server.close();
  });

  it("answers 409 when the version is stale and 403 to a non-admin", async () => {
    const { server } = await app();
    const first = await server.inject({ method: "PUT", url, payload: { value: { enabled: false }, expectedVersion: 0 } });
    expect(first.statusCode).toBe(200);
    const stale = await server.inject({ method: "PUT", url, payload: { value: { enabled: true, acknowledgement: ANTIGRAVITY_ACKNOWLEDGEMENT }, expectedVersion: 0 } });
    expect(stale.statusCode).toBe(409);
    await server.close();
    const other = await app("other@example.com");
    expect((await other.server.inject({ method: "GET", url })).statusCode).toBe(403);
    await other.server.close();
  });
});
