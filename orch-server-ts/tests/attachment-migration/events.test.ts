import { describe, expect, it, vi } from "vitest";

import { extractSessionAttachmentSources } from "../../scripts/attachment-migration/extract_events.js";
import { buildLegacyAttachmentPlan } from "../../scripts/attachment-migration/build_plan.js";
import {
  FILE_OBSERVATION_STATUS,
  INVENTORY_EVENT_PROGRESS_STATE,
  INVENTORY_PLAN_STATUS,
  INVENTORY_SCHEMA_VERSION,
  type FileObservation,
  type EventExtractionProgress,
  type InventoryNodeCoverage,
  type InventoryRunBundleMetadata,
  type InventorySessionCoverage,
} from "../../scripts/attachment-migration/inventory_contract.js";

const CUTOFF = "2026-10-17T00:00:00.000Z";

describe("session event attachment inventory", () => {
  it("separates string paths, attachment IDs, and explicit output descriptors", async () => {
    const payload = {
      text: "요청\n\n[첨부 파일 로컬 경로: /incoming/a.png]",
      attachments: ["/incoming/a.png"],
      attachment_ids: ["asset-a"],
    };
    const descriptors = [{ attachment_id: "output-a", name: "result.png", mime_type: "image/png" }];
    const sources = await collect(extractSessionAttachmentSources(fakeSql([
      page("session-a", "historical-node", [event(7, "user_message", payload, CUTOFF)]),
      page("session-a", "historical-node", [event(8, "assistant_message", { attachments: descriptors }, CUTOFF)]),
      page("session-a", "historical-node", []),
    ]), ["session-a"], { pageSize: 1, cutoff: CUTOFF, onProgress: () => undefined }));

    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      schema_version: INVENTORY_SCHEMA_VERSION,
      source_kind: "message",
      source_table: "events",
      source_pk: "7",
      session_id: "session-a",
      data: { source_node_id: "historical-node", event_type: "user_message" },
    });
    expect(sources[0]!.data.attachment_candidates).toEqual([
      { pointer: "/payload/attachments/0", kind: "input_path", value: "/incoming/a.png" },
      { pointer: "/payload/attachment_ids/0", kind: "attachment_id", value: "asset-a" },
      { pointer: "/payload/text/managed_path_notes/0", kind: "managed_path_note", value: "/incoming/a.png", verified: true },
    ]);
    expect(sources[1]!.data.attachment_candidates).toEqual([
      { pointer: "/payload/attachments/0", kind: "output_descriptor", value: descriptors[0] },
    ]);
  });

  it("retains unverified managed notes and reports progress across empty pages", async () => {
    const onProgress = vi.fn<(progress: EventExtractionProgress) => void>();
    const sources = await collect(extractSessionAttachmentSources(fakeSql([
      page("session-a", "node-a", [
        event(10, "heartbeat", {}, CUTOFF),
        event(11, "user_message", { text: "[첨부 파일 로컬 경로: /incoming/missing.png]" }, CUTOFF),
      ]),
      page("session-a", "node-a", [event(12, "intervention_sent", { attachments: ["/incoming/next.png"] }, CUTOFF)]),
    ]), ["session-a"], { pageSize: 2, cutoff: CUTOFF, onProgress }));

    expect(sources).toHaveLength(2);
    expect(sources[0]!.source_pk).toBe("11");
    expect(sources[0]!.data.attachment_candidates).toEqual([
      { pointer: "/payload/text/managed_path_notes/0", kind: "managed_path_note", value: "/incoming/missing.png", verified: false },
    ]);
    expect(onProgress.mock.calls.map(([progress]) => [progress.state, progress.cursor?.eventId, progress.coverage_complete])).toEqual([
      ["page", 11, false], ["page", 12, false], ["complete", 12, true],
    ]);
    expect(Object.values(INVENTORY_EVENT_PROGRESS_STATE)).toContain("source_changed");
  });

  it("marks a missing source session and continues with later sessions", async () => {
    const onProgress = vi.fn<(progress: EventExtractionProgress) => void>();
    const sources = await collect(extractSessionAttachmentSources(fakeSql([
      [{ requested_session_id: "deleted-session", found_session_id: null, source_node_id: null, event_id: null }],
      page("session-b", "node-b", [event(3, "user_message", { attachment_ids: ["asset-b"] }, CUTOFF)]),
    ]), ["deleted-session", "session-b"], { pageSize: 2, cutoff: CUTOFF, onProgress }));

    expect(sources).toHaveLength(1);
    expect(sources[0]!.session_id).toBe("session-b");
    expect(onProgress.mock.calls.map(([progress]) => [progress.session_id, progress.state, progress.error_code])).toEqual([
      ["deleted-session", "source_changed", "INVENTORY_SOURCE_CHANGED"],
      ["session-b", "page", undefined],
      ["session-b", "complete", undefined],
    ]);
  });

  it("reports an empty session complete with its session identity", async () => {
    const onProgress = vi.fn<(progress: EventExtractionProgress) => void>();
    await expect(collect(extractSessionAttachmentSources(fakeSql([
      page("empty-session", "node-empty", []),
    ]), ["empty-session"], { pageSize: 5, cutoff: CUTOFF, onProgress }))).resolves.toEqual([]);
    expect(onProgress).toHaveBeenCalledWith({
      session_id: "empty-session",
      state: "complete",
      cursor: { sessionId: "empty-session", eventId: 0 },
      coverage_complete: true,
      started_at: expect.any(String),
      observed_at: expect.any(String),
      ended_at: expect.any(String),
    });
  });

  it("carries explicit caller ownership from extracted event into a proposed plan", async () => {
    const sessionId = "session-owner";
    const callerEmail = ["inventory-owner", "example.test"].join("@");
    const sources = await collect(extractSessionAttachmentSources(fakeSql([
      page(sessionId, "node-a", [event(31, "user_message", {
        attachments: ["message.png"],
        caller_info: { source: "browser", email: callerEmail },
      }, CUTOFF)]),
    ]), [sessionId], { pageSize: 10, cutoff: CUTOFF, onProgress: () => undefined }));
    const source = sources[0]!;
    const observation: FileObservation = {
      record_type: "file",
      schema_version: INVENTORY_SCHEMA_VERSION,
      node_id: "node-a",
      status: FILE_OBSERVATION_STATUS.observed,
      known_source_paths: ["message.png"],
      incoming_relative_path: "message.png",
      physical_path: "/srv/incoming/message.png",
      source_refs: [{ source_kind: source.source_kind, source_table: source.source_table, source_pk: source.source_pk, source_pointer: "/payload/attachments/0", session_id: sessionId }],
      size_bytes: 12,
      bytes_read: 12,
      mtime_ms: new Date(CUTOFF).getTime(),
      mtime: CUTOFF,
      sha256: "a".repeat(64),
      after_cutoff: false,
      eligible_candidate: true,
      coverage_complete: true,
    };
    const nodeCoverage: InventoryNodeCoverage = {
      record_type: "node_coverage",
      schema_version: INVENTORY_SCHEMA_VERSION,
      node_id: "node-a",
      status: "scanned",
      coverage_complete: true,
      observed_at: CUTOFF,
    };
    const metadata: InventoryRunBundleMetadata = {
      record_type: "run_metadata",
      schema_version: INVENTORY_SCHEMA_VERSION,
      scan_id: "scan-event-owner",
      baseline_sha: "88cab796",
      cutoff: CUTOFF,
      expected_node_ids: ["node-a"],
      relational_coverage_complete: true,
      event_session_ids: [sessionId],
      alias_snapshot_complete: true,
      stages: {
        relational: { started_at: CUTOFF, ended_at: CUTOFF },
        events: { started_at: CUTOFF, ended_at: CUTOFF },
        node_scan: { started_at: CUTOFF, ended_at: CUTOFF },
      },
    };
    const sessionCoverage: InventorySessionCoverage = {
      record_type: "session_coverage",
      schema_version: INVENTORY_SCHEMA_VERSION,
      session_id: sessionId,
      state: "complete",
      cursor: { sessionId, eventId: 31 },
      coverage_complete: true,
      started_at: CUTOFF,
      observed_at: CUTOFF,
      ended_at: CUTOFF,
    };

    const plan = buildLegacyAttachmentPlan({
      sources,
      observations: [observation],
      assets: [],
      aliases: [],
      nodeCoverage: [nodeCoverage],
      metadata,
      sessionCoverage: [sessionCoverage],
    });

    expect(sources).toHaveLength(1);
    expect(plan.identities).toHaveLength(1);
    expect(plan.identities[0]?.status).toBe(INVENTORY_PLAN_STATUS.verified_source);
    expect(plan.identities[0]?.owner.status).toBe("verified");
    expect(plan.identities[0]?.proposed_asset_id).toBeDefined();
    expect(plan.summary.proposed_message_refs).toBe(1);
  });

  it("uses only the source session ID and applies keyset plus cutoff before paging", async () => {
    const sql = fakeSql([
      page("source-session", "source-node", [event(5, "user_message", { attachments: ["/incoming/x.png"] }, CUTOFF)]),
    ]);
    const sources = await collect(extractSessionAttachmentSources(sql, ["source-session"], {
      pageSize: 10,
      cutoff: CUTOFF,
      after: { sessionId: "source-session", eventId: 4 },
      onProgress: () => undefined,
    }));

    expect(sources[0]!.session_id).toBe("source-session");
    expect(sources[0]!.data.source_node_id).toBe("source-node");
    expect(sql.statements.join("\n")).toMatch(/session_id/);
    expect(sql.statements.join("\n")).toMatch(/id\s*>/i);
    expect(sql.statements.join("\n")).toMatch(/created_at\s*<=/i);
    expect(sql.values).toContain(4);
    expect(sql.values).toContainEqual(new Date(CUTOFF));
    expect(sql.statements.join("\n")).toMatch(/SET TRANSACTION READ ONLY/i);
  });

  it("rejects non-UTC cutoff before opening a database transaction", async () => {
    const sql = fakeSql([]);
    await expect(collect(extractSessionAttachmentSources(sql, ["session-a"], {
      pageSize: 1,
      cutoff: "2026-10-17T09:00:00+09:00",
      onProgress: () => undefined,
    }))).rejects.toThrow(/UTC/);
    expect(sql.statements).toEqual([]);
  });
});

function event(id: number, eventType: string, payload: unknown, createdAt: string) {
  return {
    requested_session_id: "session-a",
    found_session_id: "session-a",
    source_node_id: "node-a",
    event_id: id,
    event_type: eventType,
    attachment_payload: payload,
    created_at: new Date(createdAt),
  };
}

function page(sessionId: string, nodeId: string | null, rows: Array<ReturnType<typeof event>>) {
  if (rows.length === 0) return [{ requested_session_id: sessionId, found_session_id: sessionId, source_node_id: nodeId, event_id: null }];
  return rows.map((row) => ({ ...row, requested_session_id: sessionId, found_session_id: sessionId, source_node_id: nodeId }));
}

type FakeSql = {
  <T extends readonly Record<string, unknown>[] = Array<Record<string, unknown>>>(
    strings: TemplateStringsArray,
    ...params: unknown[]
  ): Promise<T>;
  begin<T>(callback: (transaction: FakeSql) => Promise<T>): Promise<T>;
  statements: string[];
  values: unknown[];
};

function fakeSql(pages: Array<Array<Record<string, unknown>>>): FakeSql {
  const statements: string[] = [];
  const values: unknown[] = [];
  const query = (async (strings: TemplateStringsArray, ...params: unknown[]) => {
    const statement = strings.join(" ");
    statements.push(statement);
    values.push(...params);
    return (statement.includes("FROM (VALUES") ? (pages.shift() ?? []) : []) as never;
  }) as unknown as FakeSql;
  query.begin = async <T>(callback: (transaction: FakeSql) => Promise<T>) => callback(query);
  query.statements = statements;
  query.values = values;
  return query;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
