export type AttachmentScope =
  | { type: "session"; id: string }
  | { type: "card"; id: string }
  | { type: "page"; id: string }
  | { type: "board_item"; id: string };

export type AttachmentRegistrationScope =
  | AttachmentScope
  | { type: "folder"; id: string };

export type AttachmentReadContext = { type: "owner" } | AttachmentScope;

export interface AttachmentDescriptor {
  attachment_id: string;
  name: string;
  mime_type: string;
  byte_size: number;
  checksum_sha256: string | null;
  width: number | null;
  height: number | null;
  preview_kind: "image" | "text" | "info";
  preview_mime_type: string | null;
}

export interface AttachmentRef {
  attachment_id: string;
}

export type AttachmentPathBinding = {
  attachment_id: string;
  node_id: string;
  path: string;
};

export type AttachmentInputFields = {
  attachmentIds?: readonly string[];
  attachmentPaths?: readonly string[];
  attachmentBindings?: readonly AttachmentPathBinding[];
};

export type AttachmentProjection =
  | {
      kind: "asset";
      descriptor: AttachmentDescriptor;
      read_context: AttachmentReadContext;
    }
  | {
      kind: "legacy";
      node_id: string;
      path: string;
      name: string;
      mime_type: string | null;
      byte_size: number | null;
      availability: "unresolved" | "missing";
    };

type SessionAttachmentReadContext = Extract<AttachmentReadContext, { type: "session" }>;

export type SessionEventAttachmentView =
  | (Extract<AttachmentProjection, { kind: "asset" }> & {
      read_context: SessionAttachmentReadContext;
      legacy_sources: { node_id: string; path: string }[];
    })
  | (Extract<AttachmentProjection, { kind: "legacy" }> & {
      read_context: SessionAttachmentReadContext;
    })
  | {
      kind: "unavailable";
      attachment_id: string;
      name: null;
      availability: "unavailable";
      read_context: SessionAttachmentReadContext;
    }
  | {
      kind: "unavailable_legacy";
      path: string;
      name: string;
      availability: "unavailable";
      read_context: SessionAttachmentReadContext;
    };

export interface SessionEventAttachmentResponse {
  event_id: number;
  items: SessionEventAttachmentView[];
}

export const SAFE_RASTER_PREVIEW_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/**
 * Every MIME type the web draws as an image: the safe rasters above plus the
 * vector and HEIC families. SVG is still drawn with <img> only (scripts never
 * run); HEIC/HEIF fall back to a lazily loaded decoder when the browser cannot
 * paint them. This list is the single source for image judgments; a file must
 * not classify differently depending on the entry path.
 */
export const IMAGE_PREVIEW_MIME_TYPES: ReadonlySet<string> = new Set([
  ...SAFE_RASTER_PREVIEW_MIME_TYPES,
  "image/svg+xml",
  "image/heic",
  "image/heif",
]);

/** Extension (without the dot, lower case) to MIME type. One table for server and web. */
export const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  md: "text/markdown",
  pdf: "application/pdf",
};

/** Looks up the extension of a name or path. `null` for unknown or missing extensions. */
export function mimeTypeForFileName(name: string | null | undefined): string | null {
  const extension = /\.([^./\\]+)$/.exec(name ?? "")?.[1]?.toLowerCase();
  return extension === undefined ? null : MIME_BY_EXTENSION[extension] ?? null;
}

/**
 * MIME type for an attachment address. Query strings and fragments never change
 * the judgment: the files API keeps the name in the `path` parameter, so that
 * value wins, otherwise the address pathname's extension is read.
 */
export function mimeTypeForUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, "https://soulstream.invalid");
    return mimeTypeForFileName(parsed.searchParams.get("path") || parsed.pathname);
  } catch {
    return null;
  }
}

/** Normalizes parameters and case before comparing against {@link IMAGE_PREVIEW_MIME_TYPES}. */
export function isImagePreviewMimeType(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase().split(";", 1)[0] ?? "";
  return IMAGE_PREVIEW_MIME_TYPES.has(normalized);
}

export const SAFE_TEXT_PREVIEW_MIME_TYPES: ReadonlySet<string> = new Set([
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
