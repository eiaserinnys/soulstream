import type { BlockDto, PageApiClient, PageStructureOperation } from "@seosoyoung/soul-ui/page";
import { decodeStateVector, projectAtomProperties } from "./project-context-actions";
import type { ProjectFormValue } from "./project-form-model";
import { parseProjectPageDetails, type ProjectPageDetails } from "./project-page-details";

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
  const current = await api.getPage(pageId);
  const baseline = session.previous ?? previous;
  const ids = session.ids ?? {};
  const operations: PageStructureOperation[] = [];
  const creations: Creation[] = [];
  const key = (kind: string, row: {draftId?: string}, index: number) => `${kind}:${row.draftId ?? index}`;
  const guidance = next.guidance.map((row, index) => ({ ...row, key: key("guidance", row, index), blockId: row.blockId ?? ids[key("guidance", row, index)] ?? null }));
  const atoms = next.atomReferences.map((row, index) => ({ ...row, key: key("atom", row, index), blockId: row.blockId ?? ids[key("atom", row, index)] ?? null }));
  const defaults = next.sessionDefaults && (next.sessionDefaults.agentId || next.sessionDefaults.nodeId || next.sessionDefaults.modelPreset)
    ? { ...next.sessionDefaults, blockId: next.sessionDefaults.blockId ?? ids.defaults ?? null } : null;
  const retained = new Set([...guidance, ...atoms, ...(defaults ? [defaults] : [])].map(row => row.blockId));
  const removed = [...baseline.guidance, ...baseline.atomReferences, ...baseline.sessionDefaults].filter(row => !retained.has(row.blockId));
  for (const row of removed) operations.push({ op: "delete_block_subtree", block_id: row.blockId });
  const removedIds = new Set(removed.map(row => row.blockId));
  const lastRoot = current.blocks.filter(block => block.parent_id === null && !removedIds.has(block.id)).at(-1)?.id ?? null;
  let lastTemp: string | null = null;
  const create = (rowKey: string, block_type: string, text: string, properties: Record<string, unknown>) => {
    const operation: Creation["operation"] = { op: "create_block", temp_id: crypto.randomUUID(), parent_id: null,
      after_block_id: lastTemp ? null : lastRoot, ...(lastTemp ? { after_temp_id: lastTemp } : {}), block_type, text, properties, collapsed: false };
    lastTemp = operation.temp_id; operations.push(operation); creations.push({ key: rowKey, operation });
  };
  for (const row of guidance) {
    const text = row.text.trim();
    if (!text) throw new Error("지침을 입력하거나 빈 항목을 제거하세요");
    const prior = baseline.guidance.find(item => item.blockId === row.blockId);
    if (!row.blockId) create(row.key, "guidance", text, { enabled: true, scope: "project" });
    else if (prior?.text !== text) operations.push({ op: "update_block_text", block_id: row.blockId, text });
  }
  for (const row of atoms) {
    const properties = projectAtomProperties(row, current.blocks);
    const prior = current.blocks.find(block => block.id === row.blockId);
    if (!row.blockId) create(row.key, "atom_ref", "", properties);
    else if (JSON.stringify(prior?.properties) !== JSON.stringify(properties)) operations.push({ op: "update_block_type_and_properties", block_id: row.blockId, block_type: "atom_ref", properties });
  }
  if (defaults) {
    const prior = current.blocks.find(block => block.id === defaults.blockId);
    const properties = { ...prior?.properties, scope: "project", agentId: defaults.agentId.trim() || null, nodeId: defaults.nodeId.trim() || null } as Record<string, unknown>;
    if (defaults.modelPreset.trim()) properties.modelPreset = defaults.modelPreset.trim(); else delete properties.modelPreset;
    if (!defaults.blockId) create("defaults", "session_defaults", "", properties);
    else if (JSON.stringify(prior?.properties) !== JSON.stringify(properties)) operations.push({ op: "update_block_type_and_properties", block_id: defaults.blockId, block_type: "session_defaults", properties });
  }
  if (!operations.length) return;
  session.attempt = { pageId, fingerprint, creations, oldIds: new Set(current.blocks.map(block => block.id)), input: {
    expectedVersion: current.page.version, expectedStateVector: decodeStateVector(current.state_vector),
    idempotencyKey: `v3-project-context:browser:${crypto.randomUUID()}`, reason: "v3 project context save", operations,
  } };
  await finishAttempt(api, session);
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
  if (!mapping) throw new Error("저장 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.");
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
