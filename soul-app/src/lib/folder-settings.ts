import type { PlannerBlock } from '../api/plannerTypes';
import type { InitialFolderContext } from '../api/initialFolderContext';
import type { PageStructureOperation } from '../../../packages/soul-ui/src/page/page-structure-operation';
import { parseAtomReference, stringProperty, type FolderAtomReference } from './folder-context';

export type ContextSource = 'inherit' | 'own';

export interface FolderExecutionDefaults {
  nodeId: string | null;
  agentId: string | null;
  modelPreset: string | null;
}

export interface FolderSettingsDraft {
  title: string;
  description: string;
  guidanceSource: ContextSource;
  guidance: string;
  atomReferences: FolderAtomReference[];
  defaultsSource: ContextSource;
  defaults: FolderExecutionDefaults;
}

export const EMPTY_EXECUTION_DEFAULTS: FolderExecutionDefaults = { nodeId: null, agentId: null, modelPreset: null };

export function emptyFolderSettingsDraft(): FolderSettingsDraft {
  return folderSettingsDraftFromBlocks({ title: '', description: '', blocks: [] });
}

/** Every guidance block of the folder joins into one text box; the first defaults block is the folder's own value. */
export function folderSettingsDraftFromBlocks({ title, description, blocks }: {
  title: string;
  description: string;
  blocks: readonly PlannerBlock[];
}): FolderSettingsDraft {
  const guidance = guidanceBlocks(blocks).map((block) => block.text.trim()).filter(Boolean);
  const defaults = defaultsBlocks(blocks).find((block) => stringProperty(block, 'agentId') || stringProperty(block, 'nodeId'));
  return {
    title,
    description,
    guidanceSource: guidance.length > 0 ? 'own' : 'inherit',
    guidance: guidance.join('\n\n'),
    atomReferences: blocks.flatMap((block) => {
      const reference = parseAtomReference(block);
      return reference ? [reference] : [];
    }),
    defaultsSource: defaults ? 'own' : 'inherit',
    defaults: defaults ? {
      nodeId: stringProperty(defaults, 'nodeId'),
      agentId: stringProperty(defaults, 'agentId'),
      modelPreset: stringProperty(defaults, 'modelPreset'),
    } : EMPTY_EXECUTION_DEFAULTS,
  };
}

/**
 * Sources as saved. A folder without a parent has nothing to inherit: filled values are its own,
 * and empty guidance or unset defaults write no block. Empty own guidance is saved as inherit everywhere.
 */
export function resolveDraftSources(draft: FolderSettingsDraft, hasParent: boolean): FolderSettingsDraft {
  const guidanceSource: ContextSource = (!hasParent || draft.guidanceSource === 'own') && draft.guidance.trim() ? 'own' : 'inherit';
  const defaultsSource: ContextSource = hasParent
    ? draft.defaultsSource
    : draft.defaults.nodeId || draft.defaults.agentId ? 'own' : 'inherit';
  return { ...draft, guidanceSource, defaultsSource };
}

/** Page operations that make the folder's own blocks match the draft. */
export function folderContextOperations(
  blocks: readonly PlannerBlock[],
  draft: FolderSettingsDraft,
  createId: (prefix: string) => string,
): PageStructureOperation[] {
  const updates: PageStructureOperation[] = [];
  const deletions: PageStructureOperation[] = [];
  const creations: Array<{ prefix: string; blockType: string; text: string; properties: Record<string, unknown> }> = [];

  const guidance = draft.guidanceSource === 'own' ? draft.guidance.trim() : '';
  const [firstGuidance, ...otherGuidance] = guidanceBlocks(blocks);
  const guidanceProperties = { enabled: true, scope: 'project' };
  if (guidance && firstGuidance) {
    if (firstGuidance.text !== guidance) updates.push({ op: 'update_block_text', block_id: firstGuidance.id, text: guidance });
    if (!sameProperties(firstGuidance.properties, guidanceProperties)) {
      updates.push({ op: 'update_block_type_and_properties', block_id: firstGuidance.id, block_type: 'guidance', properties: guidanceProperties });
    }
  } else if (guidance) {
    creations.push({ prefix: 'guidance', blockType: 'guidance', text: guidance, properties: guidanceProperties });
  }
  for (const block of guidance ? otherGuidance : guidanceBlocks(blocks)) deletions.push(remove(block.id));

  const retained = new Set(draft.atomReferences.map((reference) => reference.blockId).filter(Boolean));
  for (const block of blocks) {
    if (block.blockType === 'atom_ref' && !retained.has(block.id)) deletions.push(remove(block.id));
  }
  for (const reference of draft.atomReferences) {
    const previous = reference.blockId ? blocks.find((block) => block.id === reference.blockId) : undefined;
    const properties = atomProperties(reference, previous?.properties ?? {});
    if (!previous) creations.push({ prefix: 'atom-ref', blockType: 'atom_ref', text: '', properties });
    else if (!sameProperties(previous.properties, properties)) {
      updates.push({ op: 'update_block_type_and_properties', block_id: previous.id, block_type: 'atom_ref', properties });
    }
  }

  const [firstDefaults, ...otherDefaults] = defaultsBlocks(blocks);
  if (draft.defaultsSource === 'own') {
    const properties = sessionDefaultsProperties(draft.defaults);
    if (!firstDefaults) creations.push({ prefix: 'session-defaults', blockType: 'session_defaults', text: '', properties });
    else if (!sameProperties(firstDefaults.properties, properties)) {
      updates.push({ op: 'update_block_type_and_properties', block_id: firstDefaults.id, block_type: 'session_defaults', properties });
    }
    for (const block of otherDefaults) deletions.push(remove(block.id));
  } else {
    for (const block of defaultsBlocks(blocks)) deletions.push(remove(block.id));
  }

  const removed = new Set(deletions.map((operation) => (operation as { block_id: string }).block_id));
  const lastRoot = [...blocks].reverse().find((block) => block.parentId === null && !removed.has(block.id))?.id ?? null;
  let previousTemp: string | null = null;
  const created = creations.map((creation): PageStructureOperation => {
    const tempId = createId(creation.prefix);
    const operation: PageStructureOperation = {
      op: 'create_block', temp_id: tempId, parent_id: null,
      after_block_id: previousTemp ? null : lastRoot,
      ...(previousTemp ? { after_temp_id: previousTemp } : {}),
      block_type: creation.blockType, text: creation.text, properties: creation.properties, collapsed: false,
    };
    previousTemp = tempId;
    return operation;
  });
  return [...updates, ...deletions, ...created];
}

/** The create request carries the same shape: one guidance text and only directly chosen defaults. */
export function initialContextFromDraft(draft: FolderSettingsDraft): InitialFolderContext {
  const defaults = draft.defaultsSource === 'own' ? requireCompleteDefaults(draft.defaults) : null;
  return {
    guidance: draft.guidanceSource === 'own' ? draft.guidance.trim() : '',
    atomReferences: draft.atomReferences.map((reference) => ({
      instance: reference.instance,
      nodeId: reference.nodeId,
      nodeTitle: reference.nodeTitle,
      depth: reference.depth,
      titlesOnly: reference.titlesOnly,
    })),
    ...(defaults ? { sessionDefaults: {
      nodeId: defaults.nodeId,
      agentId: defaults.agentId,
      ...(defaults.modelPreset ? { modelPreset: defaults.modelPreset } : {}),
    } } : {}),
  };
}

export function formatExecutionDefaultsSummary(names: {
  agentName: string | null;
  nodeName: string | null;
  modelName: string | null;
}): string {
  return [names.agentName, names.nodeName, names.modelName].filter(Boolean).join(' · ');
}

export function atomReferenceMeta(reference: { depth: number; titlesOnly: boolean }): string {
  return reference.titlesOnly ? `깊이 ${reference.depth} · 제목만` : `깊이 ${reference.depth}`;
}

function guidanceBlocks(blocks: readonly PlannerBlock[]): PlannerBlock[] {
  return blocks.filter((block) => block.blockType === 'guidance');
}

function defaultsBlocks(blocks: readonly PlannerBlock[]): PlannerBlock[] {
  return blocks.filter((block) => block.blockType === 'session_defaults');
}

function atomProperties(reference: FolderAtomReference, previous: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    ...previous,
    instance: reference.instance,
    nodeId: reference.nodeId,
    nodeTitle: reference.nodeTitle,
    depth: reference.depth,
    titlesOnly: reference.titlesOnly,
  };
  if (reference.limit != null) properties.limit = reference.limit;
  if (reference.mode !== undefined) properties.mode = reference.mode;
  return properties;
}

function sessionDefaultsProperties(defaults: FolderExecutionDefaults): Record<string, unknown> {
  const complete = requireCompleteDefaults(defaults);
  return {
    agentId: complete.agentId,
    nodeId: complete.nodeId,
    ...(complete.modelPreset ? { modelPreset: complete.modelPreset } : {}),
    scope: 'session',
  };
}

function requireCompleteDefaults(defaults: FolderExecutionDefaults) {
  const nodeId = defaults.nodeId?.trim();
  const agentId = defaults.agentId?.trim();
  if (!nodeId || !agentId) throw new Error('기본 실행 환경은 노드와 에이전트를 모두 골라야 합니다.');
  return { nodeId, agentId, modelPreset: defaults.modelPreset?.trim() || null };
}

function remove(blockId: string): PageStructureOperation {
  return { op: 'delete_block_subtree', block_id: blockId };
}

function sameProperties(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}
