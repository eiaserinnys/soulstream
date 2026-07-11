import type { ClipboardInput, ParsedClipboard, ParsedClipboardBlock } from "./types.js";

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
  return blocks.map((block) => ({ text: block.text, children: cloneBlocks(block.children) }));
}
