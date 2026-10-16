import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withReadOnlyTransaction } from "../../scripts/attachment-migration/export_sources.js";
import { startPostgresTestContainer } from "../../../packages/db-schema/scripts/postgres-test-container.mjs";
import { waitForPostgres } from "../persistent-session-settings-world.js";

const CUTOFF = "2026-10-20T00:00:00.000Z";
const MISMATCH_CUTOFF = "2026-10-20T00:01:00.000Z";
const BASELINE_SHA = "8d1dac7a";
const NODE_ID = "inventory-node";
const OWNER_EMAIL = "fixture-owner@example.test";
const ORIGIN = "https://inventory.example.test";
const exportCli = fileURLToPath(new URL("../../scripts/attachment-migration/export_sources.ts", import.meta.url));
const nodeSourcesCli = fileURLToPath(new URL("../../scripts/attachment-migration/node_sources.ts", import.meta.url));
const scanNodeCli = fileURLToPath(new URL("../../scripts/attachment-migration/scan_node.mjs", import.meta.url));
const dryRunCli = fileURLToPath(new URL("../../scripts/attachment-migration/dry_run.ts", import.meta.url));

describe("read-only attachment inventory export pipeline against PostgreSQL", () => {
  let admin: ReturnType<typeof postgres>;
  let databaseUrl = "";
  let readonlyUrl = "";
  let stopContainer: (() => void) | undefined;
  let temp = "";

  beforeAll(async () => {
    const container = startPostgresTestContainer({
      user: "inventory_pipeline_test",
      password: "inventory_pipeline_test",
      database: "inventory_pipeline_test_db",
    });
    stopContainer = container.stop;
    databaseUrl = `postgres://inventory_pipeline_test:inventory_pipeline_test@127.0.0.1:${container.port}/inventory_pipeline_test_db`;
    readonlyUrl = `postgres://inventory_pipeline_reader:inventory_pipeline_reader@127.0.0.1:${container.port}/inventory_pipeline_test_db`;
    admin = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    await waitForPostgres(admin);
    const schema = await readFile(new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8");
    await admin.unsafe(schema);
    await admin`CREATE ROLE inventory_pipeline_reader LOGIN PASSWORD 'inventory_pipeline_reader'`;
    await admin`GRANT USAGE ON SCHEMA public TO inventory_pipeline_reader`;
    await admin`GRANT SELECT ON ALL TABLES IN SCHEMA public TO inventory_pipeline_reader`;
    expect(Number((await admin`SELECT COUNT(*) AS n FROM sessions`)[0]!.n)).toBe(0);
  }, 120_000);

  afterAll(async () => {
    await admin?.end({ timeout: 2 });
    stopContainer?.();
    if (temp) await rm(temp, { recursive: true, force: true });
  });

  it("exports relational and split event parts through scan_node and dry_run without writes", async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "attachment-inventory-pipeline-"));
    const partsDir = path.join(temp, "parts");
    const incoming = path.join(temp, "incoming");
    await mkdir(partsDir);
    await mkdir(incoming);
    const allowedRootsPath = path.join(temp, "allowed-roots.json");
    await writeFile(allowedRootsPath, JSON.stringify([incoming]));
    await writeFile(path.join(incoming, "event.png"), Buffer.from([1, 2, 3, 4]));

    await admin`INSERT INTO folders(id,name) VALUES ('inventory-pipeline-folder','inventory fixture')`;
    await admin`INSERT INTO cards(id,folder_id,position_key,title,request,attachments,items,created_at,updated_at)
      VALUES ('inventory-empty-card','inventory-pipeline-folder','a','빈 요청','', '[]'::jsonb,'[]'::jsonb,${new Date(CUTOFF)},${new Date(CUTOFF)})`;
    await admin`INSERT INTO sessions(session_id,node_id,status,created_at,updated_at)
      VALUES ('aaa-inventory-session',${NODE_ID},'archived',${new Date(CUTOFF)},${new Date(CUTOFF)}),
             ('zzz-inventory-session',${NODE_ID},'completed',${new Date(CUTOFF)},${new Date(CUTOFF)})`;
    await admin`INSERT INTO file_assets(id,storage_key,storage_purpose,original_name,mime_type,byte_size,upload_status,created_at,updated_at)
      VALUES ('inventory-existing-asset','fixture/inventory-existing.png','attachment','existing.png','image/png',4,'committed',${new Date(CUTOFF)},${new Date(CUTOFF)})`;
    await admin`INSERT INTO attachment_legacy_aliases(node_id,normalized_path,asset_id,original_path,availability,checked_at)
      VALUES (${NODE_ID},'legacy/existing.png','inventory-existing-asset','legacy/existing.png','resolved',${new Date(CUTOFF)})`;
    await admin`INSERT INTO events(session_id,id,event_type,payload,created_at)
      VALUES ('aaa-inventory-session',1,'user_message',${admin.json({
        attachments: ["event.png"],
        attachment_paths: ["event.png"],
        caller_info: { source: "browser", email: OWNER_EMAIL },
      })}::jsonb,${new Date(CUTOFF)}),
             ('aaa-inventory-session',2,'user_message',${admin.json({ text: "fixture without attachment paths" })}::jsonb,${new Date(CUTOFF)}),
             ('zzz-inventory-session',1,'heartbeat','{}'::jsonb,${new Date(CUTOFF)})`;

    const relationalPath = path.join(partsDir, "relational.jsonl");
    const sessionsPath = path.join(partsDir, "sessions.json");
    const relationalResult = runExport(["relational", "--cutoff", CUTOFF, "--output", relationalPath], readonlyUrl);
    expect(relationalResult.status).toBe(0);
    expect(relationalResult.stdout).toMatch(/RELATIONAL_SOURCE_PART_EXPORTED .*sha256=[0-9a-f]{64}/);
    expect(relationalResult.stdout + relationalResult.stderr).not.toContain(OWNER_EMAIL);
    await expectMode(relationalPath);

    const sessionResult = runExport(["sessions", "--cutoff", CUTOFF, "--output", sessionsPath, "--page-size", "1"], readonlyUrl);
    expect(sessionResult.status).toBe(0);
    expect(sessionResult.stdout).toMatch(/INVENTORY_SESSION_LIST_EXPORTED .*sha256=[0-9a-f]{64}/);
    expect(sessionResult.stdout + sessionResult.stderr).not.toContain(OWNER_EMAIL);
    await expectMode(sessionsPath);
    const sessionList = JSON.parse(await readFile(sessionsPath, "utf8")) as { session_ids: string[]; cutoff: string };
    expect(sessionList).toMatchObject({ cutoff: CUTOFF, session_ids: ["aaa-inventory-session", "zzz-inventory-session"] });

    const eventPartA = path.join(partsDir, "events-a.jsonl");
    const eventPartB = path.join(partsDir, "events-b.jsonl");
    const eventArgs = (start: number, output: string) => [
      "events", "--cutoff", CUTOFF, "--sessions", sessionsPath, "--start", String(start), "--limit", "1",
      "--page-size", "1", "--output", output,
    ];
    const eventResults: SpawnSyncReturns<string>[] = [];
    for (const [start, output] of [[0, eventPartA], [1, eventPartB]] as const) {
      const result = runExport(eventArgs(start, output), readonlyUrl);
      eventResults.push(result);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/INVENTORY_EVENT_PART_EXPORTED .*sha256=[0-9a-f]{64}/);
      expect(result.stdout + result.stderr).not.toContain(OWNER_EMAIL);
      await expectMode(output);
    }
    expect(eventResults[0]!.stderr).toContain("cursor=aaa-inventory-session:1 state=page");
    expect(eventResults[0]!.stderr).toContain("cursor=aaa-inventory-session:2 state=page");
    expect(eventResults[0]!.stderr).toContain("cursor=aaa-inventory-session:2 state=complete");

    const expectedNodes = JSON.stringify([NODE_ID]);
    const makeBundle = (name: string, parts: string[]) => {
      const output = path.join(partsDir, name);
      const result = runExport([
        "bundle", "--parts", JSON.stringify(parts), "--expected-nodes", expectedNodes,
        "--baseline-sha", BASELINE_SHA, "--output", output,
      ]);
      return { output, result };
    };
    const fullBundle = makeBundle("bundle.jsonl", [relationalPath, sessionsPath, eventPartA, eventPartB]);
    expect(fullBundle.result.status).toBe(0);
    expect(fullBundle.result.stdout).toMatch(/INVENTORY_BUNDLE_ASSEMBLED .*sha256=[0-9a-f]{64}/);
    await expectMode(fullBundle.output);
    const fullRows = await readJsonl(fullBundle.output);
    const fullMetadata = fullRows.find((row) => row.record_type === "run_metadata");
    expect(fullMetadata).toMatchObject({ cutoff: CUTOFF, relational_coverage_complete: true, alias_snapshot_complete: true });
    expect(fullRows.filter((row) => row.record_type === "session_coverage")).toHaveLength(2);
    expect(fullRows).toContainEqual(expect.objectContaining({ record_type: "asset", id: "inventory-existing-asset" }));
    expect(fullRows).toContainEqual(expect.objectContaining({ record_type: "alias", node_id: NODE_ID, normalized_path: "legacy/existing.png" }));

    const missingBundle = makeBundle("bundle-missing.jsonl", [relationalPath, sessionsPath, eventPartA]);
    expect(missingBundle.result.status).toBe(0);
    const missingRows = await readJsonl(missingBundle.output);
    expect(missingRows.find((row) => row.record_type === "run_metadata")?.coverage_complete).toBe(false);
    expect(missingRows).toContainEqual(expect.objectContaining({
      record_type: "session_coverage", session_id: "zzz-inventory-session", coverage_complete: false,
    }));

    const repeatedSessionPart = path.join(partsDir, "events-a-again.jsonl");
    const repeatedResult = runExport(eventArgs(0, repeatedSessionPart), readonlyUrl);
    expect(repeatedResult.status).toBe(0);
    const overlappingBundle = makeBundle("bundle-overlap.jsonl", [relationalPath, sessionsPath, eventPartA, repeatedSessionPart, eventPartB]);
    expect(overlappingBundle.result.status).toBe(0);
    const overlappingRows = await readJsonl(overlappingBundle.output);
    expect(overlappingRows.find((row) => row.record_type === "run_metadata")?.coverage_complete).toBe(false);
    expect(overlappingRows).toContainEqual(expect.objectContaining({
      record_type: "session_coverage", session_id: "aaa-inventory-session", coverage_complete: false,
    }));

    const mismatchedRelational = path.join(partsDir, "relational-other-cutoff.jsonl");
    expect(runExport(["relational", "--cutoff", MISMATCH_CUTOFF, "--output", mismatchedRelational], readonlyUrl).status).toBe(0);
    const cutoffBundle = makeBundle("bundle-cutoff-mismatch.jsonl", [mismatchedRelational, sessionsPath, eventPartA, eventPartB]);
    expect(cutoffBundle.result.status).toBe(0);
    const cutoffRows = await readJsonl(cutoffBundle.output);
    expect(cutoffRows.find((row) => row.record_type === "run_metadata")?.coverage_complete).toBe(false);
    expect(cutoffRows.filter((row) => row.record_type === "session_coverage").every((row) => row.coverage_complete === false)).toBe(true);

    const duplicateOutput = path.join(partsDir, "bundle-duplicate-part.jsonl");
    const duplicatePartResult = runExport([
      "bundle", "--parts", JSON.stringify([relationalPath, relationalPath, sessionsPath, eventPartA]),
      "--expected-nodes", expectedNodes, "--baseline-sha", BASELINE_SHA, "--output", duplicateOutput,
    ]);
    expect(duplicatePartResult.status).not.toBe(0);
    expect(await exists(duplicateOutput)).toBe(false);

    const relationalHash = await sha256File(relationalPath);
    const overwriteResult = runExport(["relational", "--cutoff", CUTOFF, "--output", relationalPath], readonlyUrl);
    expect(overwriteResult.status).not.toBe(0);
    expect(await sha256File(relationalPath)).toBe(relationalHash);

    const nodeSourcesPath = path.join(partsDir, "node-sources.json");
    const nodeSourcesResult = runCli("pnpm", [
      "exec", "tsx", nodeSourcesCli,
      "--sources", fullBundle.output,
      "--node-id", NODE_ID,
      "--output", nodeSourcesPath,
    ]);
    expect(nodeSourcesResult.status).toBe(0);
    expect(nodeSourcesResult.stdout).toMatch(/NODE_SOURCES_EXPORTED .*sha256=[0-9a-f]{64}/);
    expect(nodeSourcesResult.stdout + nodeSourcesResult.stderr).not.toContain(OWNER_EMAIL);
    await expectMode(nodeSourcesPath);
    const explicitSources = JSON.parse(await readFile(nodeSourcesPath, "utf8")) as Array<{ path: string; source_ref: { source_pk: string } }>;
    expect(explicitSources.filter((source) => source.path === "event.png")).toHaveLength(2);
    expect(new Set(explicitSources.map((source) => source.source_ref.source_pk))).toEqual(new Set(["1"]));

    const nodeOutputPath = path.join(partsDir, "node.jsonl");
    const scanResult = runCli("node", [
      scanNodeCli,
      "--node-id", NODE_ID,
      "--incoming-root", incoming,
      "--sources", nodeSourcesPath,
      "--allowed-roots", allowedRootsPath,
      "--cutoff", CUTOFF,
      "--output", nodeOutputPath,
    ]);
    expect(scanResult.status, `${scanResult.stdout}\n${scanResult.stderr}`).toBe(0);
    expect(scanResult.stdout).toContain("NODE_INVENTORY_RECORDED");
    const nodeRows = await readJsonl(nodeOutputPath);
    const fileObservation = nodeRows.find((row) => row.record_type === "file");
    expect(fileObservation?.source_refs).toHaveLength(2);

    const dryRunDir = path.join(temp, "dry-run");
    const dryRunResult = runCli("pnpm", [
      "exec", "tsx", dryRunCli,
      "--sources", fullBundle.output,
      "--nodes", nodeOutputPath,
      "--output", dryRunDir,
      "--allowed-origins", "[]",
    ]);
    expect(dryRunResult.status).toBe(0);
    expect(dryRunResult.stdout).toContain("ATTACHMENT_MIGRATION_DRY_RUN");
    expect(dryRunResult.stdout).toContain('"writes_enabled":false');
    expect(dryRunResult.stdout + dryRunResult.stderr).not.toContain(OWNER_EMAIL);
    const summary = JSON.parse(await readFile(path.join(dryRunDir, "summary.json"), "utf8"));
    expect(summary).toMatchObject({ dry_run: true, writes_enabled: false, db_mutation_count: 0, r2_put_count: 0 });

    await expect(withReadOnlyTransaction(admin, 30_000, async (tx) => {
      await tx`INSERT INTO folders(id,name) VALUES ('inventory-read-only-write','must fail')`;
    })).rejects.toThrow(/read.only transaction/i);
    expect(Number((await admin`SELECT COUNT(*) AS n FROM folders WHERE id='inventory-read-only-write'`)[0]!.n)).toBe(0);
    expect(Number((await admin`SELECT COUNT(*) AS n FROM events`)[0]!.n)).toBe(3);
    expect(Number((await admin`SELECT COUNT(*) AS n FROM cards WHERE id='inventory-empty-card'`)[0]!.n)).toBe(1);
  }, 240_000);
});

function runExport(args: string[], databaseUrl?: string): SpawnSyncReturns<string> {
  return runCli("pnpm", ["exec", "tsx", exportCli, ...args], databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl });
}

function runCli(command: string, args: string[], extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NODE_ENV: "development", ...extraEnv },
  });
}

async function readJsonl(filePath: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(filePath, "utf8");
  return text.trim() ? text.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, any>) : [];
}

async function expectMode(filePath: string): Promise<void> {
  expect((await stat(filePath)).mode & 0o777).toBe(0o600);
}

async function sha256File(filePath: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true; } catch { return false; }
}
