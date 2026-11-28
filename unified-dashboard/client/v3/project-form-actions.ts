import { FolderMessageError } from "./folder-messages";
import type { BlockDto } from "../../../packages/page-model/src/types";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import type { PageStructureOperation } from "@seosoyoung/soul-ui/page/page-structure-operation";
import { decodeStateVector, projectAtomProperties } from "./project-context-actions";
import type { ProjectFormValue } from "./project-form-model";
import { parseProjectPageDetails, type ProjectPageDetails } from "./project-page-details";
import { saveFolderDescription } from "./folder-workspace-page-api";
import { descriptionMarkdown } from "./folder-workspace-run-model";

type Input = Parameters<PageApiClient["applyOperations"]>[1];
type Creation = { key: string; operation: Extract<PageStructureOperation, {op: "create_block"}> };
interface Attempt { pageId: string; fingerprint: string; input: Input; oldIds: Set<string>; creations: Creation[] }
/** Owned by one open form. A failed attempt retains its exact wire request. */
export interface ProjectContextSaveSession {
  attempt?: Attempt;
  previous?: ProjectPageDetails;
  ids?: Record<string, string>;
}

export async function saveProjectFormContext(
  api: PageApiClient, pageId: string, previous: ProjectPageDetails, next: ProjectFormValue,
  session: ProjectContextSaveSession = {},
): Promise<void> {
  const fingerprint = JSON.stringify(next);
  // Resolve an uncertain earlier submission before allowing changed draft content.
  if (session.attempt) {
    const completedFingerprint = session.attempt.fingerprint;
    await finishAttempt(api, session);
    if (fingerprint === completedFingerprint) return;
  }
  let current = await api.getPage(pageId);
  if (next.description.trim() !== descriptionMarkdown(current.page, current.blocks)) {
    await saveFolderDescription(api, pageId, next.description);
    current = await api.getPage(pageId);
  }
  const baseline = session.previous ?? previous;
  const ids = session.ids ?? {};
  const operations: PageStructureOperation[] = [];
  const creations: Creation[] = [];
  const atoms = next.atomReferences.map((row, index) => {
    const rowKey = `atom:${row.draftId ?? index}`;
    return { ...row, key: rowKey, blockId: row.blockId ?? ids[rowKey] ?? null };
  });
  const retainedAtoms = new Set(atoms.map((row) => row.blockId));
  const removedAtoms = baseline.atomReferences.filter((row) => !retainedAtoms.has(row.blockId)).map((row) => row.blockId);
  const replaced = replaceSingleBlock(current.blocks, "guidance", next.guidance.source === "own"
    ? { text: next.guidance.text.trim(), properties: (prior) => ({ ...prior, enabled: true, scope: "project" }) }
    : null);
  const defaults = next.sessionDefaults;
  const replacedDefaults = replaceSingleBlock(current.blocks, "session_defaults", defaults.source === "own"
    ? { text: "", properties: () => ({
      agentId: defaults.agentId.trim(), nodeId: defaults.nodeId.trim(),
      ...(defaults.modelPreset.trim() ? { modelPreset: defaults.modelPreset.trim() } : {}), scope: "session",
    }) }
    : null);
  const removed = [...removedAtoms, ...replaced.removed, ...replacedDefaults.removed];
  for (const blockId of removed) operations.push({ op: "delete_block_subtree", block_id: blockId });
  operations.push(...replaced.updates, ...replacedDefaults.updates);
  const removedIds = new Set(removed);
  const lastRoot = current.blocks.filter(block => block.parent_id === null && !removedIds.has(block.id)).at(-1)?.id ?? null;
  let lastTemp: string | null = null;
  const create = (rowKey: string, block_type: string, text: string, properties: Record<string, unknown>) => {
    const operation: Creation["operation"] = { op: "create_block", temp_id: crypto.randomUUID(), parent_id: null,
      after_block_id: lastTemp ? null : lastRoot, ...(lastTemp ? { after_temp_id: lastTemp } : {}), block_type, text, properties, collapsed: false };
    lastTemp = operation.temp_id; operations.push(operation); creations.push({ key: rowKey, operation });
  };
  if (replaced.create) create("guidance", "guidance", replaced.create.text, replaced.create.properties);
  for (const row of atoms) {
    const properties = projectAtomProperties(row, current.blocks);
    const prior = current.blocks.find(block => block.id === row.blockId);
    if (!row.blockId) create(row.key, "atom_ref", "", properties);
    else if (JSON.stringify(prior?.properties) !== JSON.stringify(properties)) operations.push({ op: "update_block_type_and_properties", block_id: row.blockId, block_type: "atom_ref", properties });
  }
  if (replacedDefaults.create) create("defaults", "session_defaults", "", replacedDefaults.create.properties);
  if (!operations.length) return;
  session.attempt = { pageId, fingerprint, creations, oldIds: new Set(current.blocks.map(block => block.id)), input: {
    expectedVersion: current.page.version, expectedStateVector: decodeStateVector(current.state_vector),
    idempotencyKey: `v3-project-context:browser:${crypto.randomUUID()}`, reason: "v3 project context save", operations,
  } };
  await finishAttempt(api, session);
}

/** One block of this type on the folder page carries the value; the others are removed. */
function replaceSingleBlock(
  blocks: readonly BlockDto[],
  blockType: "guidance" | "session_defaults",
  next: { text: string; properties(prior: Record<string, unknown>): Record<string, unknown> } | null,
): { removed: string[]; updates: PageStructureOperation[]; create: { text: string; properties: Record<string, unknown> } | null } {
  const existing = blocks.filter((block) => block.block_type === blockType);
  if (!next) return { removed: existing.map((block) => block.id), updates: [], create: null };
  const [kept, ...rest] = existing;
  const removed = rest.map((block) => block.id);
  if (!kept) return { removed, updates: [], create: { text: next.text, properties: next.properties({}) } };
  const properties = next.properties(kept.properties);
  const updates: PageStructureOperation[] = [];
  if (kept.text !== next.text) updates.push({ op: "update_block_text", block_id: kept.id, text: next.text });
  if (JSON.stringify(kept.properties) !== JSON.stringify(properties)) {
    updates.push({ op: "update_block_type_and_properties", block_id: kept.id, block_type: blockType, properties });
  }
  return { removed, updates, create: null };
}

async function finishAttempt(api: PageApiClient, session: ProjectContextSaveSession): Promise<void> {
  const attempt = session.attempt!;
  const result = await api.applyOperations(attempt.pageId, attempt.input);
  // Replays can return an empty temp mapping; the returned snapshot is authoritative.
  let blocks = result.blocks;
  let mapping = recoverIds(attempt, blocks, result.temp_id_mapping);
  if (!mapping) {
    blocks = (await api.getPage(attempt.pageId)).blocks;
    mapping = recoverIds(attempt, blocks, result.temp_id_mapping);
  }
  if (!mapping) throw new FolderMessageError("folders.errors.saveUnconfirmed");
  session.ids = { ...session.ids, ...mapping };
  session.previous = parseProjectPageDetails(blocks);
  delete session.attempt;
}

function recoverIds(attempt: Attempt, blocks: BlockDto[], tempIds: Record<string, string>): Record<string, string> | null {
  const ids: Record<string, string> = {};
  const used = new Set(attempt.oldIds);
  for (const { key, operation } of attempt.creations) {
    const block = blocks.find(candidate => candidate.id === tempIds[operation.temp_id])
      ?? blocks.find(candidate => !used.has(candidate.id) && candidate.block_type === operation.block_type
        && candidate.text === operation.text && Object.entries(operation.properties).every(([name, value]) => candidate.properties[name] === value));
    if (!block) return null;
    used.add(block.id); ids[key] = block.id;
  }
  return ids;
}
