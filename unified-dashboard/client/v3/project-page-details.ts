import type { BlockDto, PageDto } from "@seosoyoung/soul-ui/page";

export interface ProjectAtomReference {
  blockId: string;
  instance: "atom" | "atom-nl";
  nodeId: string;
  nodeTitle: string;
  depth: number | null;
  titlesOnly: boolean | null;
}

export interface ProjectGuidance {
  blockId: string;
  text: string;
  scope: string;
}

export interface ProjectSessionDefault {
  blockId: string;
  scope: string;
  agentId: string | null;
  nodeId: string | null;
}

export interface ProjectPageDetails {
  guidance: ProjectGuidance[];
  atomReferences: ProjectAtomReference[];
  sessionDefaults: ProjectSessionDefault[];
}

export interface ProjectPageSnapshot extends ProjectPageDetails {
  page: PageDto;
  blocks: BlockDto[];
  stateVector: string;
}

export function parseProjectPageDetails(blocks: readonly BlockDto[]): ProjectPageDetails {
  return {
    guidance: blocks.flatMap((block) => {
      if (block.block_type !== "guidance" || block.properties.enabled !== true) return [];
      const text = block.text.trim();
      const scope = stringProperty(block.properties, "scope") ?? block.id;
      return text ? [{ blockId: block.id, text, scope }] : [];
    }),
    atomReferences: blocks.flatMap((block) => {
      if (block.block_type !== "atom_ref") return [];
      const instance = stringProperty(block.properties, "instance") ?? "atom";
      if (instance !== "atom" && instance !== "atom-nl") return [];
      const nodeId = stringProperty(block.properties, "nodeId");
      if (!nodeId) return [];
      return [{
        blockId: block.id,
        instance,
        nodeId,
        nodeTitle: stringProperty(block.properties, "nodeTitle")
          ?? stringProperty(block.properties, "title")
          ?? stringProperty(block.properties, "label")
          ?? nodeId,
        depth: normalizeAtomDepth(block.properties.depth),
        titlesOnly: block.properties.titlesOnly === true,
      }];
    }),
    sessionDefaults: blocks.flatMap((block) => {
      if (block.block_type !== "session_defaults") return [];
      const scope = stringProperty(block.properties, "scope");
      const agentId = stringProperty(block.properties, "agentId");
      const nodeId = stringProperty(block.properties, "nodeId");
      return scope && (agentId || nodeId) ? [{ blockId: block.id, scope, agentId, nodeId }] : [];
    }),
  };
}

export async function fetchProjectPageDetails(
  pageId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProjectPageSnapshot> {
  const response = await fetchImplementation(
    `/api/pages/${encodeURIComponent(pageId)}?include_blocks=true`,
    { credentials: "same-origin", headers: { Accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`프로젝트 컨텍스트를 불러오지 못했습니다 (${response.status})`);
  const payload = await response.json() as {
    page: PageDto;
    blocks?: BlockDto[];
    state_vector: string;
  };
  const blocks = payload.blocks ?? [];
  return {
    ...parseProjectPageDetails(blocks),
    page: payload.page,
    blocks,
    stateVector: payload.state_vector,
  };
}

function stringProperty(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeAtomDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 3;
  return Math.min(5, Math.max(1, Math.trunc(value)));
}
