import { describe, expect, it, vi } from "vitest";

import {
  createLivePushRegistrationRepository,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  readonly text: string;
  readonly values: unknown[];
};

describe("live push registration repository", () => {
  it("upserts the Python push_tokens key and refreshes token plus updated_at", async () => {
    const harness = createSqlHarness();
    const repository = createLivePushRegistrationRepository({
      sqlResolver: resolverFor(harness.sql),
    });

    await repository.upsertToken(
      "User@Example.com",
      "device-1",
      "ExponentPushToken[value]",
    );

    expect(harness.calls).toHaveLength(1);
    expect(normalizeSql(harness.calls[0]?.text)).toContain(
      "INSERT INTO push_tokens (user_email, device_id, expo_token, updated_at)",
    );
    expect(normalizeSql(harness.calls[0]?.text)).toContain(
      "ON CONFLICT (user_email, device_id)",
    );
    expect(normalizeSql(harness.calls[0]?.text)).toContain(
      "DO UPDATE SET expo_token = EXCLUDED.expo_token, updated_at = NOW()",
    );
    expect(harness.calls[0]?.values).toEqual([
      "User@Example.com",
      "device-1",
      "ExponentPushToken[value]",
    ]);
  });

  it("deletes only the Python user_email plus device_id registration key", async () => {
    const harness = createSqlHarness();
    const repository = createLivePushRegistrationRepository({
      sqlResolver: resolverFor(harness.sql),
    });

    await repository.deleteToken("User@Example.com", "device-1");

    expect(harness.calls).toHaveLength(1);
    expect(normalizeSql(harness.calls[0]?.text)).toContain(
      "DELETE FROM push_tokens WHERE user_email = ? AND device_id = ?",
    );
    expect(harness.calls[0]?.values).toEqual(["User@Example.com", "device-1"]);
  });
});

function createSqlHarness() {
  const calls: SqlCall[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return [];
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
