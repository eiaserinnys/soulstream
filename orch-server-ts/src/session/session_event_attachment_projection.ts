import path from "node:path";

import type {
  AttachmentReadContext,
  SessionEventAttachmentResponse,
  SessionEventAttachmentView,
} from "@soulstream/wire-schema/attachments";
import {
  normalizeAttachmentLegacyPath,
  projectAttachmentDescriptor,
  type AttachmentAssetRow,
  type AttachmentReadRepository,
} from "../attachments/attachment_read_service.js";

type SessionAttachmentRepository = Pick<
  AttachmentReadRepository,
  "getAsset" | "getLegacyAlias" | "getSqlScopeEvidence"
>;
type SessionReadContext = Extract<AttachmentReadContext, { type: "session" }>;

const SUPPORTED_CHAT_EVENT_TYPES = new Set([
  "user_message",
  "intervention_sent",
  "assistant_message",
  "complete",
]);

export async function projectSessionEventAttachments(
  input: {
    readonly sessionId: string;
    readonly eventId: number;
    readonly eventType: string;
    readonly payload: Record<string, unknown>;
    readonly nodeId: string | null;
  },
  repository: SessionAttachmentRepository,
): Promise<SessionEventAttachmentResponse> {
  const readContext: SessionReadContext = { type: "session", id: input.sessionId };
  const items: SessionEventAttachmentView[] = [];
  const attachmentIndexes = new Map<string, number>();

  if (!SUPPORTED_CHAT_EVENT_TYPES.has(input.eventType)) {
    return { event_id: input.eventId, items };
  }

  for (const attachmentId of uniqueNonEmptyStrings(input.payload.attachment_ids)) {
    const item = await assetView(attachmentId, readContext, repository);
    attachmentIndexes.set(attachmentId, items.length);
    items.push(item);
  }

  const nodeId = nonEmptyString(input.payload.node_id) ?? nonEmptyString(input.nodeId);
  for (const legacyPath of legacyPaths(input.payload)) {
    if (nodeId === null) {
      items.push(unavailableLegacyView(legacyPath, readContext));
      continue;
    }

    const alias = await repository.getLegacyAlias(nodeId, legacyPath);
    if (alias === null) {
      items.push(legacyView(nodeId, legacyPath, "unresolved", readContext));
      continue;
    }

    if (alias.availability === "missing" || alias.assetId === null) {
      items.push(legacyView(
        nodeId,
        legacyPath,
        alias.availability === "missing" ? "missing" : "unresolved",
        readContext,
      ));
      continue;
    }

    const existingIndex = attachmentIndexes.get(alias.assetId);
    if (existingIndex !== undefined) {
      const existing = items[existingIndex];
      if (existing?.kind === "asset") {
        existing.legacy_sources.push({ node_id: nodeId, path: legacyPath });
      }
      continue;
    }

    const evidence = await repository.getSqlScopeEvidence(readContext, alias.assetId);
    if (evidence?.hasStoredRef !== true) {
      items.push(legacyView(nodeId, legacyPath, "unresolved", readContext));
      continue;
    }

    const item = await assetView(alias.assetId, readContext, repository);
    attachmentIndexes.set(alias.assetId, items.length);
    if (item.kind === "asset") {
      item.legacy_sources.push({ node_id: nodeId, path: legacyPath });
    }
    items.push(item);
  }

  return { event_id: input.eventId, items };
}

function legacyPaths(payload: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  for (const value of [payload.attachments, payload.attachment_paths]) {
    if (!Array.isArray(value)) continue;
    for (const candidate of value) {
      if (typeof candidate !== "string" || candidate.length === 0) continue;
      paths.add(normalizeAttachmentLegacyPath(candidate));
    }
  }
  return [...paths];
}

function uniqueNonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const strings = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate === "string" && candidate.length > 0) strings.add(candidate);
  }
  return [...strings];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function assetView(
  attachmentId: string,
  readContext: SessionReadContext,
  repository: SessionAttachmentRepository,
): Promise<SessionEventAttachmentView> {
  const asset = await repository.getAsset(attachmentId);
  if (!isReadableAssetMetadata(asset)) {
    return {
      kind: "unavailable",
      attachment_id: attachmentId,
      name: null,
      availability: "unavailable",
      read_context: readContext,
    };
  }
  return {
    kind: "asset",
    descriptor: projectAttachmentDescriptor(asset),
    read_context: readContext,
    legacy_sources: [],
  };
}

function isReadableAssetMetadata(asset: AttachmentAssetRow | null): asset is AttachmentAssetRow {
  return asset !== null && asset.storagePurpose === "attachment" &&
    asset.uploadStatus === "committed" &&
    Number.isSafeInteger(asset.byteSize) && asset.byteSize >= 0 &&
    asset.originalName.trim().length > 0 && asset.mimeType.trim().length > 0;
}

function legacyView(
  nodeId: string,
  legacyPath: string,
  availability: Extract<SessionEventAttachmentView, { kind: "legacy" }>["availability"],
  readContext: SessionReadContext,
): SessionEventAttachmentView {
  return {
    kind: "legacy",
    node_id: nodeId,
    path: legacyPath,
    name: path.posix.basename(legacyPath),
    mime_type: null,
    byte_size: null,
    availability,
    read_context: readContext,
  };
}

function unavailableLegacyView(
  legacyPath: string,
  readContext: SessionReadContext,
): SessionEventAttachmentView {
  return {
    kind: "unavailable_legacy",
    path: legacyPath,
    name: path.posix.basename(legacyPath),
    availability: "unavailable",
    read_context: readContext,
  };
}
