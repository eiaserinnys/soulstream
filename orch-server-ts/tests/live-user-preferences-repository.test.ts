import { describe, expect, it, vi } from "vitest";

import {
  createLiveUserPreferencesRepository,
  normalizeUserPreferences,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  readonly text: string;
  readonly values: unknown[];
};

describe("live user preferences repository", () => {
  it("reads the Python user_preferences row contract by email", async () => {
    const row = {
      email: "user@example.com",
      prefs: { appearance: "dark" },
      background_blob: Buffer.from("background"),
      background_mime: "image/png",
      updated_at: new Date("2026-07-10T00:00:00.000Z"),
    };
    const harness = createSqlHarness([[row]]);
    const repository = createLiveUserPreferencesRepository({
      sqlResolver: resolverFor(harness.sql),
    });

    await expect(repository.get("user@example.com")).resolves.toBe(row);
    expect(normalizeSql(harness.calls[0]?.text)).toContain(
      "SELECT email, prefs, background_blob, background_mime, updated_at FROM user_preferences WHERE email = ?",
    );
    expect(harness.calls[0]?.values).toEqual(["user@example.com"]);
  });

  it("returns null when Python would synthesize default preferences", async () => {
    const harness = createSqlHarness([[]]);
    const repository = createLiveUserPreferencesRepository({
      sqlResolver: resolverFor(harness.sql),
    });

    await expect(repository.get("missing@example.com")).resolves.toBeNull();
  });

  it("upserts prefs while preserving or clearing background columns by flag", async () => {
    const stored = {
      email: "user@example.com",
      prefs: { appearance: "dark" },
      background_blob: null,
      background_mime: null,
      updated_at: new Date("2026-07-10T00:00:00.000Z"),
    };
    const harness = createSqlHarness([[stored], [stored]]);
    const repository = createLiveUserPreferencesRepository({
      sqlResolver: resolverFor(harness.sql),
    });
    const prefs = normalizeUserPreferences({ appearance: "dark" });

    await expect(
      repository.put("user@example.com", prefs, { clearBackground: false }),
    ).resolves.toBe(stored);
    await repository.put("user@example.com", prefs, { clearBackground: true });

    const sql = normalizeSql(harness.calls[0]?.text);
    expect(sql).toContain(
      "INSERT INTO user_preferences (email, prefs, background_blob, background_mime, updated_at)",
    );
    expect(sql).toContain("VALUES (?, ?::jsonb, NULL, NULL, NOW())");
    expect(sql).toContain("ON CONFLICT (email) DO UPDATE SET prefs = EXCLUDED.prefs");
    expect(sql).toContain(
      "background_blob = CASE WHEN ? THEN NULL ELSE user_preferences.background_blob END",
    );
    expect(sql).toContain(
      "background_mime = CASE WHEN ? THEN NULL ELSE user_preferences.background_mime END",
    );
    expect(sql).toContain(
      "RETURNING email, prefs, background_blob, background_mime, updated_at",
    );
    expect(harness.calls[0]?.values).toEqual([
      "user@example.com",
      JSON.stringify(prefs),
      false,
      false,
    ]);
    expect(harness.calls[1]?.values).toEqual([
      "user@example.com",
      JSON.stringify(prefs),
      true,
      true,
    ]);
  });

  it("maps a Postgres foreign-key violation to the route contract", async () => {
    const error = Object.assign(new Error("missing user"), { code: "23503" });
    const sql = vi.fn(async () => {
      throw error;
    }) as unknown as LivePostgresSql;
    const repository = createLiveUserPreferencesRepository({
      sqlResolver: resolverFor(sql),
    });

    await expect(
      repository.put("missing@example.com", normalizeUserPreferences(null), {
        clearBackground: false,
      }),
    ).rejects.toMatchObject({ name: "ForeignKeyViolationError" });
  });
});

function createSqlHarness(results: readonly (readonly Record<string, unknown>[])[]) {
  const calls: SqlCall[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return results[calls.length - 1] ?? [];
  }) as unknown as LivePostgresSql;
  return { sql, calls };
}

function resolverFor(sql: LivePostgresSql) {
  return {
    resolveSql: vi.fn(async () => sql),
    close: vi.fn(async () => undefined),
  };
}

function normalizeSql(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
