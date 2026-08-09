import { execFileSync, spawnSync } from "node:child_process";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  classifyLedgerReconciliation,
  inspectUserObjectInventory,
} from "../../../packages/db-schema/scripts/database-release-journal.mjs";
import { classifyDatabaseOperation } from
  "../../../packages/db-schema/scripts/release-executor.mjs";

const hasDocker = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const externalDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
const hasTestDatabase = Boolean(externalDatabaseUrl) || hasDocker;
const describeWithTestDatabase = hasTestDatabase ? describe : describe.skip;
const CONTAINER = "soul-release-inventory-review";
const USER = "release_inventory_test";
const PASSWORD = "release_inventory_secret";
const DATABASE = "release_inventory_test_db";
let databaseUrl = "";

describeWithTestDatabase.sequential("database release canonical PostgreSQL inventory", () => {
  beforeAll(async () => {
    if (externalDatabaseUrl) {
      databaseUrl = safeTestDatabaseUrl(externalDatabaseUrl);
      await waitForPostgres(databaseUrl);
      return;
    }
    const existing = execFileSync("docker", [
      "ps", "-a", "--filter", `name=^/${CONTAINER}$`, "--format", "{{.Names}}",
    ], { encoding: "utf8" }).trim();
    if (existing) execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    execFileSync("docker", [
      "run", "--rm", "-d", "--name", CONTAINER,
      "-e", `POSTGRES_USER=${USER}`,
      "-e", `POSTGRES_PASSWORD=${PASSWORD}`,
      "-e", `POSTGRES_DB=${DATABASE}`,
      "-p", "127.0.0.1::5432",
      "postgres:16-alpine",
    ], { stdio: "ignore" });
    const mapping = execFileSync("docker", ["port", CONTAINER, "5432/tcp"], {
      encoding: "utf8",
    }).trim();
    const port = mapping.slice(mapping.lastIndexOf(":") + 1);
    databaseUrl = safeTestDatabaseUrl(
      `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/${DATABASE}`,
    );
    await waitForPostgres(databaseUrl);
  }, 30_000);

  afterAll(() => {
    if (!externalDatabaseUrl && hasDocker) {
      execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    }
  });

  it("treats even one user schema as a non-fresh database", async () => {
    const sql = postgres(databaseUrl, { max: 1, idle_timeout: 1 });
    try {
      const empty = await inspectUserObjectInventory(sql);
      expect(empty).toMatchObject({ object_count: 0, ledger_count: 0 });
      expect(classifyDatabaseOperation(empty)).toBe("fresh_install");
      await sql`CREATE SCHEMA review_user_schema`;
      const populated = await inspectUserObjectInventory(sql);
      expect(populated.objects).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "schema", identity: "review_user_schema" }),
      ]));
      expect(classifyDatabaseOperation(populated)).toBe("upgrade");
      await sql`DROP SCHEMA review_user_schema`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("enumerates extension, operator, collation, conversion, text search, FDW, publication and event trigger objects", async () => {
    const sql = postgres(databaseUrl, { max: 1, idle_timeout: 1 });
    try {
      await sql.unsafe(`
        CREATE EXTENSION hstore;
        CREATE TABLE public.review_table (id integer PRIMARY KEY, value text);
        CREATE DOMAIN public.review_domain AS text CHECK (VALUE <> '');
        CREATE FUNCTION public.review_add(integer, integer) RETURNS integer
          LANGUAGE SQL IMMUTABLE AS 'SELECT $1 + $2';
        CREATE FUNCTION public.review_int_to_domain(integer) RETURNS public.review_domain
          LANGUAGE SQL IMMUTABLE AS 'SELECT $1::text::public.review_domain';
        CREATE CAST (integer AS public.review_domain)
          WITH FUNCTION public.review_int_to_domain(integer) AS ASSIGNMENT;
        CREATE OPERATOR public.## (
          LEFTARG = integer, RIGHTARG = integer, FUNCTION = public.review_add
        );
        CREATE OPERATOR FAMILY public.review_family USING btree;
        CREATE COLLATION public.review_collation (provider = libc, locale = 'C');
        CREATE CONVERSION public.review_conversion
          FOR 'LATIN1' TO 'UTF8' FROM iso8859_1_to_utf8;
        CREATE TEXT SEARCH CONFIGURATION public.review_search (COPY = english);
        CREATE FOREIGN DATA WRAPPER review_fdw NO HANDLER;
        CREATE SERVER review_server FOREIGN DATA WRAPPER review_fdw;
        CREATE USER MAPPING FOR CURRENT_USER SERVER review_server
          OPTIONS (user 'review', password 'inventory-secret');
        CREATE SEQUENCE public.review_sequence;
        CREATE RULE review_rule AS ON INSERT TO public.review_table DO NOTHING;
        ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC;
        SELECT lo_create(0);
        CREATE PUBLICATION review_publication FOR TABLE public.review_table;
        CREATE FUNCTION public.review_event_trigger() RETURNS event_trigger
          LANGUAGE plpgsql AS 'BEGIN END';
        CREATE EVENT TRIGGER review_event_trigger ON ddl_command_end
          EXECUTE FUNCTION public.review_event_trigger();
      `);
      const inventory = await inspectUserObjectInventory(sql);
      const kinds = new Set(inventory.objects.map((item: { kind: string }) => item.kind));
      for (const kind of [
        "extension", "relation", "column", "constraint", "index", "routine", "type",
        "operator", "collation", "conversion", "text_search_configuration",
        "text_search_mapping", "foreign_data_wrapper", "foreign_server", "user_mapping",
        "sequence", "rule", "operator_family", "cast", "default_acl", "large_object",
        "publication", "publication_relation", "event_trigger",
      ]) {
        expect(kinds, `missing inventory kind ${kind}`).toContain(kind);
      }
      expect(inventory.object_count).toBeGreaterThan(15);
      expect(JSON.stringify(inventory.objects)).not.toContain("inventory-secret");
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("changes the canonical fingerprint for same-count rename and replacement", async () => {
    const admin = postgres(databaseUrl.replace(`/${DATABASE}`, "/postgres"), {
      max: 1,
      idle_timeout: 1,
    });
    const database = "release_fingerprint_test_db";
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
    await admin.unsafe(`CREATE DATABASE ${database}`);
    await admin.end({ timeout: 5 });
    const url = safeTestDatabaseUrl(databaseUrl.replace(`/${DATABASE}`, `/${database}`));
    const sql = postgres(url, { max: 1, idle_timeout: 1 });
    try {
      await sql`CREATE TABLE public.review_original (id integer)`;
      const original = await inspectUserObjectInventory(sql);
      await sql`ALTER TABLE public.review_original RENAME TO review_renamed`;
      const renamed = await inspectUserObjectInventory(sql);
      expect(renamed.object_count).toBe(original.object_count);
      expect(renamed.object_fingerprint).not.toBe(original.object_fingerprint);
      await sql`DROP TABLE public.review_renamed`;
      await sql`CREATE TABLE public.review_renamed (id integer)`;
      const replacement = await inspectUserObjectInventory(sql);
      expect(replacement.object_count).toBe(renamed.object_count);
      expect(replacement.object_fingerprint).not.toBe(renamed.object_fingerprint);

      const journal = {
        pending_migrations: [],
        pre_schema_fingerprint: original.object_fingerprint,
        release_id: "release-1",
      };
      expect(classifyLedgerReconciliation(
        journal,
        { ledger: [] },
        replacement,
      )).toBe("ambiguous");
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("reads the inventory as the unprivileged role that runs releases", async () => {
    const admin = postgres(databaseUrl.replace(`/${DATABASE}`, "/postgres"), {
      max: 1,
      idle_timeout: 1,
    });
    const database = "release_unprivileged_test_db";
    const reader = "release_unprivileged_reader";
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
    await admin.unsafe(`CREATE DATABASE ${database}`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${reader}`);
    await admin.unsafe(
      `CREATE ROLE ${reader} LOGIN NOSUPERUSER PASSWORD 'unprivileged-secret'`,
    );
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${reader}`);
    await admin.end({ timeout: 5 });

    const adminUrl = safeTestDatabaseUrl(databaseUrl.replace(`/${DATABASE}`, `/${database}`));
    const owner = postgres(adminUrl, { max: 1, idle_timeout: 1 });
    try {
      // The catalogs a non-superuser cannot read in full: pg_user_mapping is
      // superuser-only, and pg_subscription.subconninfo carries a column-level REVOKE.
      await owner.unsafe(`
        CREATE FOREIGN DATA WRAPPER review_fdw NO HANDLER;
        CREATE SERVER review_server FOREIGN DATA WRAPPER review_fdw;
        CREATE USER MAPPING FOR PUBLIC SERVER review_server
          OPTIONS (user 'review', password 'unprivileged-secret');
        CREATE SUBSCRIPTION review_subscription
          CONNECTION 'host=localhost dbname=review password=unprivileged-secret'
          PUBLICATION review_publication
          WITH (connect = false, slot_name = NONE);
        GRANT USAGE ON SCHEMA public TO ${reader};
      `);
      const privileged = await inspectUserObjectInventory(owner);
      const kinds = new Set(privileged.objects.map((item: { kind: string }) => item.kind));
      expect(kinds).toContain("user_mapping");
      expect(kinds).toContain("subscription");

      const url = safeTestDatabaseUrl(
        adminUrl.replace(`//${USER}:${PASSWORD}@`, `//${reader}:unprivileged-secret@`),
      );
      const unprivileged = postgres(url, { max: 1, idle_timeout: 1 });
      try {
        const inventory = await inspectUserObjectInventory(unprivileged);
        expect(inventory.object_fingerprint).toBe(privileged.object_fingerprint);
        expect(JSON.stringify(inventory.objects)).not.toContain("unprivileged-secret");
      } finally {
        await unprivileged.end({ timeout: 5 });
      }
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});

function safeTestDatabaseUrl(value: string) {
  const database = new URL(value).pathname.slice(1);
  if (!database.includes("test") || database.includes("soulstream")) {
    throw new Error(`unsafe TEST_DATABASE_URL database name: ${database}`);
  }
  return value;
}

async function waitForPostgres(url: string) {
  const sql = postgres(url, { max: 1, idle_timeout: 1, connect_timeout: 1 });
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await sql`SELECT 1`;
      const inventory = await inspectUserObjectInventory(sql);
      if (inventory.object_count !== 0) throw new Error("test database is not empty");
      await sql.end({ timeout: 5 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await sql.end({ timeout: 5 });
  throw lastError;
}
