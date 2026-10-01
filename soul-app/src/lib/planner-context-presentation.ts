import type { PlannerBlock } from '../api/plannerTypes';

export interface PlannerSourcedContext {
  id: string;
  icon: string;
  label: string;
  kind: 'guidance' | 'atom' | 'document';
  sourceLabel: string;
}

export interface PlannerDefaultAssignment {
  agentId: string | null;
  nodeId: string | null;
  modelPreset: string | null;
  blockId: string | null;
  sourceLabel: string;
}

export interface PlannerSessionDefaults {
  agentId: string | null;
  nodeId: string | null;
  modelPreset: string | null;
  blockId: string;
}

export function buildVisibleFolderContextChips(
  blocks: readonly PlannerBlock[],
): Array<Pick<PlannerSourcedContext, 'id' | 'icon' | 'label'>> {
  const seen = new Set<string>();
  return contextRows(blocks, '이 폴더', false).flatMap((context) => {
    const key = `${context.kind}:${normalizeVisibleLabel(context.label)}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: context.id, icon: context.icon, label: context.label }];
  });
}

export function buildPlannerContextPresentation({
  projectName,
  projectBlocks,
  folderBlocks,
}: {
  projectName: string;
  projectBlocks: readonly PlannerBlock[];
  folderBlocks: readonly PlannerBlock[];
}): {
  contexts: PlannerSourcedContext[];
  assignment: PlannerDefaultAssignment | null;
} {
  const inheritedSource = `${projectName || '프로젝트'}에서 상속`;
  const directDefaults = readLastPlannerSessionDefaults(folderBlocks);
  const inheritedDefaults = readLastPlannerSessionDefaults(projectBlocks);
  const defaults = directDefaults ?? inheritedDefaults;
  return {
    contexts: [
      ...contextRows(projectBlocks, inheritedSource, false),
      ...contextRows(folderBlocks, '이 폴더', true),
    ],
    assignment: defaults ? {
      agentId: defaults.agentId,
      nodeId: defaults.nodeId,
      modelPreset:
        directDefaults?.modelPreset ?? inheritedDefaults?.modelPreset ?? null,
      blockId: directDefaults?.blockId ?? null,
      sourceLabel: directDefaults ? '직접 지정' : inheritedSource,
    } : null,
  };
}

function contextRows(
  blocks: readonly PlannerBlock[],
  sourceLabel: string,
  includeDocuments: boolean,
): PlannerSourcedContext[] {
  return blocks.flatMap<PlannerSourcedContext>((block) => {
    if (block.blockType === 'guidance') {
      const text = block.text.trim();
      return block.properties.enabled === true && text
        ? [{ id: block.id, icon: '✦', label: text, kind: 'guidance', sourceLabel }]
        : [];
    }
    if (block.blockType === 'atom_ref') {
      const instance = stringProperty(block, 'instance') ?? 'atom';
      if (instance !== 'atom' && instance !== 'atom-nl') return [];
      const nodeId = stringProperty(block, 'nodeId');
      if (!nodeId) return [];
      return [{
        id: block.id,
        icon: '⚛',
        label: stringProperty(block, 'nodeTitle')
          ?? stringProperty(block, 'title')
          ?? stringProperty(block, 'label')
          ?? nodeId,
        kind: 'atom',
        sourceLabel,
      }];
    }
    const documentTitle = includeDocuments && block.blockType === 'paragraph'
      ? /^\[\[([^\]]+)\]\]$/.exec(block.text.trim())?.[1]?.trim()
      : null;
    return documentTitle
      ? [{ id: block.id, icon: '📄', label: documentTitle, kind: 'document', sourceLabel }]
      : [];
  });
}

export function readLastPlannerSessionDefaults(
  blocks: readonly PlannerBlock[],
): PlannerSessionDefaults | null {
  const block = [...blocks].reverse().find((candidate) => (
    candidate.blockType === 'session_defaults'
      && Boolean(stringProperty(candidate, 'agentId') || stringProperty(candidate, 'nodeId'))
  ));
  return block ? {
    agentId: stringProperty(block, 'agentId'),
    nodeId: stringProperty(block, 'nodeId'),
    modelPreset: stringProperty(block, 'modelPreset'),
    blockId: block.id,
  } : null;
}

function stringProperty(block: PlannerBlock, key: string): string | null {
  const value = block.properties[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeVisibleLabel(label: string): string {
  return label.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR');
}
