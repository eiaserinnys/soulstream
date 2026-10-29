import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/omit-inline-image-data.ts", import.meta.url));
const TSX_PATH = join(SERVER_ROOT, "node_modules/.bin/tsx");
const SESSION_ID = "image-omit-backfill-test";
const describePostgres = hasFullSchemaPostgresBackend ? describe.sequential : describe.skip;

describePostgres("omit inline image data backfill", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("dry-runs and resumes batches, updates only image payloads, and preserves search indexes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omit-inline-image-data-"));
    const dryCheckpoint = join(directory, "dry-run.json");
    const applyCheckpoint = join(directory, "apply.json");
    const imageBytes = "A".repeat(300 * 1024);
    const truncatedImage = `[{"type":"image","source":{"type":"base64","data":"${"C".repeat(80)}\n[잘림]`;
    const ordinaryPayload = {
      type: "tool_result",
      result: JSON.stringify([{ type: "document", data: "D".repeat(80) }]),
    };
    const initialPayloads = [
      {
        type: "tool_result",
        result: JSON.stringify([{
          type: "image",
          source: { type: "base64", data: imageBytes, media_type: "image/png" },
        }]),
      },
      ordinaryPayload,
      {
        type: "tool_start",
        result: truncatedImage,
        truncation: { original_bytes: 4096, attachment: { id: "keep-attachment" } },
      },
    ];
    const serviceConfigDirectory = join(directory, "empty-service-config");

    try {
      await harness.sql`
        INSERT INTO sessions (session_id, session_type, status)
        VALUES (${SESSION_ID}, 'codex', 'running')
      `;
      await harness.sql`
        INSERT INTO events (session_id, id, event_type, payload, searchable_text)
        VALUES (${SESSION_ID}, 1, 'tool_result', ${initialPayloads[0]}, 'indexed image row'),
               (${SESSION_ID}, 2, 'tool_result', ${ordinaryPayload}, 'indexed ordinary row'),
               (${SESSION_ID}, 3, 'tool_start', ${initialPayloads[2]}, 'indexed truncated row')
      `;
      const originalSearchableText = await readSearchableText(harness);
      const originalTerms = await readEventSearchTerms(harness);

      const dryFirst = runScript(harness, serviceConfigDirectory, dryCheckpoint,
        "--dry-run", "--batch", "1", "--max-seconds", "0");
      expect(dryFirst.status, dryFirst.stderr || dryFirst.stdout).toBe(0);
      expect(readReport(dryFirst.stdout)).toMatchObject({
        processedRows: 1,
        changedRows: 1,
        complete: false,
        checkpoint: { processedRows: 1, changedRows: 1 },
      });

      const dryResumed = runScript(harness, serviceConfigDirectory, dryCheckpoint,
        "--dry-run", "--batch", "1");
      expect(dryResumed.status, dryResumed.stderr || dryResumed.stdout).toBe(0);
      expect(readReport(dryResumed.stdout)).toMatchObject({
        complete: true,
        checkpoint: { processedRows: 3, changedRows: 2 },
      });
      expect(await readPayload(harness, 1)).toEqual(initialPayloads[0]);

      const applyFirst = runScript(harness, serviceConfigDirectory, applyCheckpoint,
        "--batch", "1", "--max-seconds", "0");
      expect(applyFirst.status, applyFirst.stderr || applyFirst.stdout).toBe(0);
      expect(readReport(applyFirst.stdout)).toMatchObject({
        processedRows: 1,
        changedRows: 1,
        complete: false,
        checkpoint: { processedRows: 1, changedRows: 1 },
      });

      const applyResumed = runScript(harness, serviceConfigDirectory, applyCheckpoint,
        "--batch", "1");
      expect(applyResumed.status, applyResumed.stderr || applyResumed.stdout).toBe(0);
      expect(readReport(applyResumed.stdout)).toMatchObject({
        complete: true,
        checkpoint: { processedRows: 3, changedRows: 2 },
      });

      const rerun = runScript(harness, serviceConfigDirectory, applyCheckpoint, "--batch", "1");
      expect(rerun.status, rerun.stderr || rerun.stdout).toBe(0);
      expect(readReport(rerun.stdout)).toMatchObject({
        processedRows: 0,
        changedRows: 0,
        reducedBytes: 0,
        complete: true,
      });

      const imagePayload = await readPayload(harness, 1) as { result: string };
      expect(imagePayload.result).toContain("[omitted image]");
      expect(imagePayload.result).not.toContain(imageBytes);
      expect(await readPayload(harness, 2)).toEqual(ordinaryPayload);
      const truncatedPayload = await readPayload(harness, 3) as {
        result: string;
        truncation: { original_bytes: number; attachment: { id: string } };
      };
      expect(truncatedPayload.result).toContain("[omitted image]");
      expect(truncatedPayload.result).toContain("\n[잘림]");
      expect(truncatedPayload.truncation).toEqual({
        original_bytes: 4096,
        attachment: { id: "keep-attachment" },
      });
      expect(await readPayloadTypes(harness)).toEqual([
        { id: 1, payload_type: "object" },
        { id: 2, payload_type: "object" },
        { id: 3, payload_type: "object" },
      ]);
      expect(await readSearchableText(harness)).toEqual(originalSearchableText);
      expect(await readEventSearchTerms(harness)).toEqual(originalTerms);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

function runScript(
  harness: FullSchemaPostgresHarness,
  serviceConfigDirectory: string,
  checkpoint: string,
  ...args: string[]
) {
  const result = spawnSync(TSX_PATH, [SCRIPT_PATH, "--checkpoint", checkpoint, ...args], {
    cwd: SERVER_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: harness.databaseUrl,
      MIGRATION_DATABASE_URL: "",
      HANIEL_SERVICE_CWD: serviceConfigDirectory,
    },
    timeout: 30_000,
  });
  expect(result.stdout).not.toContain(harness.databaseUrl);
  expect(result.stderr).not.toContain(harness.databaseUrl);
  return result;
}

function readReport(stdout: string) {
  const lines = stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]!);
}

async function readPayload(harness: FullSchemaPostgresHarness, id: number) {
  const rows = await harness.sql<{ payload: unknown }[]>`
    SELECT payload FROM events WHERE session_id = ${SESSION_ID} AND id = ${id}
  `;
  expect(rows).toHaveLength(1);
  const payload = rows[0]!.payload;
  return typeof payload === "string" ? JSON.parse(payload) as unknown : payload;
}

async function readSearchableText(harness: FullSchemaPostgresHarness) {
  return await harness.sql<{ id: number; searchable_text: string | null }[]>`
    SELECT id, searchable_text FROM events WHERE session_id = ${SESSION_ID} ORDER BY id
  `;
}

async function readPayloadTypes(harness: FullSchemaPostgresHarness) {
  return await harness.sql<{ id: number; payload_type: string }[]>`
    SELECT id, jsonb_typeof(payload) AS payload_type
    FROM events WHERE session_id = ${SESSION_ID} ORDER BY id
  `;
}

async function readEventSearchTerms(harness: FullSchemaPostgresHarness) {
  return await harness.sql<{ event_id: number; term: string; term_freq: number; doc_len: number }[]>`
    SELECT p.event_id, d.term, p.term_freq, m.doc_len
    FROM event_search_postings p JOIN event_search_session_keys k USING (session_key)
    JOIN event_search_dictionary d USING (term_id)
    JOIN event_search_documents m USING (session_key, event_id)
    WHERE k.session_id = ${SESSION_ID}
    ORDER BY p.event_id, d.term
  `;
}
