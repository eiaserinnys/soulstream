import { describe, expect, it } from "vitest";

import {
  mergeMessageAttachmentPayload,
  parseMessageBackfillArgs,
} from "../../scripts/attachment-migration/backfill_message_refs.js";

describe("message attachment ref backfill", () => {
  it("adds unique resolved IDs and recomputes count without changing message content", () => {
    const original = {
      text: "keep this text",
      attachments: ["/legacy/a.png", "/legacy/a.png", "/legacy/b.png"],
      attachment_paths: ["/legacy/b.png"],
      attachment_bindings: [
        { attachment_id: "asset-a", node_id: "node-a", path: "/legacy/a.png" },
        { attachment_id: "unrelated", node_id: "node-a", path: "/legacy/b.png" },
      ],
      attachment_ids: ["asset-existing", "asset-existing"],
      attachment_count: 99,
      timestamp: "2026-10-17T00:00:00.000Z",
      caller_info: { source: "browser", display_name: "사용자" },
    };

    const result = mergeMessageAttachmentPayload(original, ["asset-a", "asset-new", "asset-new"]);

    expect(result).toEqual({
      ...original,
      attachment_ids: ["asset-existing", "asset-a", "asset-new"],
      attachment_count: 4,
    });
    expect(result.text).toBe(original.text);
    expect(result.attachments).toBe(original.attachments);
    expect(result.timestamp).toBe(original.timestamp);
    expect(result.caller_info).toBe(original.caller_info);
  });

  it("defaults to dry-run and requires both apply and the approved manifest hash for writes", () => {
    const origins = JSON.stringify(["https://soulstream.eiaserinnys.me"]);
    const dryRun = parseMessageBackfillArgs(["--manifest", "manifest.jsonl", "--output", "report.jsonl", "--allowed-origins", origins]);
    expect(dryRun.apply).toBe(false);
    expect(dryRun.limit).toBeUndefined();
    expect(dryRun.only).toBeUndefined();
    expect(dryRun.allowedOrigins).toEqual(["https://soulstream.eiaserinnys.me"]);
    expect(() => parseMessageBackfillArgs([
      "--manifest", "manifest.jsonl", "--output", "report.jsonl", "--allowed-origins", origins, "--apply",
    ])).toThrow(expect.objectContaining({ code: "APPROVAL_REQUIRED" }));

    const apply = parseMessageBackfillArgs([
      "--manifest", "manifest.jsonl", "--output", "report.jsonl", "--allowed-origins", origins, "--apply",
      "--approved-manifest-sha256", "a".repeat(64), "--limit", "2", "--only", "identity-a",
    ]);
    expect(apply).toMatchObject({ apply: true, allowedOrigins: ["https://soulstream.eiaserinnys.me"], approvedManifestSha256: "a".repeat(64), limit: 2, only: "identity-a" });
  });
});
