import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionTestDatabase, type TestDatabaseLease } from "./database_test_harness.js";
import { makeTempDirSync } from "../helpers/temp_dir.js";
import { runDatabaseReleaseCli } from
  "../../../packages/db-schema/scripts/database-release-cli.mjs";
import {
  classifyLedgerReconciliation,
  inspectUserObjectInventory,
} from "../../../packages/db-schema/scripts/database-release-journal.mjs";
import {
  classifyDatabaseOperation,
  databaseReleaseJournalPath,
  readDatabaseReleaseJournal,
  runDatabaseRelease,
} from "../../../packages/db-schema/scripts/release-executor.mjs";

const hasDocker = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const externalDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
const hasTestDatabase = Boolean(externalDatabaseUrl) || hasDocker;
const describeWithTestDatabase = hasTestDatabase ? describe : describe.skip;
const USER = "release_inventory_test";
const PASSWORD = "release_inventory_secret";
const DATABASE = "release_inventory_test_db";
const INSTALLER_MANIFEST = fileURLToPath(new URL(
  "../../../install/release-manifest-installer.json",
  import.meta.url,
));
const INSTALLER_CONTRACT = fileURLToPath(new URL(
  "../../../install/database-release-installer.json",
  import.meta.url,
));
const INSTALLER_UNITS = ["soulstream-orch.service", "soulstream-worker.service"];
const DROP_MIGRATION = "172_drop_claude_transcript_store.sql";
const ADD_MIGRATION = "173_mcp_central_config.sql";
let databaseUrl = "";
let databaseLease: TestDatabaseLease | undefined;

describeWithTestDatabase.sequential("database release canonical PostgreSQL inventory", () => {
  beforeAll(async () => {
    databaseLease = await provisionTestDatabase({
      prefix: "release_inventory",
      dockerUser: USER,
      dockerPassword: PASSWORD,
      dockerDatabase: DATABASE,
    });
    databaseUrl = safeTestDatabaseUrl(databaseLease.url);
    try {
      await waitForPostgres(databaseUrl);
    } catch (error) {
      await databaseLease.cleanup();
      databaseLease = undefined;
      throw error;
    }
  }, 30_000);

  afterAll(async () => {
    await databaseLease?.cleanup();
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
    const admin = postgres(databaseUrlFor(databaseUrl, "postgres"), {
      max: 1,
      idle_timeout: 1,
    });
    const database = `release_fingerprint_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    let databaseCreated = false;
    let sql: ReturnType<typeof postgres> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE ${database}`);
      databaseCreated = true;
      const url = safeTestDatabaseUrl(databaseUrlFor(databaseUrl, database));
      sql = postgres(url, { max: 1, idle_timeout: 1 });
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
      try {
        await sql?.end({ timeout: 5 });
      } finally {
        try {
          if (databaseCreated) {
            await admin.unsafe(`DROP DATABASE ${database}`);
            expect(await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`).toHaveLength(0);
          }
        } finally {
          await admin.end({ timeout: 5 });
        }
      }
    }
  });

  it("reads the inventory as the unprivileged role that runs releases", async () => {
    const admin = postgres(databaseUrlFor(databaseUrl, "postgres"), {
      max: 1,
      idle_timeout: 1,
    });
    const suffix = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const database = `release_unprivileged_test_${suffix}`;
    const reader = `release_unprivileged_reader_${suffix}`;
    let databaseCreated = false;
    let roleCreated = false;
    let owner: ReturnType<typeof postgres> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE ${database}`);
      databaseCreated = true;
      await admin.unsafe(
        `CREATE ROLE ${reader} LOGIN NOSUPERUSER PASSWORD 'unprivileged-secret'`,
      );
      roleCreated = true;
      await admin.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${reader}`);
      const adminUrl = safeTestDatabaseUrl(databaseUrlFor(databaseUrl, database));
      owner = postgres(adminUrl, { max: 1, idle_timeout: 1 });
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

      const sibling = postgres(databaseUrl, { max: 1, idle_timeout: 1 });
      try {
        const siblingInventory = await inspectUserObjectInventory(sibling);
        expect(siblingInventory.objects).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "subscription", identity: "review_subscription" }),
        ]));
      } finally {
        await sibling.end({ timeout: 5 });
      }

      const url = safeTestDatabaseUrl(
        databaseUrlForRole(adminUrl, reader, "unprivileged-secret"),
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
      try {
        if (owner) {
          try {
            await owner`DROP SUBSCRIPTION IF EXISTS review_subscription`;
          } finally {
            await owner.end({ timeout: 5 });
          }
        }
      } finally {
        try {
          if (databaseCreated) {
            await admin.unsafe(`DROP DATABASE ${database}`);
            expect(await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`).toHaveLength(0);
          }
        } finally {
          try {
            if (roleCreated) {
              await admin.unsafe(`DROP ROLE ${reader}`);
              expect(await admin`SELECT 1 FROM pg_roles WHERE rolname = ${reader}`).toHaveLength(0);
            }
          } finally {
            await admin.end({ timeout: 5 });
          }
        }
      }
    }
  });

  it("upgrades a 171 database with user rows through the installer pair", async () => {
    const admin = postgres(databaseUrlFor(databaseUrl, "postgres"), {
      max: 1,
      idle_timeout: 1,
    });
    const database = `release_installer_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const root = makeTempDirSync("release-installer-postgres-");
    let databaseCreated = false;
    let sql: ReturnType<typeof postgres> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE ${database}`);
      databaseCreated = true;
      sql = postgres(safeTestDatabaseUrl(databaseUrlFor(databaseUrl, database)), {
        max: 1,
        idle_timeout: 1,
      });
      // The executor fence reads this local soulstream target. The test
      // connection is injected, so nothing dials this address.
      writeFileSync(
        join(root, ".env.orch"),
        "DATABASE_URL=postgresql://soulstream@127.0.0.1:9/soulstream\n",
        "utf8",
      );

      const firstInstall = installerRun(sql, root, "1a".repeat(20), async () => (
        "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n"
      ));
      await expect(firstInstall.phase("preflight")).resolves.toMatchObject({
        operation: "fresh_install",
      });
      await expect(firstInstall.phase("apply")).resolves.toMatchObject({ status: "applied" });
      await expect(firstInstall.phase("verify")).resolves.toMatchObject({ status: "verified" });
      expect(firstInstall.units).toEqual([]);

      // Back to the 171 schema: 173 objects gone, the 172 store present, user rows kept.
      await sql.unsafe(`
        DELETE FROM schema_migrations
         WHERE ordinal >= (
           SELECT ordinal FROM schema_migrations WHERE migration_id = '${DROP_MIGRATION}'
         );
        DROP TABLE mcp_agent_bindings, mcp_server_icons, mcp_config_revisions, mcp_profiles,
          mcp_servers, mcp_secrets, mcp_managed_nodes, mcp_config_state;
        CREATE TABLE claude_transcript_entries (
            id          BIGSERIAL PRIMARY KEY,
            project_key TEXT NOT NULL,
            session_id  TEXT NOT NULL,
            subpath     TEXT NOT NULL DEFAULT '',
            entry_uuid  TEXT,
            entry       JSONB NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        INSERT INTO claude_transcript_entries (project_key, session_id, entry)
        VALUES ('installer', 'session-1', '{}'::jsonb);
        INSERT INTO users (email, display_name, is_admin)
        VALUES ('owner@local', 'Owner', TRUE);
      `);

      const upgrade = installerRun(sql, root, "2b".repeat(20), async () => (
        "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\n"
      ));
      await expect(upgrade.phase("preflight")).resolves.toMatchObject({
        operation: "upgrade",
        pending_count: 3,
        pending_additive_only: false,
        status: "preflight_complete",
      });
      await expect(upgrade.phase("apply")).resolves.toMatchObject({ status: "applied" });
      await expect(upgrade.phase("verify")).resolves.toMatchObject({ status: "verified" });
      expect(upgrade.units).toEqual([...INSTALLER_UNITS, ...INSTALLER_UNITS]);

      const [objects] = await sql`
        SELECT to_regclass('claude_transcript_entries')::text AS transcript,
               to_regclass('mcp_servers')::text AS mcp_servers
      `;
      expect(objects).toEqual({ transcript: null, mcp_servers: "mcp_servers" });
      const ledger = await sql`
        SELECT migration_id, release_id FROM schema_migrations
         WHERE migration_id IN (${DROP_MIGRATION}, ${ADD_MIGRATION})
         ORDER BY ordinal
      `;
      expect(ledger.map((row) => ({ ...row }))).toEqual([
        { migration_id: DROP_MIGRATION, release_id: upgrade.releaseId },
        { migration_id: ADD_MIGRATION, release_id: upgrade.releaseId },
      ]);
      expect(await sql`SELECT email FROM users WHERE email = 'owner@local'`).toHaveLength(1);
      const journal = await readDatabaseReleaseJournal(databaseReleaseJournalPath(upgrade.env));
      expect(journal).toMatchObject({ status: "verified", haniel_journal_path: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
      try {
        await sql?.end({ timeout: 5 });
      } finally {
        try {
          if (databaseCreated) {
            await admin.unsafe(`DROP DATABASE ${database}`);
            expect(await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`).toHaveLength(0);
          }
        } finally {
          await admin.end({ timeout: 5 });
        }
      }
    }
  }, 120_000);
});

/**
 * Runs one installer release phase through the CLI with the identity U11b
 * setup_schema passes after checkout. Only the connection and systemctl are
 * injected.
 */
function installerRun(
  sql: ReturnType<typeof postgres>,
  root: string,
  head: string,
  systemctlShow: (unit: string) => Promise<string>,
) {
  const releaseId = `clean-${head.slice(0, 12)}`;
  const env: Record<string, string> = {
    HANIEL_SERVICE_ENV_FILE: join(root, ".env.orch"),
    HANIEL_TARGET_HEAD: head,
    HANIEL_PREVIOUS_HEAD: head,
    HANIEL_RELEASE_ID: releaseId,
    HANIEL_REQUEST_ID: `installer-${head}`,
    HANIEL_DEPLOY_REPO: "soulstream",
    HANIEL_BACKUP_DIR: join(root, ".local", "database-release", releaseId),
  };
  const units: string[] = [];
  const recordedSystemctl = async (unit: string) => {
    units.push(unit);
    return await systemctlShow(unit);
  };
  return {
    env,
    releaseId,
    units,
    async phase(command: string) {
      const lines: string[] = [];
      const code = await runDatabaseReleaseCli(async (cliCommand, { subphase, ...options }) => (
        await runDatabaseRelease(cliCommand, {
          ...options,
          subphase: subphase ?? undefined,
          sql,
          systemctlShow: recordedSystemctl,
        })
      ), {
        argv: [
          command,
          "--manifest", INSTALLER_MANIFEST,
          "--database-contract", INSTALLER_CONTRACT,
        ],
        env: { ...env },
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(line),
      });
      expect(code, lines.join("\n")).toBe(0);
      return JSON.parse(lines.at(-1) ?? "null") as Record<string, unknown>;
    },
  };
}

function safeTestDatabaseUrl(value: string) {
  const database = new URL(value).pathname.slice(1);
  if (!database.includes("test") || database.includes("soulstream")) {
    throw new Error(`unsafe TEST_DATABASE_URL database name: ${database}`);
  }
  return value;
}

function databaseUrlFor(value: string, database: string): string {
  const url = new URL(value);
  url.pathname = `/${database}`;
  return url.toString();
}

function databaseUrlForRole(value: string, username: string, password: string): string {
  const url = new URL(value);
  url.username = username;
  url.password = password;
  return url.toString();
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
