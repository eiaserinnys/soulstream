import { describe, expect, it } from "vitest";

import { parseCardBackfillArgs } from "../../scripts/attachment-migration/backfill_card_refs.js";

describe("card attachment ref backfill arguments", () => {
  it("defaults to dry-run and requires the approved manifest hash for writes", () => {
    const dryRun = parseCardBackfillArgs(["--manifest", "manifest.jsonl", "--output", "report.jsonl"]);
    expect(dryRun.apply).toBe(false);
    expect(dryRun.limit).toBeUndefined();
    expect(dryRun.only).toBeUndefined();
    expect(() => parseCardBackfillArgs([
      "--manifest", "manifest.jsonl", "--output", "report.jsonl", "--apply",
    ])).toThrow(expect.objectContaining({ code: "APPROVAL_REQUIRED" }));

    expect(parseCardBackfillArgs([
      "--manifest", "manifest.jsonl", "--output", "report.jsonl", "--apply",
      "--approved-manifest-sha256", "b".repeat(64), "--limit", "1", "--only", "identity-card-a",
    ])).toMatchObject({
      apply: true, approvedManifestSha256: "b".repeat(64), limit: 1, only: "identity-card-a",
    });
  });
});
