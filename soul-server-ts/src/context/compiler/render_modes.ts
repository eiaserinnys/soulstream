import type { Logger } from "pino";

import {
  ATOM_HTML_PATTERN,
  fetchAtomMarkdownResult,
  type AtomContextSpec,
  type AtomFetchConfig,
  type AtomFetchResult,
  type AtomFetchStatus,
} from "../atom_context.js";

export type ContextRenderMode = "full" | "index" | "titles";

type ContextCompilerLogger = Pick<Logger, "warn">;

export interface ExplicitRenderResult {
  markdown: string | null;
  status: AtomFetchStatus;
  truncated: boolean;
  anchorCount: number;
}

interface AtomTreeNode {
  nodeId: string;
  depth: number;
  title: string;
  chars?: number;
  line: string;
}

const TRUNCATION_MARKER = /<!--\s*truncated:\s*\d+\s+chars omitted\s*-->/;

export function isContextRenderMode(value: string | undefined): value is ContextRenderMode {
  return value === "full" || value === "index" || value === "titles";
}

export async function renderExplicitAtomSource(
  config: AtomFetchConfig,
  spec: AtomContextSpec,
  mode: ContextRenderMode,
  logger: ContextCompilerLogger,
): Promise<ExplicitRenderResult> {
  if (mode === "full") return await renderFull(config, spec, logger);
  if (mode === "index") return await renderIndex(config, spec, logger);
  return await renderTitles(config, spec, logger);
}

async function renderFull(
  config: AtomFetchConfig,
  spec: AtomContextSpec,
  logger: ContextCompilerLogger,
): Promise<ExplicitRenderResult> {
  const depth = normalizedDepth(spec.depth);
  const rendered = await fetchAtomMarkdownResult(config, {
    ...spec,
    depth: depth + 1,
    titlesOnly: false,
    includeIds: true,
  }, logger);
  const probe = await fetchUnboundedRootProbe(config, spec, logger);
  const unavailable = unavailableResult(rendered, probe);
  if (unavailable) return unavailable;

  const parsed = parseFullMarkdown(rendered.markdown!, depth);
  const limitCut = rootChildrenDiffer(rendered.markdown!, probe?.markdown);
  const globalCut = hasTruncationMarker(rendered.markdown!)
    || Boolean(probe?.markdown && hasTruncationMarker(probe.markdown))
    || limitCut;
  const anchors = globalCut && parsed.root
    ? [parsed.root]
    : parsed.depthCutAnchors;
  return successfulResult(
    appendAnchors(parsed.markdown, anchors),
    anchors,
  );
}

async function renderIndex(
  config: AtomFetchConfig,
  spec: AtomContextSpec,
  logger: ContextCompilerLogger,
): Promise<ExplicitRenderResult> {
  const [root, titles, probe] = await Promise.all([
    fetchAtomMarkdownResult(config, {
      ...spec,
      depth: 0,
      titlesOnly: false,
      includeIds: true,
    }, logger),
    fetchAtomMarkdownResult(config, {
      ...spec,
      depth: 1,
      titlesOnly: true,
      includeIds: true,
    }, logger),
    fetchUnboundedRootProbe(config, spec, logger),
  ]);
  const unavailable = unavailableResult(root, titles, probe);
  if (unavailable) return unavailable;

  const rootNode = parseAtomTreeNodes(root.markdown!)[0];
  const children = parseAtomTreeNodes(titles.markdown!).filter((node) => node.depth === 1);
  const rootMarkdown = stripAtomMetadata(root.markdown!);
  const table = children.length > 0 ? renderIndexTable(children) : "";
  let markdown = joinBlocks(rootMarkdown, table);
  const globalCut = hasTruncationMarker(root.markdown!)
    || hasTruncationMarker(titles.markdown!)
    || Boolean(probe?.markdown && hasTruncationMarker(probe.markdown))
    || rootChildrenDiffer(titles.markdown!, probe?.markdown);
  const extraAnchors = globalCut && rootNode ? [rootNode] : [];
  markdown = appendAnchors(markdown, extraAnchors);
  return {
    markdown,
    status: "ok",
    truncated: children.length > 0 || globalCut,
    anchorCount: children.length + extraAnchors.length,
  };
}

async function renderTitles(
  config: AtomFetchConfig,
  spec: AtomContextSpec,
  logger: ContextCompilerLogger,
): Promise<ExplicitRenderResult> {
  const depth = normalizedDepth(spec.depth);
  const [root, titles, probe] = await Promise.all([
    fetchAtomMarkdownResult(config, {
      ...spec,
      depth: 0,
      titlesOnly: false,
      includeIds: true,
    }, logger),
    fetchAtomMarkdownResult(config, {
      ...spec,
      depth: Math.max(1, depth + 1),
      titlesOnly: true,
      includeIds: true,
    }, logger),
    fetchUnboundedRootProbe(config, spec, logger),
  ]);
  const unavailable = unavailableResult(root, titles, probe);
  if (unavailable) return unavailable;

  const nodes = parseAtomTreeNodes(titles.markdown!);
  const rootNode = nodes.find((node) => node.depth === 0);
  const directChildren = nodes.filter((node) => node.depth === 1);
  const visibleTitleLines = nodes
    .filter((node) => node.depth > 0 && node.depth <= depth)
    .map((node) => stripMetadataFromLine(node.line));
  const titleTree = visibleTitleLines.length > 0
    ? `## 제목 트리\n\n${visibleTitleLines.join("\n")}`
    : "";
  const globalCut = hasTruncationMarker(root.markdown!)
    || hasTruncationMarker(titles.markdown!)
    || Boolean(probe?.markdown && hasTruncationMarker(probe.markdown))
    || rootChildrenDiffer(titles.markdown!, probe?.markdown);
  const anchors = globalCut || depth === 0
    ? (directChildren.length > 0 && rootNode ? [rootNode] : [])
    : directChildren;
  const markdown = appendAnchors(
    joinBlocks(stripAtomMetadata(root.markdown!), titleTree),
    anchors,
  );
  return successfulResult(markdown, anchors);
}

async function fetchUnboundedRootProbe(
  config: AtomFetchConfig,
  spec: AtomContextSpec,
  logger: ContextCompilerLogger,
): Promise<AtomFetchResult | undefined> {
  if (spec.limit === undefined) return undefined;
  const { limit: _limit, ...unbounded } = spec;
  return await fetchAtomMarkdownResult(config, {
    ...unbounded,
    depth: 1,
    titlesOnly: true,
    includeIds: true,
  }, logger);
}

function unavailableResult(
  ...results: Array<AtomFetchResult | undefined>
): ExplicitRenderResult | undefined {
  const available = results.filter((result): result is AtomFetchResult => result !== undefined);
  if (available.every((result) => result.status === "ok" && result.markdown !== null)) {
    return undefined;
  }
  return {
    markdown: null,
    status: available.some((result) => result.status === "error") ? "error" : "empty",
    truncated: false,
    anchorCount: 0,
  };
}

function successfulResult(
  markdown: string,
  anchors: readonly AtomTreeNode[],
): ExplicitRenderResult {
  return {
    markdown,
    status: "ok",
    truncated: anchors.length > 0,
    anchorCount: anchors.length,
  };
}

function normalizedDepth(depth: number): number {
  return Math.max(0, Math.trunc(depth));
}

function parseFullMarkdown(markdown: string, requestedDepth: number): {
  markdown: string;
  root?: AtomTreeNode;
  depthCutAnchors: AtomTreeNode[];
} {
  const output: string[] = [];
  const stack = new Map<number, AtomTreeNode>();
  const anchors = new Map<string, AtomTreeNode>();
  let keep = true;
  let root: AtomTreeNode | undefined;
  for (const line of markdown.split("\n")) {
    const node = parseAtomTreeNode(line);
    if (node) {
      stack.set(node.depth, node);
      for (const knownDepth of [...stack.keys()]) {
        if (knownDepth > node.depth) stack.delete(knownDepth);
      }
      if (node.depth === 0) root = node;
      if (node.depth === requestedDepth + 1) {
        const cut = stack.get(requestedDepth);
        if (cut) anchors.set(cut.nodeId, cut);
      }
      keep = node.depth <= requestedDepth;
    }
    if (keep && !TRUNCATION_MARKER.test(line)) output.push(stripMetadataFromLine(line));
  }
  return {
    markdown: output.join("\n").trim(),
    ...(root ? { root } : {}),
    depthCutAnchors: [...anchors.values()],
  };
}

function parseAtomTreeNodes(markdown: string): AtomTreeNode[] {
  return markdown.split("\n").flatMap((line) => {
    const node = parseAtomTreeNode(line);
    return node ? [node] : [];
  });
}

function parseAtomTreeNode(line: string): AtomTreeNode | undefined {
  const match = [...line.matchAll(ATOM_HTML_PATTERN)][0];
  if (!match) return undefined;
  const depthMatch = /\sdepth:(\d+)/.exec(match[0]);
  if (!depthMatch) return undefined;
  const title = stripMetadataFromLine(line)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*(?:[│ ]*[├└]──\s*)?/, "")
    .trim();
  const chars = match[3] === undefined ? undefined : Number(match[3]);
  return {
    nodeId: match[1]!,
    depth: Number(depthMatch[1]),
    title,
    ...(chars === undefined ? {} : { chars }),
    line,
  };
}

function stripAtomMetadata(markdown: string): string {
  return markdown.split("\n")
    .filter((line) => !TRUNCATION_MARKER.test(line))
    .map(stripMetadataFromLine)
    .join("\n")
    .trim();
}

function stripMetadataFromLine(line: string): string {
  return line.replace(ATOM_HTML_PATTERN, "").trimEnd();
}

function renderIndexTable(children: readonly AtomTreeNode[]): string {
  const rows = children.map((child) => (
    `| ${escapeTableCell(child.title)} | \`${child.nodeId}\` | ${child.chars ?? 0} |`
  ));
  return [
    "## 드릴다운 색인",
    "",
    "| 제목 | node_id | chars |",
    "| --- | --- | ---: |",
    ...rows,
  ].join("\n");
}

function appendAnchors(
  markdown: string,
  anchors: readonly AtomTreeNode[],
): string {
  if (anchors.length === 0) return markdown;
  const unique = new Map(anchors.map((anchor) => [anchor.nodeId, anchor]));
  const block = [
    "## 드릴다운 앵커",
    "",
    ...[...unique.values()].map((anchor) => (
      `- ${anchor.title} — \`compile_subtree(node_id="${anchor.nodeId}")\``
    )),
  ].join("\n");
  return joinBlocks(markdown, block);
}

export function renderRootDrilldownAnchor(nodeId: string, label = nodeId): string {
  return [
    "## 드릴다운 앵커",
    "",
    `- ${label} — \`compile_subtree(node_id="${nodeId}")\``,
  ].join("\n");
}

function rootChildrenDiffer(
  renderedMarkdown: string,
  unboundedMarkdown: string | null | undefined,
): boolean {
  if (!unboundedMarkdown) return false;
  const rendered = new Set(parseAtomTreeNodes(renderedMarkdown)
    .filter((node) => node.depth === 1)
    .map((node) => node.nodeId));
  return parseAtomTreeNodes(unboundedMarkdown)
    .filter((node) => node.depth === 1)
    .some((node) => !rendered.has(node.nodeId));
}

function hasTruncationMarker(markdown: string): boolean {
  return TRUNCATION_MARKER.test(markdown);
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function joinBlocks(...blocks: string[]): string {
  return blocks.filter(Boolean).join("\n\n");
}
