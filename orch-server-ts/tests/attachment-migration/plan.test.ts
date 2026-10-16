import { describe, expect, it } from "vitest";

import { buildLegacyAttachmentPlan } from "../../scripts/attachment-migration/build_plan.js";
import {
  FILE_OBSERVATION_STATUS,
  INVENTORY_PLAN_STATUS,
  INVENTORY_SCHEMA_VERSION,
  type FileObservation,
  type InventoryAliasSnapshot,
  type InventoryAssetSnapshot,
  type InventoryNodeCoverage,
  type InventoryRunBundleMetadata,
  type LegacySource,
  type NodeScanSummary,
} from "../../scripts/attachment-migration/inventory_contract.js";

const CUTOFF = "2026-10-17T00:00:00.000Z";

describe("legacy attachment plan", () => {
  it("merges the same path into one identity while preserving every source reference", () => {
    const sharedScope = { type: "card" as const, id: "shared" };
    const first = source("card-a", "media/a.png", sharedScope);
    const second = source("card-b", "media/a.png", sharedScope);
    const plan = buildLegacyAttachmentPlan(input({ sources: [first, second], observations: [observed("media/a.png", [first, second])] }));

    expect(plan.identities).toHaveLength(1);
    expect(plan.identities[0]).toMatchObject({
      legacy_node_id: "node-a",
      normalized_path: "media/a.png",
      status: INVENTORY_PLAN_STATUS.verified_source,
    });
    expect(plan.identities[0]?.references).toHaveLength(2);
    expect(plan.identities[0]?.proposed_asset_id).toMatch(/^legacy_[0-9a-f]{24}$/);
  });

  it("keeps different legacy paths and ACL scopes as separate asset plans for identical bytes", () => {
    const first = source("card-a", "a/shared.png", { type: "card", id: "card-a" });
    const second = source("card-b", "b/shared.png", { type: "card", id: "card-b" });
    const observations = [observed("a/shared.png", [first]), observed("b/shared.png", [second])];
    const plan = buildLegacyAttachmentPlan(input({ sources: [first, second], observations }));

    expect(plan.identities).toHaveLength(2);
    expect(new Set(plan.identities.map((item) => item.proposed_asset_id)).size).toBe(2);
    expect(plan.identities.map((item) => item.sha256)).toEqual([
      "a".repeat(64),
      "a".repeat(64),
    ]);
    expect(plan.summary.duplicate_byte_groups).toBe(1);
  });

  it("keeps one location identity when references have conflicting ACL provenance", () => {
    const first = source("card-a", "shared.png", { type: "card", id: "card-a" });
    const second = source("card-b", "shared.png", { type: "card", id: "card-b" }, "node-a", "different-owner@example.test");
    const plan = buildLegacyAttachmentPlan(input({ sources: [first, second], observations: [observed("shared.png", [first, second])] }));

    expect(plan.identities).toHaveLength(1);
    expect(plan.identities[0]?.references).toHaveLength(2);
    expect(plan.identities[0]?.owner).toMatchObject({ status: "unverified", reason: expect.stringContaining("conflict") });
    expect(plan.identities[0]?.status).toBe(INVENTORY_PLAN_STATUS.owner_unverified);
    expect(plan.identities[0]?.proposed_asset_id).toBeUndefined();
  });

  it("uses a private proposal when the same verified owner has different source scopes", () => {
    const first = source("card-a", "shared.png", { type: "card", id: "card-a" });
    const second = source("card-b", "shared.png", { type: "card", id: "card-b" });
    const plan = buildLegacyAttachmentPlan(input({ sources: [first, second], observations: [observed("shared.png", [first, second])] }));

    expect(plan.identities[0]?.owner).toMatchObject({ status: "unverified", reason: expect.stringContaining("scope") });
    expect(plan.identities[0]?.proposed_owner).toBeNull();
    expect(plan.identities[0]?.proposed_asset_id).toBeDefined();
  });

  it("joins census-only observations by physical path and isolates explicit source absences", () => {
    const censusPath = "/srv/incoming/census.png";
    const missingPath = "/srv/incoming/missing.png";
    const unobservedInsideRootPath = "/srv/incoming/not-listed.png";
    const outsidePath = "/srv/archive/outside.png";
    const windowsPath = "C:\\Legacy\\Incoming\\photo.png";
    const censusSource = source("census", censusPath, { type: "card", id: "census" });
    const missingSource = source("missing", missingPath, { type: "card", id: "missing" });
    const unobservedInsideRootSource = source("not-listed", unobservedInsideRootPath, { type: "card", id: "not-listed" });
    const outsideSource = source("outside", outsidePath, { type: "card", id: "outside" });
    const windowsSource = source("windows", windowsPath, { type: "card", id: "windows" }, "node-win");
    const censusObservation = observed("census.png", [censusSource], {
      known_source_paths: [],
      source_refs: [],
      incoming_relative_path: "census.png",
      physical_path: censusPath,
    });
    const windowsObservation = {
      ...observed("photo.png", [windowsSource], {
        known_source_paths: [],
        source_refs: [],
        incoming_relative_path: "photo.png",
        physical_path: "c:/legacy/incoming/PHOTO.PNG",
      }),
      node_id: "node-win",
    };
    const missingObservation: FileObservation = {
      ...censusObservation,
      status: FILE_OBSERVATION_STATUS.source_absent,
      known_source_paths: [missingPath],
      incoming_relative_path: undefined,
      physical_path: missingPath,
      source_refs: [{ source_kind: "card_request", source_table: "cards", source_pk: "missing", source_pointer: "/attachments/0/path", card_id: "missing" }],
      size_bytes: undefined,
      bytes_read: undefined,
      sha256: undefined,
      eligible_candidate: false,
      coverage_complete: false,
    };
    const metadata = bundle({ expected_node_ids: ["node-a", "node-win"] });
    const plan = buildLegacyAttachmentPlan({
      ...input({ sources: [censusSource, missingSource, unobservedInsideRootSource, outsideSource, windowsSource], metadata }),
      observations: [censusObservation, windowsObservation, missingObservation],
      nodeCoverage: [
        censusSummary("node-a", "/srv/incoming", { observed: 1, source_absent: 1 }, false),
        censusSummary("node-win", "C:\\Legacy\\Incoming", { observed: 1 }, true),
      ],
    });

    const byPath = new Map(plan.identities.map((item) => [item.normalized_path, item]));
    expect(byPath.get(censusPath)).toMatchObject({ status: INVENTORY_PLAN_STATUS.verified_source, physical_path: censusPath });
    expect(byPath.get(windowsPath.replace(/\\/g, "/"))).toMatchObject({ status: INVENTORY_PLAN_STATUS.verified_source, physical_path: "c:/legacy/incoming/PHOTO.PNG" });
    expect(byPath.get(missingPath)?.status).toBe(INVENTORY_PLAN_STATUS.absent_at_source);
    expect(byPath.get(unobservedInsideRootPath)?.status).toBe(INVENTORY_PLAN_STATUS.absent_at_source);
    expect(byPath.get(outsidePath)?.status).toBe(INVENTORY_PLAN_STATUS.unconfirmed_node);
    expect(plan.coverage_complete).toBe(false);
  });

  it.each(["card_request", "card_item", "item_history", "report", "comment", "note", "message"] as const)(
    "proposes a private ref from %s source evidence when owner provenance is absent",
    (sourceKind) => {
      const reference = sourceFor(sourceKind);
      const file = observed("card.png", [reference], { source_refs: [] });
      const plan = buildLegacyAttachmentPlan(input({ sources: [reference], observations: [file] }));

      expect(plan.identities).toHaveLength(1);
      expect(plan.identities[0]).toMatchObject({
        status: INVENTORY_PLAN_STATUS.owner_unverified,
        owner: { status: "unverified" },
        proposed_owner: null,
        proposed_asset_id: expect.stringMatching(/^legacy_[0-9a-f]{24}$/),
        references: [expect.objectContaining({ source_kind: sourceKind })],
      });
      expect(plan.identities[0]?.references[0]?.session_id).toBe(sourceKind === "message" ? "actual-session" : undefined);
      expect(plan.summary.proposed_message_refs).toBe(sourceKind === "message" ? 1 : 0);
      expect(plan.summary.proposed_card_refs).toBe(sourceKind === "message" ? 0 : 1);
    },
  );

  it("keeps an unreferenced incoming file as a preservation candidate without making coverage incomplete", () => {
    const file = observed("orphan.png", [], {
      known_source_paths: [],
      incoming_relative_path: "orphan.png",
      source_refs: [],
      size_bytes: 27,
      physical_path: "/srv/incoming/orphan.png",
    });
    const plan = buildLegacyAttachmentPlan(input({ observations: [file] }));

    expect(plan.identities).toHaveLength(1);
    expect(plan.identities[0]).toMatchObject({
      status: "unreferenced_preservation_candidate",
      unreferenced_incoming: true,
      references: [],
    });
    expect(plan.identities[0]?.proposed_asset_id).toBeUndefined();
    expect(plan.coverage_complete).toBe(true);
    expect(plan.summary.unconfirmed).toEqual([]);
    expect(plan.summary.preservation_target_count).toBe(1);
    expect(plan.summary.preservation_target_bytes).toBe(27);
  });

  it("matches each report path to its own observation when one body contains multiple files", () => {
    const report: LegacySource = {
      schema_version: INVENTORY_SCHEMA_VERSION,
      source_kind: "report",
      source_table: "card_reports",
      source_pk: "report-a",
      source_pointer: "/body",
      row_sha256: "c".repeat(64),
      created_at: CUTOFF,
      changed_after_cutoff: false,
      data: {
        format: "markdown",
        body: "![A](/api/attachments/files?nodeId=node-a&path=a.png) ![B](/api/attachments/files?nodeId=node-a&path=b.png)",
      },
    };
    const files = [
      observed("a.png", [report], { size_bytes: 11, bytes_read: 11, sha256: "a".repeat(64), known_source_paths: ["a.png"], source_refs: [reportReference()] }),
      observed("b.png", [report], { size_bytes: 22, bytes_read: 22, sha256: "b".repeat(64), known_source_paths: ["b.png"], source_refs: [reportReference()] }),
    ];
    const plan = buildLegacyAttachmentPlan(input({ sources: [report], observations: files }));

    expect(plan.identities.map((item) => [item.normalized_path, item.size_bytes, item.sha256])).toEqual([
      ["a.png", 11, "a".repeat(64)],
      ["b.png", 22, "b".repeat(64)],
    ]);
  });

  it("preserves cutoff drift for file_assets and board_items", () => {
    const fileAsset: LegacySource = {
      ...source("asset-row", "unused.png", { type: "card", id: "scope" }),
      source_kind: "existing_asset",
      source_table: "file_assets",
      updated_at: "2026-10-18T00:00:00.000Z",
      changed_after_cutoff: false,
      data: { storage_purpose: "attachment", upload_status: "committed", storage_key: "a", storage_endpoint: "e", storage_bucket: "b" },
    };
    const boardItem: LegacySource = {
      ...source("board-row", "unused.png", { type: "card", id: "scope" }),
      source_kind: "existing_asset",
      source_table: "board_items",
      updated_at: "2026-10-18T00:00:00.000Z",
      changed_after_cutoff: false,
      data: { item_type: "asset", item_id: "board-asset" },
    };
    const plan = buildLegacyAttachmentPlan(input({
      sources: [fileAsset, boardItem],
      assets: [{ id: "board-asset", storage_purpose: "board", upload_status: "committed", storage_verified: true }],
    }));

    expect(plan.existing_assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "asset-row", changed_after_cutoff: true })]));
    expect(plan.direct_references).toEqual(expect.arrayContaining([expect.objectContaining({ source_pk: "board-row", changed_after_cutoff: true })]));
    expect(plan.anomalies.filter((item) => item.code === "changed_after_cutoff")).toHaveLength(2);
    expect(plan.coverage_complete).toBe(false);
  });

  it("does not count sources created after the cutoff", () => {
    const future = { ...source("future", "future.png", { type: "card", id: "future" }), created_at: "2026-10-18T00:00:00.000Z" };
    const plan = buildLegacyAttachmentPlan(input({ sources: [future] }));

    expect(plan.summary.reference_occurrences).toBe(0);
    expect(plan.summary.distinct_legacy_identities).toBe(0);
    expect(plan.coverage_complete).toBe(true);
  });

  it("distinguishes resolved, pending, and previously missing aliases", () => {
    const names = ["resolved.png", "pending.png", "missing.png"];
    const sources = names.map((name, index) => source(`card-${index}`, name, { type: "card", id: `card-${index}` }));
    const assets: InventoryAssetSnapshot[] = [
      asset("asset-resolved", "committed"),
      asset("asset-pending", "pending"),
    ];
    const aliases: InventoryAliasSnapshot[] = [
      alias("resolved.png", "asset-resolved", "resolved"),
      alias("pending.png", "asset-pending", "resolved"),
      alias("missing.png", null, "missing"),
    ];
    const plan = buildLegacyAttachmentPlan(input({
      sources,
      observations: names.map((name, index) => observed(name, [sources[index]!])),
      assets,
      aliases,
    }));

    expect(plan.identities.map((item) => item.status)).toEqual([
      INVENTORY_PLAN_STATUS.already_migrated,
      INVENTORY_PLAN_STATUS.pending_or_temporary,
      INVENTORY_PLAN_STATUS.existing_alias_missing,
    ]);
  });

  it.each(["offline", "http_502"] as const)("keeps %s nodes unconfirmed instead of counting zero files", (status) => {
    const reference = source("card-a", "missing.png", { type: "card", id: "card-a" });
    const metadata = bundle({ expected_node_ids: ["node-a"] });
    const nodeCoverage: InventoryNodeCoverage[] = [{
      record_type: "node_coverage",
      schema_version: INVENTORY_SCHEMA_VERSION,
      node_id: "node-a",
      status,
      coverage_complete: false,
      observed_at: CUTOFF,
    }];
    const plan = buildLegacyAttachmentPlan({ ...input({ sources: [reference], metadata }), nodeCoverage });

    expect(plan.summary.coverage_complete).toBe(false);
    expect(plan.summary.unconfirmed_count).toBeGreaterThan(0);
    expect(plan.summary.confirmed_missing_count).toBe(0);
    expect(plan.identities[0]?.status).toBe(INVENTORY_PLAN_STATUS.unconfirmed_node);
    expect(plan.summary.nodes[0]).toMatchObject({ file_count: null, bytes: null, hash_coverage: null });
    expect(plan.summary.unknown_size_count).toBe(1);
  });

  it("adds known sizes without treating unknown sizes as zero", () => {
    const knownSource = source("known", "known.png", { type: "card", id: "known" });
    const unknownSource = source("unknown", "unknown.png", { type: "card", id: "unknown" });
    const known = observed("known.png", [knownSource], { size_bytes: 13 });
    const unknown = observed("unknown.png", [unknownSource], { size_bytes: undefined, sha256: undefined });
    const plan = buildLegacyAttachmentPlan(input({
      sources: [knownSource, unknownSource],
      observations: [known, unknown],
    }));

    expect(plan.summary.known_size_total).toBe(13);
    expect(plan.summary.unknown_size_count).toBe(1);
  });

  it("reports unsafe names and declared MIME mismatches", () => {
    const reference = source("card-a", "photo.png", { type: "card", id: "card-a" });
    const plan = buildLegacyAttachmentPlan(input({
      sources: [reference],
      observations: [observed("photo.png", [reference])],
      assets: [{ ...asset("asset-a", "committed"), original_name: "folder/photo.png", mime_type: "image/jpeg" }],
    }));

    expect(plan.anomalies.map((item) => item.code)).toEqual(expect.arrayContaining([
      "path_separator_in_name",
      "mime_mismatch",
    ]));
  });
});

function reportReference() {
  return { source_kind: "report" as const, source_table: "card_reports" as const, source_pk: "report-a", source_pointer: "/body" };
}

function input(overrides: Partial<{
  sources: LegacySource[];
  observations: FileObservation[];
  assets: InventoryAssetSnapshot[];
  aliases: InventoryAliasSnapshot[];
  nodeCoverage: Array<InventoryNodeCoverage | NodeScanSummary>;
  metadata: InventoryRunBundleMetadata;
}> = {}) {
  return {
    sources: [],
    observations: [],
    assets: [],
    aliases: [],
    nodeCoverage: [scannedNode()],
    metadata: bundle(),
    ...overrides,
  };
}

function bundle(overrides: Partial<InventoryRunBundleMetadata> = {}): InventoryRunBundleMetadata {
  return {
    record_type: "run_metadata",
    schema_version: INVENTORY_SCHEMA_VERSION,
    scan_id: "scan-245",
    baseline_sha: "88cab796",
    cutoff: CUTOFF,
    expected_node_ids: ["node-a"],
    relational_coverage_complete: true,
    event_session_ids: [],
    alias_snapshot_complete: true,
    stages: {
      relational: { started_at: "2026-10-16T23:00:00.000Z", ended_at: "2026-10-16T23:01:00.000Z" },
      events: { started_at: "2026-10-16T23:02:00.000Z", ended_at: "2026-10-16T23:03:00.000Z" },
      node_scan: { started_at: "2026-10-16T23:04:00.000Z", ended_at: "2026-10-16T23:05:00.000Z" },
    },
    ...overrides,
  };
}

function scannedNode(): InventoryNodeCoverage {
  return {
    record_type: "node_coverage",
    schema_version: INVENTORY_SCHEMA_VERSION,
    node_id: "node-a",
    status: "scanned",
    coverage_complete: true,
    observed_at: CUTOFF,
  };
}

function source(id: string, legacyPath: string, scope: { type: "card"; id: string }, nodeId = "node-a", ownerKey = "owner@example.test"): LegacySource {
  return {
    schema_version: INVENTORY_SCHEMA_VERSION,
    source_kind: "card_request",
    source_table: "cards",
    source_pk: id,
    source_pointer: "/",
    row_sha256: "b".repeat(64),
    created_at: CUTOFF,
    updated_at: CUTOFF,
    changed_after_cutoff: false,
    card_id: id,
    data: {
      request: "",
      attachments: [{ nodeId, path: legacyPath }],
      owner_kind: "user_email",
      owner_key: ownerKey,
      registration_scope: scope,
    },
  };
}

function sourceFor(sourceKind: "card_request" | "card_item" | "item_history" | "report" | "comment" | "note" | "message"): LegacySource {
  const common = {
    schema_version: INVENTORY_SCHEMA_VERSION,
    source_kind: sourceKind,
    source_table: sourceKind === "message" ? "events" as const : sourceKind === "report" ? "card_reports" as const
      : sourceKind === "comment" || sourceKind === "note" ? "card_comments" as const
        : sourceKind === "item_history" ? "folder_operations" as const : "cards" as const,
    source_pk: `${sourceKind}-source`,
    source_pointer: "/",
    row_sha256: "d".repeat(64),
    created_at: CUTOFF,
    changed_after_cutoff: false,
    ...(sourceKind === "message" ? { session_id: "actual-session" } : { card_id: "card-source" }),
  };
  const target = "/api/attachments/files?nodeId=node-a&path=card.png";
  const data: Record<string, unknown> = sourceKind === "card_request"
    ? { request: "", attachments: [{ nodeId: "node-a", path: "card.png" }] }
    : sourceKind === "card_item"
      ? { items: [{ evidence: [{ url: target }] }] }
      : sourceKind === "item_history"
        ? { payload_json: { attachments: [{ nodeId: "node-a", path: "card.png" }] } }
        : sourceKind === "message"
          ? { source_node_id: "node-a", event_id: 42, attachment_candidates: [{ pointer: "/attachments/0", kind: "input_path", value: "card.png" }] }
          : { format: "markdown", body: `![file](${target})` };
  return { ...common, data } as LegacySource;
}

function censusSummary(nodeId: string, incomingRoot: string, statusCounts: NodeScanSummary["status_counts"], coverageComplete: boolean): NodeScanSummary {
  return {
    record_type: "summary",
    schema_version: INVENTORY_SCHEMA_VERSION,
    node_id: nodeId,
    cutoff: CUTOFF,
    started_at: CUTOFF,
    ended_at: CUTOFF,
    coverage_complete: coverageComplete,
    file_count: statusCounts.observed ?? 0,
    bytes_hashed: 10,
    hashes_completed: statusCounts.observed ?? 0,
    after_cutoff_count: 0,
    status_counts: statusCounts,
    incoming_root: incomingRoot,
    incoming_census_complete: true,
  };
}

function observed(path: string, sources: LegacySource[], patch: Partial<FileObservation> = {}): FileObservation {
  return {
    record_type: "file",
    schema_version: INVENTORY_SCHEMA_VERSION,
    node_id: "node-a",
    status: FILE_OBSERVATION_STATUS.observed,
    known_source_paths: [path],
    incoming_relative_path: path,
    physical_path: `/srv/incoming/${path}`,
    source_refs: sources.map((value) => ({
      source_kind: value.source_kind,
      source_table: value.source_table,
      source_pk: value.source_pk,
      source_pointer: `/attachments/0/path`,
      card_id: value.card_id,
    })),
    size_bytes: 10,
    bytes_read: 10,
    mtime_ms: new Date(CUTOFF).getTime(),
    mtime: CUTOFF,
    sha256: "a".repeat(64),
    after_cutoff: false,
    eligible_candidate: true,
    coverage_complete: true,
    ...patch,
  };
}

function asset(id: string, upload_status: "pending" | "committed"): InventoryAssetSnapshot {
  return {
    id,
    storage_purpose: "attachment",
    upload_status,
    byte_size: 10,
    original_name: `${id}.png`,
    mime_type: "image/png",
    checksum_sha256: "a".repeat(64),
    garbage_collected_at: null,
    storage_verified: upload_status === "committed",
  };
}

function alias(path: string, asset_id: string | null, availability: "resolved" | "missing"): InventoryAliasSnapshot {
  return {
    node_id: "node-a",
    normalized_path: path,
    asset_id,
    original_path: path,
    availability,
    checked_at: CUTOFF,
  };
}
