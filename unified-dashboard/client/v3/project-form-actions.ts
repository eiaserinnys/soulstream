import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import {
  deleteProjectContextBlock,
  saveProjectAtomReference,
  saveProjectGuidance,
  saveProjectSessionDefaults,
} from "./project-context-actions";
import type { ProjectFormValue } from "./project-form-model";
import type { ProjectPageDetails } from "./project-page-details";

export async function saveProjectFormContext(
  api: PageApiClient,
  pageId: string,
  previous: ProjectPageDetails,
  next: ProjectFormValue,
): Promise<void> {
  const nextGuidanceIds = new Set(next.guidance.flatMap((item) => item.blockId ? [item.blockId] : []));
  const nextAtomIds = new Set(next.atomReferences.flatMap((item) => item.blockId ? [item.blockId] : []));
  const nextDefaultsId = next.sessionDefaults?.blockId ?? null;

  for (const item of previous.guidance) {
    if (!nextGuidanceIds.has(item.blockId)) await deleteProjectContextBlock(api, pageId, item.blockId);
  }
  for (const item of previous.atomReferences) {
    if (!nextAtomIds.has(item.blockId)) await deleteProjectContextBlock(api, pageId, item.blockId);
  }
  for (const item of previous.sessionDefaults) {
    if (item.blockId !== nextDefaultsId) await deleteProjectContextBlock(api, pageId, item.blockId);
  }

  const previousGuidance = new Map(previous.guidance.map((item) => [item.blockId, item]));
  for (const item of next.guidance) {
    const prior = item.blockId ? previousGuidance.get(item.blockId) : undefined;
    if (!prior || prior.text !== item.text.trim()) {
      await saveProjectGuidance(api, pageId, { blockId: item.blockId, text: item.text });
    }
  }

  const previousAtoms = new Map(previous.atomReferences.map((item) => [item.blockId, item]));
  for (const item of next.atomReferences) {
    const prior = item.blockId ? previousAtoms.get(item.blockId) : undefined;
    if (!prior || !sameAtom(prior, item)) {
      await saveProjectAtomReference(api, pageId, item);
    }
  }

  if (next.sessionDefaults && (next.sessionDefaults.agentId || next.sessionDefaults.nodeId)) {
    const prior = next.sessionDefaults.blockId
      ? previous.sessionDefaults.find((item) => item.blockId === next.sessionDefaults?.blockId)
      : undefined;
    if (
      !prior
      || (prior.agentId ?? "") !== next.sessionDefaults.agentId
      || (prior.nodeId ?? "") !== next.sessionDefaults.nodeId
    ) {
      await saveProjectSessionDefaults(api, pageId, {
        blockId: next.sessionDefaults.blockId,
        agentId: next.sessionDefaults.agentId || null,
        nodeId: next.sessionDefaults.nodeId || null,
      });
    }
  }
}

function sameAtom(
  previous: ProjectPageDetails["atomReferences"][number],
  next: ProjectFormValue["atomReferences"][number],
): boolean {
  return previous.instance === next.instance
    && previous.nodeId === next.nodeId.trim()
    && previous.nodeTitle === (next.nodeTitle.trim() || next.nodeId.trim())
    && (previous.depth ?? 3) === next.depth
    && (previous.titlesOnly ?? false) === next.titlesOnly;
}
