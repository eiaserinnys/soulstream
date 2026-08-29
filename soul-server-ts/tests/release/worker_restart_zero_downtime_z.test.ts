import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp, parseOrchServerConfig } from "../../../orch-server-ts/src/index.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
} from "../db/full_schema_postgres_harness.js";
import { LegacyGen0OwnerlessZombieHarness } from
  "../runner/legacy_gen0_ownerless_zombie_harness.js";
import { legacyGen0OwnerlessViolations } from
  "../runner/legacy_gen0_ownerless_zombie_oracle.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;
const buildWrapperPath = fileURLToPath(new URL(
  "../../scripts/build_with_release_env.mjs",
  import.meta.url,
));
const publicStatusRoutesPath = fileURLToPath(new URL(
  "../../../orch-server-ts/src/public/public_status_routes.ts",
  import.meta.url,
));
const productionPath = fileURLToPath(new URL(
  "../../../orch-server-ts/src/production.ts",
  import.meta.url,
));

type LedgerHead = { migration_id: string; checksum: string; ordinal: number };

describePostgres("worker restart zero-downtime Z handoff", () => {
  let postgres: FullSchemaPostgresHarness;
  let recovery: LegacyGen0OwnerlessZombieHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
    recovery = await LegacyGen0OwnerlessZombieHarness.create(postgres);
  }, 60_000);

  afterAll(async () => {
    await recovery?.cleanup();
    await postgres?.cleanup();
  });

  it("keeps the old host serving until the manifest head is ready, then adopts live work and terminalizes 32b", async () => {
    const buildWrapper = readFileSync(buildWrapperPath, "utf8");
    const publicStatusRoutes = readFileSync(publicStatusRoutesPath, "utf8");
    const production = readFileSync(productionPath, "utf8");
    expect(buildWrapper).toContain("verifyCentralSchemaPrerequisite");
    expect(publicStatusRoutes).toContain("databaseSchemaProvider");
    expect(production).toContain("databaseSchemaProvider");

    const [
      { verifyCentralSchemaPrerequisite },
      { LiveDatabaseSchemaProvider },
      productionModule,
    ] = await Promise.all([
      import("../../scripts/verify-central-schema-prerequisite.mjs"),
      import("../../../orch-server-ts/src/public/database_schema_provider.js"),
      import("../../../orch-server-ts/src/production.js"),
    ]);
    expect(productionModule.buildProductionRouteOptions).toBeTypeOf("function");
    const migrationManifest = JSON.parse(readFileSync(
      fileURLToPath(new URL(
        "../../../packages/db-schema/migration-manifest.json",
        import.meta.url,
      )),
      "utf8",
    )) as { migrations: Array<{ id: string; sha256: string }> };
    const targetOrdinal = migrationManifest.migrations.length;
    const target = migrationManifest.migrations.at(-1);
    const predecessor = migrationManifest.migrations.at(-2);
    if (!target || !predecessor) {
      throw new Error("restart fixture requires a target migration and its predecessor");
    }
    const schemaGeneration = `${target.id}:${target.sha256}:sha256-manifest`;

    let ledgerHead: LedgerHead = {
      migration_id: predecessor.id,
      checksum: predecessor.sha256,
      ordinal: targetOrdinal - 1,
    };
    const databaseSchemaProvider = new LiveDatabaseSchemaProvider({
      resolveSql: async () => (() => Promise.resolve([ledgerHead])) as never,
      close: async () => undefined,
    });
    const config = parseOrchServerConfig({
      environment: "test",
      databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
      authBearerToken: "test-token",
    });
    const app = createApp({
      config,
      publicStatusRoutes: {
        configProvider: {
          getConfig: async () => ({ authEnabled: true, atomEnabled: true }),
        },
        folderCountsProvider: {
          getFolderCounts: async () => ({}),
          listFolders: async () => [],
          resolveAccess: async () => ({ restricted: false }),
        },
        databaseSchemaProvider,
      },
    });
    await app.ready();
    const fetchFromApp = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      const response = await app.inject({ method: "GET", url: url.pathname });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": "application/json" },
      });
    };

    let cutoverCount = 0;
    await expect(verifyCentralSchemaPrerequisite({
      upstreamUrl: "ws://orch.test/ws/node",
      schemaGeneration,
      fetchImpl: fetchFromApp,
    })).rejects.toThrow("central database schema prerequisite mismatch");
    expect(cutoverCount).toBe(0);

    ledgerHead = {
      migration_id: target.id,
      checksum: target.sha256,
      ordinal: targetOrdinal,
    };
    await verifyCentralSchemaPrerequisite({
      upstreamUrl: "ws://orch.test/ws/node",
      schemaGeneration,
      fetchImpl: fetchFromApp,
    });
    cutoverCount += 1;

    const observation = await recovery.observeStartupReconnectMatrix();
    expect(legacyGen0OwnerlessViolations(observation)).toEqual([]);
    expect(cutoverCount).toBe(1);
    expect(observation.fullProvenLiveOwner).toMatchObject({
      status: "running",
      generation: 1,
      terminationEventId: null,
    });
    expect(observation.gen0NoOwnershipRow).toMatchObject({
      status: "interrupted",
      generation: 0,
      manifestId: null,
      registrationId: null,
    });
    expect(observation.gen0NoOwnershipRow.terminationEventId)
      .toBeGreaterThan(observation.gen0InitialTerminalEventId);
    expect(observation.ownerlessRunningCount).toBe(0);
    expect(observation.statusOnlyTerminalWrites).toBe(0);
    expect(observation.liveRunnerAdoptionCount).toBe(1);
    expect(observation.liveRunnerRenewApplied).toBe(true);
    expect(observation.liveRunnerRetireCount).toBe(0);
    await app.close();
  }, 60_000);
});
