import { describe, expect, it, vi } from "vitest";

import {
  createLiveDbSqlResolver,
  type LivePostgresSql,
} from "../src/index.js";

describe("live Postgres SQL resolver", () => {
  it("matches the production pool ceiling and 30 second command timeout meaning", async () => {
    const end = vi.fn(async () => undefined);
    const sql = Object.assign(
      () => Promise.resolve([]),
      { end },
    ) as unknown as LivePostgresSql;
    const postgresFactory = vi.fn(() => sql);
    const resolver = createLiveDbSqlResolver({
      databaseUrl: "postgres://orch@localhost/orch",
      postgresFactory,
    });

    await expect(resolver.resolveSql()).resolves.toBe(sql);
    await expect(resolver.resolveSql()).resolves.toBe(sql);

    expect(postgresFactory).toHaveBeenCalledTimes(1);
    expect(postgresFactory).toHaveBeenCalledWith(
      "postgres://orch@localhost/orch",
      {
        max: 10,
        connection: { statement_timeout: 30_000 },
      },
    );

    await resolver.close();
    expect(end).toHaveBeenCalledWith({ timeout: 5 });
  });
});
