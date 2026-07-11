import * as Y from "yjs";

export class PageMutationVersionConflictError extends Error {
  readonly code = "PAGE_MUTATION_VERSION_CONFLICT";

  constructor(
    readonly pageId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`page ${pageId} version conflict: expected ${expectedVersion}, actual ${actualVersion}`);
  }
}

export class PageMutationStateVectorConflictError extends Error {
  readonly code = "PAGE_MUTATION_STATE_VECTOR_CONFLICT";

  constructor(readonly pageId: string) {
    super(`page ${pageId} state vector conflict`);
  }
}

export function stateVectorsEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function docFromUpdate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

export function yMapFromRecord(input: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(input)) map.set(key, structuredClone(value));
  return map;
}

export function commandPayload(command: object): Record<string, unknown> {
  return structuredClone(command) as unknown as Record<string, unknown>;
}
