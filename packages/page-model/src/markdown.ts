import { compareLexicographically, comparePositionKeys } from "@soulstream/fractional-position";

import type { BlockDto, PageDto } from "./types.js";

export interface PageMarkdownBlockInput {
  id: string;
  parent_id: string | null;
  position_key: string;
  type: string;
  text: string;
  properties: Record<string, unknown>;
  collapsed: boolean;
}

export interface PageToMarkdownOptions {
  includeBlockIds?: boolean;
}

export interface MarkdownToPageBlocksOptions {
  title: string;
  createId: () => string;
}

export function pageToMarkdown(
  page: Pick<PageDto, "title">,
  blocks: readonly BlockDto[],
  options: PageToMarkdownOptions = {},
): string {
  const children = new Map<string | null, BlockDto[]>();
  for (const block of blocks) {
    const siblings = children.get(block.parent_id) ?? [];
    siblings.push(block);
    children.set(block.parent_id, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) =>
      comparePositionKeys(left.position_key, right.position_key) || compareLexicographically(left.id, right.id));
  }

  const lines = [`# ${page.title}`, ""];
  const visited = new Set<string>();
  const render = (block: BlockDto, depth: number): void => {
    if (visited.has(block.id)) return;
    visited.add(block.id);
    const indent = "  ".repeat(depth);
    if (options.includeBlockIds) lines.push(`${indent}<!-- block:${block.id} -->`);
    lines.push(`${indent}${blockMarkdownText(block)}`);
    for (const child of children.get(block.id) ?? []) render(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) render(root, 0);
  return lines.join("\n");
}

export function markdownToPageBlocks(
  markdown: string,
  options: MarkdownToPageBlocksOptions,
): PageMarkdownBlockInput[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: PageMarkdownBlockInput[] = [];
  const parentAtDepth: string[] = [];
  const siblingCounts = new Map<string | null, number>();
  let explicitId: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (index === 0 && trimmed === `# ${options.title}`) continue;
    const idComment = trimmed.match(/^<!--\s*block:([^\s]+)\s*-->$/);
    if (idComment) {
      explicitId = idComment[1];
      continue;
    }
    if (!trimmed) continue;

    const leading = line.match(/^[\t ]*/)?.[0] ?? "";
    const depth = Math.floor(leading.replace(/\t/g, "  ").length / 2);
    const parentId = depth === 0 ? null : parentAtDepth[depth - 1] ?? null;
    const id = explicitId ?? options.createId();
    explicitId = undefined;
    const checklist = trimmed.match(/^- \[([ xX])\]\s?(.*)$/);
    const blockType = checklist ? "checklist" : "paragraph";
    const text = checklist ? checklist[2] ?? "" : trimmed;
    const properties = checklist ? { checked: checklist[1]?.toLowerCase() === "x" } : {};
    const siblingIndex = (siblingCounts.get(parentId) ?? 0) + 1;
    siblingCounts.set(parentId, siblingIndex);
    blocks.push({
      id,
      parent_id: parentId,
      position_key: String(siblingIndex).padStart(12, "0"),
      type: blockType,
      text,
      properties,
      collapsed: false,
    });
    parentAtDepth[depth] = id;
    parentAtDepth.length = depth + 1;
  }
  return blocks;
}

function blockMarkdownText(block: BlockDto): string {
  if (block.block_type !== "checklist") return block.text;
  return `- [${block.properties.checked === true ? "x" : " "}] ${block.text}`;
}
