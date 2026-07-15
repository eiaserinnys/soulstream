import type { BlockDto, PageDto } from "@seosoyoung/soul-ui/page";

export interface ProjectAtomReference {
  blockId: string;
  instance: string;
  nodeId: string;
  nodeTitle: string;
  depth: number | null;
  titlesOnly: boolean | null;
}

export interface ProjectSessionDefault {
  blockId: string;
  agentId: string | null;
  nodeId: string | null;
}

export interface ProjectPageDetails {
  guidance: Array<{ blockId: string; text: string }>;
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
      if (block.block_type !== "guidance" || block.properties.enabled === false) return [];
      const text = block.text.trim();
      return text ? [{ blockId: block.id, text }] : [];
    }),
    atomReferences: blocks.flatMap((block) => {
      if (block.block_type !== "atom_ref") return [];
      const nodeId = stringProperty(block.properties, "nodeId");
      if (!nodeId) return [];
      return [{
        blockId: block.id,
        instance: stringProperty(block.properties, "instance") ?? "atom",
        nodeId,
        nodeTitle: stringProperty(block.properties, "nodeTitle") ?? nodeId,
        depth: numberProperty(block.properties, "depth"),
        titlesOnly: booleanProperty(block.properties, "titlesOnly"),
      }];
    }),
    sessionDefaults: blocks.flatMap((block) => {
      if (block.block_type !== "session_defaults") return [];
      const agentId = stringProperty(block.properties, "agentId");
      const nodeId = stringProperty(block.properties, "nodeId");
      return agentId || nodeId ? [{ blockId: block.id, agentId, nodeId }] : [];
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

function numberProperty(properties: Record<string, unknown>, key: string): number | null {
  const value = properties[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanProperty(properties: Record<string, unknown>, key: string): boolean | null {
  const value = properties[key];
  return typeof value === "boolean" ? value : null;
}
