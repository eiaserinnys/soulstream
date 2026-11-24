import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { ModelCatalogSchema } from "@soulstream/model-catalog";
import { PERSISTENT_FALLBACK_MODELS_MAX } from "@soulstream/wire-schema/persistent-session-settings";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";
import { PersistentDefaultsSettings } from "../src/settings/persistent_defaults_settings.js";
import { registerPersistentDefaultsRoutes } from "../src/admin/persistent_defaults_routes.js";

const original = repositoryModelCatalog().snapshot();
const ids = original.presets.map(p => p.id);
const value = { model_preset: ids[0]!, fallback_models: [{ model_preset: ids[1]!, reasoning_effort: null }] };

function harness() {
  let row: { value: unknown; version: number | string } | undefined;
  let fail = false;
  const sql = Object.assign(async (strings: TemplateStringsArray, ...args: unknown[]) => {
    if (fail) throw new Error("database down");
    const query = strings.join("?");
    if (query.includes("SELECT")) return row ? [row] : [];
    if (query.includes("INSERT")) {
      if (row) return [];
      row = { value: args[0], version: 1 };
      return [row];
    }
    if (query.includes("UPDATE")) {
      if (!row || Number(row.version) !== args[2]) return [];
      row = { value: args[0], version: String(Number(row.version) + 1) };
      return [row];
    }
    throw new Error(query);
  }, { json: (v: unknown) => v });
  let catalog = original;
  const source = { snapshot: () => catalog };
  const warn = vi.fn();
  const service = new PersistentDefaultsSettings(async () => sql as never, source, warn);
  return { service, warn, setCatalog: (v: typeof catalog) => { catalog = v; },
    setRow: (v: typeof row) => { row = v; }, setFail: (v: boolean) => { fail = v; } };
}

afterEach(() => vi.useRealTimers());
describe("persistent global defaults", () => {
  it("reads catalogue when absent, saves with CAS, refreshes, and keeps cache on failure", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.service.start();
    expect(await h.service.get()).toMatchObject({ version: 0, source: "catalog", value: { model_preset: original.persistent_defaults.model_preset, fallback_models: original.persistent_defaults.fallback_models } });
    expect(await h.service.put({ value, expectedVersion: 0, updatedBy: "admin" })).toEqual({ value, version: 1, source: "settings" });
    expect(h.service.snapshot().persistent_defaults).toMatchObject(value);
    await expect(h.service.put({ value, expectedVersion: 0, updatedBy: "admin" })).rejects.toMatchObject({ statusCode: 409 });
    expect(await h.service.put({ value, expectedVersion: 1, updatedBy: "admin" })).toEqual({ value, version: 2, source: "settings" });
    expect(await h.service.get()).toEqual({ value, version: 2, source: "settings" });
    h.setRow({ value: { model_preset: ids[1], fallback_models: [] }, version: 2 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.service.snapshot().persistent_defaults.model_preset).toBe(ids[1]);
    h.setFail(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.service.snapshot().persistent_defaults.model_preset).toBe(ids[1]);
    expect(await h.service.get()).toMatchObject({ value: { model_preset: ids[1] }, version: 2, source: "settings" });
    expect(h.warn).toHaveBeenCalled();
    h.service.close();
  });

  it("starts with catalogue defaults if the first database read fails", async () => {
    const h = harness();
    h.setFail(true);
    await h.service.start();
    expect(h.service.snapshot()).toEqual(original);
    expect(await h.service.get()).toMatchObject({ value: { model_preset: original.persistent_defaults.model_preset }, version: 0, source: "catalog" });
    expect(h.warn).toHaveBeenCalled();
    h.service.close();
  });

  it("accepts the shared fallback limit and rejects one more distinct preset", async () => {
    const h = harness();
    const fallbacks = ids.slice(1, PERSISTENT_FALLBACK_MODELS_MAX + 2)
      .map(model_preset => ({ model_preset, reasoning_effort: null }));
    expect(fallbacks).toHaveLength(PERSISTENT_FALLBACK_MODELS_MAX + 1);
    const atLimit = { model_preset: ids[0]!, fallback_models: fallbacks.slice(0, PERSISTENT_FALLBACK_MODELS_MAX) };
    await expect(h.service.put({ value: atLimit, expectedVersion: 0, updatedBy: "admin" })).resolves.toMatchObject({ value: atLimit });
    const tooMany = { ...atLimit, fallback_models: fallbacks };
    await expect(h.service.put({ value: tooMany, expectedVersion: 1, updatedBy: "admin" })).rejects.toMatchObject({ statusCode: 422 });
    h.setRow({ value: tooMany, version: 2 });
    await h.service.refresh();
    expect(h.service.snapshot().persistent_defaults).toEqual(original.persistent_defaults);
  });

  it("refreshes a stale version after a conflicting write", async () => {
    const h = harness();
    await h.service.start();
    await h.service.put({ value, expectedVersion: 0, updatedBy: "admin" });
    const other = { model_preset: ids[1]!, fallback_models: [] };
    h.setRow({ value: other, version: 2 });
    await expect(h.service.put({ value, expectedVersion: 1, updatedBy: "admin" })).rejects.toMatchObject({ statusCode: 409 });
    expect(await h.service.get()).toEqual({ value: other, version: 2, source: "settings" });
    h.service.close();
  });

  it("validates stored and catalogue values by the same rules and falls back when a preset disappears", async () => {
    const h = harness();
    await h.service.start();
    for (const invalid of [
      { model_preset: "missing", fallback_models: [] },
      { model_preset: ids[0], fallback_models: [{ model_preset: ids[0], reasoning_effort: null }] },
      { model_preset: ids[0], fallback_models: [{ model_preset: ids[1], reasoning_effort: "not-supported" }] },
      { model_preset: ids[0], fallback_models: Array.from({ length: 9 }, () => ({ model_preset: ids[1], reasoning_effort: null })) },
    ]) {
      await expect(h.service.put({ value: invalid, expectedVersion: 0, updatedBy: "admin" })).rejects.toMatchObject({ statusCode: 422 });
      expect(ModelCatalogSchema.safeParse({ ...original, persistent_defaults: invalid }).success).toBe(false);
    }
    await h.service.put({ value, expectedVersion: 0, updatedBy: "admin" });
    h.setCatalog({ ...original, presets: original.presets.filter(p => p.id !== ids[0]) });
    expect(h.service.snapshot().persistent_defaults).toEqual(original.persistent_defaults);
    expect(h.warn).toHaveBeenCalled();
    h.service.close();
  });

  it("protects admin routes and returns 422 and 409 for invalid and stale writes", async () => {
    const h = harness();
    const app = Fastify();
    let email: string | null = null;
    registerPersistentDefaultsRoutes(app, { currentEmail: () => email, isAdminEmail: e => e === "admin@example.com", service: h.service, resolveCaller: async () => null });
    const url = "/api/admin/settings/persistent-defaults";
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    email = "other@example.com";
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(403);
    email = "admin@example.com";
    expect((await app.inject({ method: "PUT", url, payload: { value: {}, expectedVersion: 0 } })).statusCode).toBe(422);
    const saved = await app.inject({ method: "PUT", url, payload: { value, expectedVersion: 0 } });
    expect(saved.json()).toEqual({ value, version: 1, source: "settings" });
    expect((await app.inject({ method: "PUT", url, payload: { value, expectedVersion: 0 } })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url })).json()).toEqual(saved.json());
    await app.close();
  });
});
