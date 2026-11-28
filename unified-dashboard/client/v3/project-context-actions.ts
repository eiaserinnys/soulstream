import { FolderMessageError } from "./folder-messages";
import type { BlockDto } from "../../../packages/page-model/src/types";

export interface AtomReferenceInput {
  blockId: string | null;
  nodeId: string;
  nodeTitle: string;
  depth: number;
  titlesOnly: boolean;
  limit?: number | null;
  mode?: "full" | "index" | "titles";
  instance?: string;
}

export function decodeStateVector(value: string): Uint8Array {
  if (typeof globalThis.atob !== "function") throw new FolderMessageError("folders.errors.decodeState");
  return Uint8Array.from(globalThis.atob(value), (character) => character.charCodeAt(0));
}

/** The atom_ref properties for a reference, keeping what the block already carries beyond the form. */
export function projectAtomProperties(input: AtomReferenceInput, blocks: readonly BlockDto[]): Record<string, unknown> {
  const nodeId = input.nodeId.trim();
  if (!nodeId) throw new FolderMessageError("folders.errors.chooseAtom");
  if (!Number.isInteger(input.depth) || input.depth < 1 || input.depth > 5) {
    throw new FolderMessageError("folders.errors.atomDepth");
  }
  if (input.limit != null && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw new FolderMessageError("folders.errors.atomRecentCount");
  }
  const previous = input.blockId
    ? blocks.find((block) => block.id === input.blockId)?.properties ?? {}
    : {};
  const properties: Record<string, unknown> = {
    ...previous,
    instance: input.instance?.trim() || "atom",
    nodeId,
    nodeTitle: input.nodeTitle.trim() || nodeId,
    depth: input.depth,
    titlesOnly: input.titlesOnly,
    ...(input.limit != null ? { limit: input.limit } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
  };
  if (input.limit == null) delete properties.limit;
  if (input.mode === undefined) delete properties.mode;
  return properties;
}
