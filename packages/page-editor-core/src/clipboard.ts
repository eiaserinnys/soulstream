import { SnapshotIndex } from "./snapshot.js";
import { resolveBlockSelection } from "./tree-operations.js";
import type {
  ClipboardInput,
  EditorBlockSnapshot,
  ParsedClipboard,
  ParsedClipboardBlock,
} from "./types.js";

export const PAGE_BLOCK_CLIPBOARD_MIME = "application/x-soulstream-page-blocks+json";

export interface StructuredClipboardPayload {
  readonly schema: "soulstream-page-blocks";
  readonly version: 1;
  readonly blocks: readonly ParsedClipboardBlock[];
}

export interface SerializedBlockSelection {
  readonly plainText: string;
  readonly structured: StructuredClipboardPayload;
}

export function serializeBlockSelection(
  snapshot: readonly EditorBlockSnapshot[],
  selectedBlockIds: readonly string[],
): SerializedBlockSelection {
  const index = new SnapshotIndex(snapshot);
  const selection = resolveBlockSelection(index, selectedBlockIds);
  if (!selection) throw new Error("The selected blocks are no longer contiguous");
  const blocks = selection.roots.map((block) => serializeTree(index, block));
  return {
    plainText: flattenClipboardText(blocks).join("\n"),
    structured: { schema: "soulstream-page-blocks", version: 1, blocks },
  };
}

export function encodeStructuredClipboard(payload: StructuredClipboardPayload): string {
  return JSON.stringify(payload);
}

export function decodeStructuredClipboard(value: string): StructuredClipboardPayload {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || parsed.schema !== "soulstream-page-blocks" || parsed.version !== 1) {
    throw new Error("Unsupported Soulstream clipboard payload");
  }
  if (!Array.isArray(parsed.blocks)) throw new Error("Soulstream clipboard blocks must be an array");
  return {
    schema: "soulstream-page-blocks",
    version: 1,
    blocks: parsed.blocks.map((block) => validateStructuredBlock(block)),
  };
}

export function parseClipboard(input: ClipboardInput): ParsedClipboard {
  if (input.forcePlainText && input.plainText !== undefined) return parsePlainText(input.plainText);
  if (hasUnsupportedFilesOrMedia(input)) return { kind: "unsupported", reason: "files-or-media" };
  if (input.structured?.blocks && input.structured.blocks.length > 0) {
    return { kind: "block-tree", blocks: cloneBlocks(input.structured.blocks) };
  }
  if (input.html) {
    const blocks = parseHtmlListSubset(input.html);
    if (blocks.length > 0) return { kind: "block-tree", blocks };
  }
  if (input.plainText !== undefined) return parsePlainText(input.plainText);
  return { kind: "unsupported", reason: "empty-clipboard" };
}

function parsePlainText(text: string): ParsedClipboard {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length === 1) return { kind: "plain-text", text };
  return { kind: "block-tree", blocks: lines.map((line) => ({ text: line, children: [] })) };
}

function hasUnsupportedFilesOrMedia(input: ClipboardInput): boolean {
  if (input.files && input.files.length > 0) return true;
  return Boolean(input.html && /<(img|video|audio|source|iframe|object|embed)\b/i.test(input.html));
}

function parseHtmlListSubset(html: string): ParsedClipboardBlock[] {
  const roots: MutableClipboardBlock[] = [];
  const stack: MutableClipboardBlock[] = [];
  for (const token of html.match(/<\/?[^>]+>|[^<]+/g) ?? []) {
    const tag = token.match(/^<\/?\s*([a-z0-9-]+)/i)?.[1]?.toLowerCase();
    if (tag === "li" && /^<\s*li\b/i.test(token)) {
      const block: MutableClipboardBlock = { text: "", children: [] };
      const parent = stack[stack.length - 1];
      (parent ? parent.children : roots).push(block);
      stack.push(block);
    } else if (tag === "li" && /^<\s*\//.test(token)) {
      stack.pop();
    } else if (!token.startsWith("<")) {
      const current = stack[stack.length - 1];
      if (current) current.text += decodeEntities(token).replace(/\s+/g, " ");
    }
  }
  return pruneEmpty(roots);
}

interface MutableClipboardBlock {
  text: string;
  children: MutableClipboardBlock[];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function pruneEmpty(blocks: readonly MutableClipboardBlock[]): ParsedClipboardBlock[] {
  return blocks
    .map((block) => ({ text: block.text.trim(), children: pruneEmpty(block.children) }))
    .filter((block) => block.text.length > 0 || block.children.length > 0);
}

function cloneBlocks(blocks: readonly ParsedClipboardBlock[]): ParsedClipboardBlock[] {
  return blocks.map((block) => ({
    text: block.text,
    ...(block.type === undefined ? {} : { type: block.type }),
    ...(block.properties === undefined ? {} : { properties: cloneProperties(block.properties) }),
    ...(block.collapsed === undefined ? {} : { collapsed: block.collapsed }),
    children: cloneBlocks(block.children),
  }));
}

function serializeTree(index: SnapshotIndex, block: EditorBlockSnapshot): ParsedClipboardBlock {
  return {
    text: block.text,
    type: block.type,
    properties: cloneProperties(block.properties),
    collapsed: block.collapsed,
    children: (index.children.get(block.id) ?? []).map((child) => serializeTree(index, child)),
  };
}

function flattenClipboardText(blocks: readonly ParsedClipboardBlock[]): string[] {
  return blocks.flatMap((block) => [block.text, ...flattenClipboardText(block.children)]);
}

function validateStructuredBlock(value: unknown): ParsedClipboardBlock {
  if (!isRecord(value) || typeof value.text !== "string" || !Array.isArray(value.children)) {
    throw new Error("Soulstream clipboard block is invalid");
  }
  if (value.type !== undefined && typeof value.type !== "string") {
    throw new Error("Soulstream clipboard block type is invalid");
  }
  if (value.properties !== undefined && !isRecord(value.properties)) {
    throw new Error("Soulstream clipboard block properties are invalid");
  }
  if (value.collapsed !== undefined && typeof value.collapsed !== "boolean") {
    throw new Error("Soulstream clipboard block collapsed state is invalid");
  }
  return {
    text: value.text,
    ...(value.type === undefined ? {} : { type: value.type }),
    ...(value.properties === undefined ? {} : { properties: cloneProperties(value.properties) }),
    ...(value.collapsed === undefined ? {} : { collapsed: value.collapsed }),
    children: value.children.map((child) => validateStructuredBlock(child)),
  };
}

function cloneProperties(properties: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return structuredClone(properties) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
