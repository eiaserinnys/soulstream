import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";
import {
  SUMMARY_SETTINGS_OFF,
  SummarySettings,
  isSelectableSummaryPreset,
  seedSummarySettings,
  type SummarySettingsValue,
} from "../src/settings/summary_settings.js";
import { registerSummarySettingsRoutes } from "../src/admin/summary_settings_routes.js";
import { OPERATING_SUMMARY_SETTINGS } from "./helpers/summary_settings.js";

type Row = { value: unknown; version: number | string; updated_at: Date; updated_by: string };

const catalog = repositoryModelCatalog();
const presets = catalog.snapshot().presets;

/** In-memory stand-in for the system_settings row of summary_settings. */
function harness() {
  let row: Row | undefined;
  let fail = false;
  const sql = Object.assign(async (strings: TemplateStringsArray, ...args: unknown[]) => {
    if (fail) throw new Error("database down");
    const query = strings.join("?");
    if (query.includes("SELECT")) return row ? [{ ...row }] : [];
    if (query.includes("INSERT")) {
      if (row) return [];
      const [, value, actor] = args as [string, unknown, string];
      row = { value, version: 1, updated_at: new Date("2026-11-27T09:00:00.000Z"), updated_by: actor };
      return [{ ...row }];
    }
    if (query.includes("UPDATE")) {
      const [value, actor, , expected] = args as [unknown, string, string, number];
      if (!row || Number(row.version) !== expected) return [];
      row = { value, version: Number(row.version) + 1, updated_at: new Date("2026-11-27T10:00:00.000Z"), updated_by: actor };
      return [{ ...row }];
    }
    throw new Error(query);
  }, { json: (value: unknown) => value });
  const warn = vi.fn();
  const settings = new SummarySettings(async () => sql as never, catalog, warn);
  return {
    sql: sql as never, settings, warn,
    setRow: (value: Row | undefined) => { row = value; },
    setFail: (value: boolean) => { fail = value; },
    row: () => row,
  };
}

const put = (h: ReturnType<typeof harness>, value: unknown, expectedVersion = 0) =>
  h.settings.put({ value, expectedVersion, updatedBy: "Admin@Example.com" });

afterEach(() => vi.useRealTimers());

describe("summary settings store", () => {
  it("reads as both off with empty lists when no row exists", async () => {
    const h = harness();
    await h.settings.start();
    expect(h.settings.current()).toEqual(SUMMARY_SETTINGS_OFF);
    expect(await h.settings.get()).toMatchObject({
      value: { turn: { enabled: false, model_presets: [] }, session: { enabled: false, model_presets: [] } },
      version: 0, source: "default", updated_at: null, updated_by: null,
    });
    h.settings.close();
  });

  it("saves with a version check, answers 409 when stale, and applies a save at once", async () => {
    const h = harness();
    await h.settings.start();
    const saved = await put(h, OPERATING_SUMMARY_SETTINGS);
    expect(saved).toMatchObject({
      value: OPERATING_SUMMARY_SETTINGS, version: 1, source: "settings",
      updated_by: "admin@example.com", updated_at: "2026-11-27T09:00:00.000Z",
    });
    expect(h.settings.current()).toEqual(OPERATING_SUMMARY_SETTINGS);
    await expect(put(h, OPERATING_SUMMARY_SETTINGS, 0)).rejects.toMatchObject({ statusCode: 409 });
    const next: SummarySettingsValue = { ...OPERATING_SUMMARY_SETTINGS, session: { enabled: false, model_presets: [] } };
    expect(await put(h, next, 1)).toMatchObject({ version: 2, value: next });
    expect(h.settings.current().session.enabled).toBe(false);
    expect(h.settings.current().turn.enabled).toBe(true);
  });

  it("picks up a changed row at the next 30 second refresh and keeps the cache while the database is down", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.settings.start();
    h.setRow({ value: OPERATING_SUMMARY_SETTINGS, version: 3, updated_at: new Date(), updated_by: "x" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.settings.current()).toEqual(OPERATING_SUMMARY_SETTINGS);
    h.setFail(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.settings.current()).toEqual(OPERATING_SUMMARY_SETTINGS);
    expect(h.warn).toHaveBeenCalled();
    h.settings.close();
  });

  it("keeps summaries off and warns when the stored value is malformed", async () => {
    const h = harness();
    h.setRow({ value: { turn: { enabled: "yes" } }, version: 1, updated_at: new Date(), updated_by: "x" });
    await h.settings.start();
    expect(h.settings.current()).toEqual(SUMMARY_SETTINGS_OFF);
    expect(h.warn).toHaveBeenCalledTimes(1);
    h.settings.current();
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  describe("validation", () => {
    const section = (enabled: boolean, model_presets: string[]) => ({ enabled, model_presets });
    const rejected = async (value: unknown, text: RegExp) => {
      const h = harness();
      await h.settings.start();
      await expect(put(h, value)).rejects.toMatchObject({ statusCode: 400, code: "SUMMARY_SETTINGS_INVALID", message: expect.stringMatching(text) });
      expect(h.row()).toBeUndefined();
    };
    const off = section(false, []);

    it("rejects an unknown preset", () => rejected({ turn: section(true, ["nope"]), session: off }, /턴 요약.*nope/));
    it("rejects a duplicate in one list", () => rejected({ turn: section(true, ["codex-5.6-luna", "codex-5.6-luna"]), session: off }, /두 번/));
    it("rejects more than five models", () => rejected({
      turn: section(true, ["claude-sonnet", "gemini-4-hydrogen", "codex-5.6-luna", "codex-5.6-terra", "codex-6.2-sol", "codex-6.1-sol"]), session: off,
    }, /5개/));
    it("rejects opencode presets", () => rejected({ turn: section(true, ["opencode-deepseek-v4.1-flash-free"]), session: off }, /쓸 수 없습니다/));
    it("rejects claude presets that call another provider through env", () => rejected({ turn: off, session: section(true, ["kimi-2"]) }, /세션 요약.*쓸 수 없습니다/));
    it("rejects turning a part on with an empty list", () => rejected({ turn: off, session: section(true, []) }, /세션 요약.*하나 이상/));
    it("rejects a value with a missing part or an extra key", async () => {
      await rejected({ turn: off }, /session/);
      await rejected({ turn: off, session: off, extra: 1 }, /./);
    });

    it("accepts an off part with a list, and the same model in both parts", async () => {
      const h = harness();
      await h.settings.start();
      const value = { turn: section(false, ["codex-5.6-luna"]), session: section(true, ["codex-5.6-luna"]) };
      expect(await put(h, value)).toMatchObject({ value });
    });

    it("rejects a bad version", async () => {
      const h = harness();
      await h.settings.start();
      await expect(put(h, { turn: off, session: off }, -1)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it("accepts claude presets whose env only tunes the CLI, and no preset that points at another provider", () => {
    const selectable = presets.filter(isSelectableSummaryPreset).map(preset => preset.id);
    expect(selectable).toEqual(expect.arrayContaining(["claude-sonnet", "claude-haiku", "gemini-4-hydrogen", "codex-5.6-luna"]));
    expect(selectable).not.toEqual(expect.arrayContaining(["kimi-2"]));
    expect(selectable).not.toContain("deepseek-flash-4.1");
    expect(selectable).not.toContain("opencode-deepseek-v4.1-flash-free");
  });

  it("offers the selectable preset ids with the value", async () => {
    const h = harness();
    await h.settings.start();
    const { selectable_preset_ids } = await h.settings.get();
    expect(selectable_preset_ids).toContain("claude-sonnet");
    expect(selectable_preset_ids).not.toContain("kimi-3");
  });
});

describe("summary settings first-run seed", () => {
  it("inserts the value once, logs it, and leaves an existing row alone", async () => {
    const h = harness();
    const info = vi.fn();
    await seedSummarySettings(h.sql, catalog, OPERATING_SUMMARY_SETTINGS, info);
    expect(info).toHaveBeenCalledWith(OPERATING_SUMMARY_SETTINGS);
    expect(h.row()).toMatchObject({ value: OPERATING_SUMMARY_SETTINGS, version: 1, updated_by: "system:summary-settings-seed" });

    const other = harness();
    other.setRow({ value: SUMMARY_SETTINGS_OFF, version: 4, updated_at: new Date(), updated_by: "admin" });
    const quiet = vi.fn();
    await seedSummarySettings(other.sql, catalog, OPERATING_SUMMARY_SETTINGS, quiet);
    expect(other.row()).toMatchObject({ value: SUMMARY_SETTINGS_OFF, version: 4 });
    expect(quiet).not.toHaveBeenCalled();
  });

  it("refuses to store a seed the catalogue would reject", async () => {
    const h = harness();
    await expect(seedSummarySettings(h.sql, catalog, {
      turn: { enabled: true, model_presets: ["missing"] }, session: SUMMARY_SETTINGS_OFF.session,
    }, vi.fn())).rejects.toThrow(/missing/);
    expect(h.row()).toBeUndefined();
  });
});

describe("summary settings admin API", () => {
  const url = "/api/admin/settings/summaries";
  async function app(adminEmail: string | null = "admin@example.com") {
    const h = harness();
    await h.settings.start();
    const server = Fastify();
    registerSummarySettingsRoutes(server, {
      currentEmail: () => adminEmail, isAdminEmail: email => email === "admin@example.com", service: h.settings,
    });
    return { server, h };
  }

  it("serves the default, saves, and returns the new value with its version", async () => {
    const { server, h } = await app();
    const first = await server.inject({ method: "GET", url });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ source: "default", version: 0, value: SUMMARY_SETTINGS_OFF, updated_at: null, updated_by: null });

    const saved = await server.inject({ method: "PUT", url, payload: { value: OPERATING_SUMMARY_SETTINGS, expectedVersion: 0 } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ source: "settings", version: 1, value: OPERATING_SUMMARY_SETTINGS, updated_by: "admin@example.com" });
    expect((await server.inject({ method: "GET", url })).json()).toEqual(saved.json());
    expect(h.settings.current()).toEqual(OPERATING_SUMMARY_SETTINGS);
    await server.close();
  });

  it("answers 400 with the reason, 409 when stale, and 403 to a non-admin", async () => {
    const { server } = await app();
    const bad = await server.inject({ method: "PUT", url, payload: {
      value: { turn: { enabled: true, model_presets: [] }, session: { enabled: false, model_presets: [] } }, expectedVersion: 0,
    } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().detail.error).toMatchObject({ code: "SUMMARY_SETTINGS_INVALID", message: expect.stringContaining("턴 요약") });
    expect((await server.inject({ method: "PUT", url, payload: "nope", headers: { "content-type": "application/json" } })).statusCode).toBe(400);

    const ok = { value: OPERATING_SUMMARY_SETTINGS };
    expect((await server.inject({ method: "PUT", url, payload: { ...ok, expectedVersion: 0 } })).statusCode).toBe(200);
    const stale = await server.inject({ method: "PUT", url, payload: { ...ok, expectedVersion: 0 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().detail.error.code).toBe("SUMMARY_SETTINGS_CONFLICT");
    await server.close();

    const other = await app("other@example.com");
    expect((await other.server.inject({ method: "GET", url })).statusCode).toBe(403);
    expect((await other.server.inject({ method: "PUT", url, payload: { ...ok, expectedVersion: 0 } })).statusCode).toBe(403);
    await other.server.close();
  });
});
