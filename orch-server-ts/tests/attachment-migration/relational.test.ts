import { describe, expect, it } from "vitest";
import {
  collectLegacySourceTargets,
  extractRelationalSources,
} from "../../scripts/attachment-migration/extract_relational.js";
import {
  INVENTORY_CUTOFF_POLICY,
  INVENTORY_SCHEMA_VERSION,
  parseInventoryCutoff,
  type LegacySource,
} from "../../scripts/attachment-migration/inventory_contract.js";

const CUTOFF = "2026-10-17T00:00:00.000Z";
const sameOrigin = ["https://soulstream.example.test"];

function source(
  sourceKind: LegacySource["source_kind"],
  data: Record<string, unknown>,
  extra: Partial<LegacySource> = {},
): LegacySource {
  return {
    schema_version: INVENTORY_SCHEMA_VERSION,
    source_kind: sourceKind,
    source_table: "cards",
    source_pk: "card-1",
    source_pointer: "/",
    row_sha256: "a".repeat(64),
    created_at: CUTOFF,
    changed_after_cutoff: false,
    data,
    ...extra,
  };
}

describe("attachment inventory relational source parsing", () => {
  it("centralizes the created_at, updated_at, and file mtime cutoff policy", () => {
    expect(INVENTORY_CUTOFF_POLICY).toEqual({
      relational_created_at: "less_than_or_equal",
      events_created_at: "less_than_or_equal",
      updated_after_cutoff: "include_and_mark_changed_after_cutoff",
      file_mtime_after_cutoff: "hash_and_classify_after_cutoff",
    });
    expect(parseInventoryCutoff(CUTOFF)).toBe(CUTOFF);
    expect(() => parseInventoryCutoff("2026-10-17T00:00:00+09:00")).toThrow();
  });

  it.each([
    ["structured card attachments", source("card_request", { attachments: [{ nodeId: "node-a", path: "media\\그림.png" }] })],
    ["inline Markdown link", source("card_request", { request: "![그림](/api/attachments/files?nodeId=node-a&path=media%2Fa.png)" })],
    ["Markdown reference link", source("card_request", { request: "[그림]: /api/attachments/files?nodeId=node-a&path=media%2Fa.png" })],
    ["HTML src with escaped ampersand", source("report", { format: "html", body: '<img src="/api/attachments/files?nodeId=node-a&amp;path=media%2Fa.png">' }, { source_table: "card_reports", source_pk: "report-1" })],
    ["HTML href", source("comment", { format: "html", body: '<a href="/api/attachments/files?nodeId=node-a&amp;path=media%2Fa.png">열기</a>' }, { source_table: "card_comments", source_pk: "comment-1" })],
    ["item evidence URL", source("card_item", { items: [{ evidence: [{ type: "image", url: "/api/attachments/files?nodeId=node-a&path=media%2Fa.png" }] }] })],
    ["item result and caveat bodies", source("card_item", { items: [{ result: "![결과](/api/attachments/files?nodeId=node-a&path=result.png)", caveat: "![주의](/api/attachments/files?nodeId=node-a&path=caveat.png)" }] })],
    ["report Markdown body", source("report", { format: "markdown", body: "![보고](/api/attachments/files?nodeId=node-a&path=report.png)" }, { source_table: "card_reports", source_pk: "report-2" })],
    ["comment body", source("comment", { body: "![댓글](/api/attachments/files?nodeId=node-a&path=comment.png)" }, { source_table: "card_comments", source_pk: "comment-2" })],
    ["item history evidence/result/caveat", source("item_history", { operation_type: "report_card_item", payload_json: { evidence: [{ type: "image", url: "/api/attachments/files?nodeId=node-a&path=history-evidence.png" }], result: "![결과](/api/attachments/files?nodeId=node-a&path=history-result.png)", caveat: "![주의](/api/attachments/files?nodeId=node-a&path=history-caveat.png)" } }, { source_table: "folder_operations", source_pk: "operation-1" })],
  ])("extracts targets from %s", (_name, value) => {
    const targets = collectLegacySourceTargets(value, { allowedOrigins: sameOrigin });
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((target) => target.classification === "legacy_path")).toBe(true);
    expect(targets.every((target) => target.legacy_node_id === "node-a")).toBe(true);
  });

  it("ignores code fences and ordinary external links without fetching them", () => {
    const value = source("report", {
      format: "markdown",
      body: [
        "[외부](https://example.test/help)",
        "```",
        "![예시](/api/attachments/files?nodeId=node-a&path=inside.png)",
        "```",
      ].join("\n"),
    }, { source_table: "card_reports", source_pk: "report-fenced" });
    expect(collectLegacySourceTargets(value, { allowedOrigins: sameOrigin })).toEqual([]);
  });

  it("records one occurrence and its original body offset for a Markdown angle target", () => {
    const request = [
      "```",
      "![예시](/api/attachments/files?nodeId=node-a&path=inside.png)",
      "```",
      "![그림](</api/attachments/files?nodeId=node-a&path=media.png>)",
    ].join("\n");
    const targets = collectLegacySourceTargets(source("card_request", { request }), { allowedOrigins: sameOrigin });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ pointer: "/request", body_offset: request.indexOf("<") });
  });

  it("accepts only configured absolute origins and preserves unknown-origin routes as ambiguous", () => {
    const accepted = collectLegacySourceTargets(source("card_request", {
      request: "![x](https://soulstream.example.test/api/attachments/files?nodeId=node-a&path=media%2Fa.png)",
    }), { allowedOrigins: sameOrigin });
    expect(accepted).toMatchObject([{ classification: "legacy_path", legacy_node_id: "node-a", normalized_path: "media/a.png" }]);

    const ambiguous = collectLegacySourceTargets(source("card_request", {
      request: "![x](https://unknown.example.test/api/attachments/files?nodeId=node-a&path=media%2Fa.png)",
    }), { allowedOrigins: sameOrigin });
    expect(ambiguous).toMatchObject([{ classification: "ambiguous_url", reason: "unknown_origin" }]);

    const networkPath = collectLegacySourceTargets(source("card_request", {
      request: "![x](//unknown.example.test/api/attachments/files?nodeId=node-a&path=media%2Fa.png)",
    }), { allowedOrigins: sameOrigin });
    expect(networkPath).toMatchObject([{ classification: "ambiguous_url", reason: "unknown_origin" }]);
  });

  it.each([
    ["wrong route", "![x](/files?nodeId=node-a&path=a.png)", "unexpected_route"],
    ["duplicate nodeId", "![x](/api/attachments/files?nodeId=node-a&nodeId=node-b&path=a.png)", "duplicate_query_parameter"],
    ["missing nodeId", "![x](/api/attachments/files?path=a.png)", "missing_query_parameter"],
  ])("retains %s as ambiguous rather than dropping the source", (_name, request, reason) => {
    expect(collectLegacySourceTargets(source("card_request", { request }), { allowedOrigins: sameOrigin }))
      .toMatchObject([{ classification: "ambiguous_url", reason }]);
  });

  it("keeps current and historical references to the same path as separate sources", () => {
    const current = source("card_item", { items: [{ evidence: [{ url: "/api/attachments/files?nodeId=node-a&path=same.png" }] }] }, { source_pk: "card-1" });
    const history = source("item_history", { operation_type: "report_card_item", payload_json: { evidence: [{ url: "/api/attachments/files?nodeId=node-a&path=same.png" }] } }, { source_table: "folder_operations", source_pk: "operation-1" });
    expect(collectLegacySourceTargets(current, { allowedOrigins: sameOrigin })).toHaveLength(1);
    expect(collectLegacySourceTargets(history, { allowedOrigins: sameOrigin })).toHaveLength(1);
    expect(current.source_pk).not.toBe(history.source_pk);
  });

  it("points historical structured attachments back to their operation payload", () => {
    const history = source("item_history", {
      operation_type: "update_card",
      payload_json: { attachments: [{ nodeId: "node-a", path: "history.png" }] },
    }, { source_table: "folder_operations", source_pk: "operation-2" });
    expect(collectLegacySourceTargets(history, { allowedOrigins: sameOrigin }))
      .toMatchObject([{ pointer: "/payload_json/attachments/0/path", legacy_node_id: "node-a" }]);
  });

  it("keeps unverified managed-note URLs as ambiguous", () => {
    const note = source("note", { body: "![x](/api/attachments/files?nodeId=node-a&path=note.png)" }, { source_table: "card_comments", source_pk: "note-1" });
    expect(collectLegacySourceTargets(note, { allowedOrigins: sameOrigin }))
      .toMatchObject([{ classification: "ambiguous_url", reason: "managed_note_unverified" }]);
  });

  it("rejects invalid page size and non-UTC cutoff before opening a database transaction", async () => {
    const sql = Object.assign(async () => [], { begin: async () => { throw new Error("must not open a transaction"); } });
    await expect(collect(extractRelationalSources(sql as never, { pageSize: 0, cutoff: CUTOFF })))
      .rejects.toThrow("pageSize");
    await expect(collect(extractRelationalSources(sql as never, { pageSize: 1, cutoff: "2026-10-17T00:00:00+09:00" })))
      .rejects.toThrow("UTC");
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
