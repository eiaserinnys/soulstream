import { parseStandaloneImageLine } from "./standalone-image-line";
import type { AttachmentReadContext } from "@soulstream/wire-schema/attachments";
import type { ChatAttachmentItem } from "./chat-attachment-model";

export type ChatImageRole = "assistant" | "user";

export interface ChatImageItem {
  id: string;
  src: string;
  alt: string;
  /** Values already supplied by an attachment source take precedence over HEAD metadata. */
  filename?: string;
  mimeType?: string;
  bytes?: number;
}

export type ChatImageMetadata = Pick<ChatImageItem, "filename" | "mimeType" | "bytes">;

export function chatImageMetadataKey(image: ChatImageItem): string {
  return `${image.id}:${image.src}`;
}

export interface ChatImageRun {
  id: string;
  galleryIndexes: number[];
  source: "markdown" | "attachments";
}

export interface ChatMarkdownImageModel {
  role: ChatImageRole;
  gallery: ChatImageItem[];
  attachments: ChatImageItem[];
  representedAttachments: readonly ChatAttachmentItem[];
  readContext?: AttachmentReadContext;
  runs: Map<string, ChatImageRun>;
  attachmentIndexes: number[];
}

interface SourcePosition {
  start: { offset?: number };
  end: { offset?: number };
}

interface MarkdownNode {
  type: string;
  url?: string;
  value?: string;
  children?: MarkdownNode[];
  position?: SourcePosition;
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

interface MarkdownRoot extends MarkdownNode {
  type: "root";
  children: MarkdownNode[];
}

interface MarkdownFile {
  value?: string | Uint8Array;
}

interface CandidateParagraph {
  nodeIndex: number;
  node: MarkdownNode;
  start: number;
  end: number;
  images: Array<{ alt: string; url: string; offset: number }>;
}

export function createChatMarkdownImageModel(
  role: ChatImageRole,
  attachments: ChatImageItem[] = [],
  representedAttachments: readonly ChatAttachmentItem[] = [],
  readContext?: AttachmentReadContext,
): ChatMarkdownImageModel {
  return {
    role,
    gallery: [],
    attachments,
    representedAttachments,
    ...(readContext === undefined ? {} : { readContext }),
    runs: new Map(),
    attachmentIndexes: [],
  };
}

export function getChatImageFilename(src: string): string | undefined {
  try {
    const parsed = new URL(src, "https://soulstream.invalid");
    const queryPath = parsed.searchParams.get("path");
    const path = queryPath || parsed.pathname;
    const basename = path.split("/").filter(Boolean).at(-1);
    if (!basename) return undefined;
    try {
      return decodeURIComponent(basename);
    } catch {
      return basename;
    }
  } catch {
    return undefined;
  }
}

function isImageAttachmentPath(path: string): boolean {
  const cleanPath = path.split(/[?#]/, 1)[0] ?? path;
  return /\.(?:png|jpe?g|gif|webp|avif)$/i.test(cleanPath);
}

function attachmentReadContextParams(context: AttachmentReadContext): string[] {
  return context.type === "owner"
    ? ["context_type=owner"]
    : [`context_type=${encodeURIComponent(context.type)}`, `context_id=${encodeURIComponent(context.id)}`];
}

function sameOriginUrl(src: string): URL | null {
  const origin = typeof window === "undefined" ? "https://soulstream.invalid" : window.location.origin;
  try {
    const url = new URL(src, origin);
    return url.origin === origin ? url : null;
  } catch {
    return null;
  }
}

function legacySourceMatches(
  item: ChatAttachmentItem,
  nodeId: string,
  path: string,
): boolean {
  return (item.source.kind === "legacy" && item.source.nodeId === nodeId && item.source.path === path)
    || item.legacySources.some(source => source.node_id === nodeId && source.path === path);
}

function isRepresentedAttachmentImage(
  src: string,
  representedAttachments: readonly ChatAttachmentItem[],
): boolean {
  const url = sameOriginUrl(src);
  if (!url) return false;

  const assetMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)\/content$/);
  if (assetMatch) {
    let attachmentId: string;
    try {
      attachmentId = decodeURIComponent(assetMatch[1]!);
    } catch {
      return false;
    }
    return representedAttachments.some(item =>
      (item.source.kind === "asset" && item.source.attachmentId === attachmentId)
      || (item.source.kind === "unavailable" && item.source.attachmentId === attachmentId),
    );
  }

  if (url.pathname !== "/api/attachments/files") return false;
  const nodeId = url.searchParams.get("nodeId");
  const path = url.searchParams.get("path");
  if (nodeId === null || path === null) return false;
  return representedAttachments.some(item => legacySourceMatches(item, nodeId, path));
}

export function contextualizeChatMarkdownImageSrc(
  src: string,
  readContext: AttachmentReadContext | undefined,
): string {
  if (!readContext) return src;
  const url = sameOriginUrl(src);
  if (!url || url.pathname !== "/api/attachments/files") return src;
  if (url.searchParams.has("context_type") || url.searchParams.has("context_id")) return src;
  for (const parameter of attachmentReadContextParams(readContext)) {
    const separator = parameter.indexOf("=");
    const key = parameter.slice(0, separator);
    const value = parameter.slice(separator + 1);
    url.searchParams.set(key, decodeURIComponent(value));
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function buildStructuredChatImageItems(
  attachmentPaths: readonly string[] | undefined,
  nodeId: string | undefined,
  readContext?: AttachmentReadContext,
  representedAttachments: readonly ChatAttachmentItem[] = [],
): ChatImageItem[] {
  if (!nodeId || !attachmentPaths?.length) return [];

  return attachmentPaths.flatMap((path, index) => {
    if (!isImageAttachmentPath(path) || representedAttachments.some(item => legacySourceMatches(item, nodeId, path))) return [];
    const query = [
      `nodeId=${encodeURIComponent(nodeId)}`,
      `path=${encodeURIComponent(path)}`,
      ...(readContext ? attachmentReadContextParams(readContext) : []),
    ];
    return [{
      id: `attachment:${index}:${path}`,
      src: `/api/attachments/files?${query.join("&")}`,
      alt: "",
    }];
  });
}

function candidateParagraph(
  node: MarkdownNode,
  nodeIndex: number,
  source: string,
): CandidateParagraph | null {
  if (node.type !== "paragraph" || !node.position) return null;
  const { start, end } = node.position;
  if (typeof start.offset !== "number" || typeof end.offset !== "number") return null;

  const raw = source.slice(start.offset, end.offset);
  const rows = raw.split(/\r?\n/);
  const images: CandidateParagraph["images"] = [];
  let offset = start.offset;

  for (const [rowIndex, row] of rows.entries()) {
    if (row.trim()) {
      const parsed = parseStandaloneImageLine(row);
      if (!parsed) return null;
      images.push({ ...parsed, offset });
    }
    if (rowIndex < rows.length - 1) {
      const lineEnding = source.slice(offset + row.length, offset + row.length + 2) === "\r\n" ? 2 : 1;
      offset += row.length + lineEnding;
    }
  }

  const children = node.children ?? [];
  const imageCount = children.filter(child => child.type === "image").length;
  const hasOnlyImagesAndWhitespace = children.every(child =>
    child.type === "image"
    || child.type === "break"
    || (child.type === "text" && !(child.value ?? "").trim()),
  );
  if (!images.length || imageCount !== images.length || !hasOnlyImagesAndWhitespace) return null;

  return { nodeIndex, node, start: start.offset, end: end.offset, images };
}

/**
 * Runs after the one existing Markdown parse. Only direct root paragraphs whose
 * nonblank source rows match the shared direct-URL matcher become image runs.
 */
export function createChatMarkdownImageRemarkPlugin(model: ChatMarkdownImageModel, groupImages = true) {
  return () => (tree: MarkdownRoot, file: MarkdownFile) => {
    const source = typeof file.value === "string" ? file.value : "";
    model.gallery = [];
    model.runs.clear();
    model.attachmentIndexes = [];

    const candidates = tree.children
      .map((node, index) => candidateParagraph(node, index, source))
      .filter((candidate): candidate is CandidateParagraph => candidate !== null);

    if (!groupImages) {
      for (const { node } of candidates) {
        node.children = node.children?.filter(child => child.type !== "image"
          || !isRepresentedAttachmentImage(child.url ?? "", model.representedAttachments));
      }
      tree.children = tree.children.filter(node => !candidates.some(candidate => candidate.node === node)
        || node.children?.some(child => child.type === "image"));
      return;
    }

    const removedNodeIndexes = new Set<number>();
    const visibleCandidates = candidates.flatMap(candidate => {
      const images = candidate.images.filter(image =>
        !isRepresentedAttachmentImage(image.url, model.representedAttachments),
      );
      if (images.length === 0) {
        removedNodeIndexes.add(candidate.nodeIndex);
        return [];
      }
      return [{ ...candidate, images }];
    });

    const runs: CandidateParagraph[][] = [];
    for (const candidate of visibleCandidates) {
      const previous = runs.at(-1)?.at(-1);
      const gap = previous ? source.slice(previous.end, candidate.start) : "";
      if (
        previous
        && candidate.nodeIndex === previous.nodeIndex + 1
        && /^\s*$/u.test(gap)
      ) {
        runs.at(-1)!.push(candidate);
      } else {
        runs.push([candidate]);
      }
    }

    runs.forEach((paragraphs, runIndex) => {
      const runId = `markdown-${runIndex}`;
      const galleryIndexes: number[] = [];
      paragraphs.forEach((paragraph, paragraphIndex) => {
        paragraph.images.forEach(image => {
          const galleryIndex = model.gallery.length;
          galleryIndexes.push(galleryIndex);
          model.gallery.push({
            id: `markdown:${image.offset}:${image.url}`,
            src: contextualizeChatMarkdownImageSrc(image.url, model.readContext),
            alt: image.alt,
          });
        });
        if (paragraphIndex > 0) removedNodeIndexes.add(paragraph.nodeIndex);
      });

      model.runs.set(runId, { id: runId, galleryIndexes, source: "markdown" });
      const firstNode = paragraphs[0].node;
      firstNode.data = {
        ...firstNode.data,
        hName: "div",
        hProperties: {
          ...firstNode.data?.hProperties,
          "data-chat-image-run": runId,
        },
      };
      firstNode.children = [];
    });

    if (removedNodeIndexes.size > 0) {
      tree.children = tree.children.filter((_, index) => !removedNodeIndexes.has(index));
    }

    if (model.attachments.length > 0) {
      model.attachmentIndexes = model.attachments.map(attachment => {
        const galleryIndex = model.gallery.length;
        model.gallery.push(attachment);
        return galleryIndex;
      });
      const runId = "attachments";
      model.runs.set(runId, {
        id: runId,
        galleryIndexes: model.attachmentIndexes,
        source: "attachments",
      });
      tree.children.push({
        type: "paragraph",
        children: [],
        data: {
          hName: "div",
          hProperties: { "data-chat-image-run": runId },
        },
      });
    }
  };
}
