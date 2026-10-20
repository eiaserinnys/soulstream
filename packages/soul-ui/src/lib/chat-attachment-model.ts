import type {
  AttachmentReadContext,
  SessionEventAttachmentResponse,
  SessionEventAttachmentView,
} from "@soulstream/wire-schema/attachments";
import { orchestratorFetch } from "./orchestrator-connection";

export type ChatAttachmentSource =
  | { kind: "asset"; attachmentId: string; context: AttachmentReadContext }
  | { kind: "legacy"; nodeId: string; path: string; context: AttachmentReadContext }
  | { kind: "local"; file: File }
  | { kind: "markdown-image"; src: string; alt: string }
  | { kind: "unavailable"; attachmentId?: string; path?: string; context: AttachmentReadContext };

export interface ChatAttachmentItem {
  key: string;
  name: string | null;
  mimeType: string | null;
  byteSize: number | null;
  previewKind: "image" | "text" | "info";
  availability: "ready" | "unresolved" | "missing" | "unavailable";
  previewUrl: string | null;
  originalUrl: string | null;
  legacySources: { node_id: string; path: string }[];
  source: ChatAttachmentSource;
}

export function attachmentTextFormat(
  item: Pick<ChatAttachmentItem, "mimeType" | "name">,
): "markdown" | "html" | "plain" {
  const mimeType = item.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mimeType === "text/markdown" || /\.(md|markdown)$/i.test(item.name ?? "")) {
    return "markdown";
  }
  if (mimeType === "text/html" || /\.html?$/i.test(item.name ?? "")) {
    return "html";
  }
  return "plain";
}

const SAFE_RASTER_PREVIEW_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

const SAFE_TEXT_PREVIEW_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "text/javascript",
  "application/javascript",
  "text/typescript",
  "application/typescript",
  "text/x-python",
  "text/x-script.python",
  "text/x-shellscript",
  "text/x-csrc",
  "text/x-c++src",
  "text/x-java-source",
  "text/css",
  "text/csv",
]);

export class ChatAttachmentRequestError extends Error {
  constructor(readonly status: number, readonly networkError = false) {
    super("Chat attachment request failed");
    this.name = "ChatAttachmentRequestError";
  }
}

export function attachmentContentUrl(
  attachmentId: string,
  context: AttachmentReadContext,
  download = false,
): string {
  const params = contextParams(context);
  if (download) params.push("download=true");
  return `/api/attachments/${encodeURIComponent(attachmentId)}/content?${params.join("&")}`;
}

export function contextualLegacyUrl(
  nodeId: string,
  path: string,
  context: AttachmentReadContext,
  download = false,
): string {
  const params = [
    `nodeId=${encodeURIComponent(nodeId)}`,
    `path=${encodeURIComponent(path)}`,
    ...contextParams(context),
  ];
  if (download) params.push("download=true");
  return `/api/attachments/files?${params.join("&")}`;
}

export async function loadChatAttachments(input: {
  sessionId: string;
  eventId: number;
  signal?: AbortSignal;
}): Promise<SessionEventAttachmentResponse> {
  if (!Number.isSafeInteger(input.eventId) || input.eventId <= 0) {
    throw new ChatAttachmentRequestError(400);
  }
  let response: Response;
  try {
    response = await orchestratorFetch(fetch, sessionEventAttachmentUrl(input.sessionId, input.eventId), {
      credentials: "same-origin",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new ChatAttachmentRequestError(0, true);
  }
  if (!response.ok) throw new ChatAttachmentRequestError(response.status);
  const body: unknown = await response.json().catch(() => null);
  if (!isSessionEventAttachmentResponse(body, input.eventId)) {
    throw new ChatAttachmentRequestError(0);
  }
  return body;
}

export function projectChatAttachmentItems(
  projection: SessionEventAttachmentResponse,
): ChatAttachmentItem[] {
  return projection.items.map((view) => projectItem(view));
}

function projectItem(view: SessionEventAttachmentView): ChatAttachmentItem {
  switch (view.kind) {
    case "asset": {
      const { descriptor, read_context: context } = view;
      const contentUrl = attachmentContentUrl(descriptor.attachment_id, context);
      const previewKind = safePreviewKind(descriptor.preview_kind, descriptor.mime_type);
      return {
        key: `asset:${descriptor.attachment_id}`,
        name: descriptor.name,
        mimeType: descriptor.mime_type,
        byteSize: descriptor.byte_size,
        previewKind,
        availability: "ready",
        previewUrl: previewKind === "info" ? null : contentUrl,
        originalUrl: attachmentContentUrl(descriptor.attachment_id, context, true),
        legacySources: view.legacy_sources,
        source: { kind: "asset", attachmentId: descriptor.attachment_id, context },
      };
    }
    case "legacy": {
      const { node_id: nodeId, path, read_context: context } = view;
      const url = view.availability === "missing"
        ? null
        : contextualLegacyUrl(nodeId, path, context);
      const previewKind = previewKindFromMime(view.mime_type);
      return {
        key: `legacy:${JSON.stringify([nodeId, path])}`,
        name: view.name,
        mimeType: view.mime_type,
        byteSize: view.byte_size,
        previewKind,
        availability: view.availability,
        previewUrl: url !== null && previewKind !== "info"
          ? url
          : null,
        originalUrl: url === null ? null : contextualLegacyUrl(nodeId, path, context, true),
        legacySources: [],
        source: { kind: "legacy", nodeId, path, context },
      };
    }
    case "unavailable":
      return {
        key: `asset:${view.attachment_id}`,
        name: null,
        mimeType: null,
        byteSize: null,
        previewKind: "info",
        availability: "unavailable",
        previewUrl: null,
        originalUrl: null,
        legacySources: [],
        source: { kind: "unavailable", attachmentId: view.attachment_id, context: view.read_context },
      };
    case "unavailable_legacy":
      return {
        key: `legacy-unavailable:${JSON.stringify(view.path)}`,
        name: view.name,
        mimeType: null,
        byteSize: null,
        previewKind: "info",
        availability: "unavailable",
        previewUrl: null,
        originalUrl: null,
        legacySources: [],
        source: { kind: "unavailable", path: view.path, context: view.read_context },
      };
  }
}

function contextParams(context: AttachmentReadContext): string[] {
  return context.type === "owner"
    ? ["context_type=owner"]
    : [`context_type=${encodeURIComponent(context.type)}`, `context_id=${encodeURIComponent(context.id)}`];
}

function sessionEventAttachmentUrl(sessionId: string, eventId: number): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/events/${eventId}/attachments`;
}

function previewKindFromMime(mimeType: string | null): ChatAttachmentItem["previewKind"] {
  const normalized = normalizeMimeType(mimeType);
  if (SAFE_RASTER_PREVIEW_MIME_TYPES.has(normalized)) return "image";
  if (SAFE_TEXT_PREVIEW_MIME_TYPES.has(normalized)) return "text";
  return "info";
}

export function isSafeRasterPreviewMimeType(mimeType: string | null): boolean {
  return SAFE_RASTER_PREVIEW_MIME_TYPES.has(normalizeMimeType(mimeType));
}

function safePreviewKind(
  advertisedKind: ChatAttachmentItem["previewKind"],
  mimeType: string | null,
): ChatAttachmentItem["previewKind"] {
  if (advertisedKind === "image" && isSafeRasterPreviewMimeType(mimeType)) return "image";
  const normalized = normalizeMimeType(mimeType);
  if (advertisedKind === "text" && (
    normalized === "text/html" || SAFE_TEXT_PREVIEW_MIME_TYPES.has(normalized)
  )) return "text";
  return "info";
}

function normalizeMimeType(mimeType: string | null): string {
  return mimeType?.trim().toLowerCase().split(";", 1)[0] ?? "";
}

function isSessionEventAttachmentResponse(
  value: unknown,
  eventId: number,
): value is SessionEventAttachmentResponse {
  return typeof value === "object"
    && value !== null
    && "event_id" in value
    && value.event_id === eventId
    && "items" in value
    && Array.isArray(value.items);
}
