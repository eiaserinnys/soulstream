import postgres from "postgres";
import { expect, inject, it } from "vitest";

import { provisionTestDatabase, type TestDatabaseLease } from "./database_test_harness.js";

it("uses the supplied server for isolated leases and drops only the released database", async () => {
  const adminUrl = process.env.TEST_DATABASE_URL?.trim() || inject("sharedPostgresTestUrl");
  const options = {
    prefix: "lease",
    dockerUser: "lease_test",
    dockerPassword: "lease_test",
    dockerDatabase: "lease_test",
  };
  const first = await provisionTestDatabase(options);
  let second: TestDatabaseLease | undefined;
  try {
    try {
      second = await provisionTestDatabase({ ...options, dockerDatabase: "lease_second_test" });
    } finally {
      await first.cleanup();
    }

    const firstUrl = new URL(first.url);
    const secondUrl = new URL(second.url);
    if (adminUrl) {
      expect([firstUrl.host, secondUrl.host]).toEqual([new URL(adminUrl).host, new URL(adminUrl).host]);
    } else {
      expect(firstUrl.host).not.toBe(secondUrl.host);
    }
    expect(firstUrl.pathname).not.toBe(secondUrl.pathname);

    const sql = postgres(second.url, { max: 1 });
    try {
      const databases = await sql`
        SELECT datname FROM pg_database
        WHERE datname IN (${firstUrl.pathname.slice(1)}, ${secondUrl.pathname.slice(1)})
      `;
      expect(databases).toEqual([{ datname: secondUrl.pathname.slice(1) }]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    await second?.cleanup();
  }
});
