import { compareLexicographically, comparePositionKeys } from "@soulstream/fractional-position";

import type { EditorBlockSnapshot } from "./types.js";

export interface SiblingGroup {
  readonly blocks: readonly EditorBlockSnapshot[];
  readonly siblings: readonly EditorBlockSnapshot[];
  readonly startIndex: number;
  readonly endIndex: number;
}

export class SnapshotIndex {
  readonly byId = new Map<string, EditorBlockSnapshot>();
  readonly children = new Map<string | null, readonly EditorBlockSnapshot[]>();
  readonly flat: readonly EditorBlockSnapshot[];

  constructor(snapshot: readonly EditorBlockSnapshot[]) {
    const mutableChildren = new Map<string | null, EditorBlockSnapshot[]>();
    for (const block of snapshot) {
      if (this.byId.has(block.id)) throw new Error(`duplicate block id: ${block.id}`);
      this.byId.set(block.id, block);
      const siblings = mutableChildren.get(block.parentId) ?? [];
      siblings.push(block);
      mutableChildren.set(block.parentId, siblings);
    }
    for (const block of snapshot) {
      if (block.parentId !== null && !this.byId.has(block.parentId)) {
        throw new Error(`missing parent ${block.parentId} for block ${block.id}`);
      }
    }
    for (const [parentId, siblings] of mutableChildren) {
      this.children.set(parentId, [...siblings].sort(compareBlocks));
    }
    this.flat = this.flatten();
    if (this.flat.length !== snapshot.length) throw new Error("block snapshot contains a cycle");
  }

  require(blockId: string): EditorBlockSnapshot {
    const block = this.byId.get(blockId);
    if (!block) throw new Error(`unknown block id: ${blockId}`);
    return block;
  }

  siblingsOf(block: EditorBlockSnapshot): readonly EditorBlockSnapshot[] {
    return this.children.get(block.parentId) ?? [];
  }

  previousSibling(blockId: string): EditorBlockSnapshot | null {
    const block = this.require(blockId);
    const siblings = this.siblingsOf(block);
    const index = siblings.findIndex((candidate) => candidate.id === blockId);
    return index > 0 ? siblings[index - 1] ?? null : null;
  }

  nextSibling(blockId: string): EditorBlockSnapshot | null {
    const block = this.require(blockId);
    const siblings = this.siblingsOf(block);
    const index = siblings.findIndex((candidate) => candidate.id === blockId);
    return index >= 0 ? siblings[index + 1] ?? null : null;
  }

  previousFlat(blockId: string): EditorBlockSnapshot | null {
    const index = this.flat.findIndex((block) => block.id === blockId);
    return index > 0 ? this.flat[index - 1] ?? null : null;
  }

  nextFlat(blockId: string): EditorBlockSnapshot | null {
    const index = this.flat.findIndex((block) => block.id === blockId);
    return index >= 0 ? this.flat[index + 1] ?? null : null;
  }

  lastChild(blockId: string, excludedIds: ReadonlySet<string> = new Set()): EditorBlockSnapshot | null {
    const children = this.children.get(blockId) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const candidate = children[index];
      if (candidate && !excludedIds.has(candidate.id)) return candidate;
    }
    return null;
  }

  siblingGroup(blockIds: readonly string[]): SiblingGroup | null {
    if (blockIds.length === 0 || new Set(blockIds).size !== blockIds.length) return null;
    const blocks = blockIds.map((blockId) => this.byId.get(blockId));
    if (blocks.some((block) => block === undefined)) return null;
    const resolved = blocks as EditorBlockSnapshot[];
    const parentId = resolved[0]!.parentId;
    if (resolved.some((block) => block.parentId !== parentId)) return null;
    const siblings = this.children.get(parentId) ?? [];
    const selected = new Set(blockIds);
    const indexes = siblings
      .map((block, index) => selected.has(block.id) ? index : -1)
      .filter((index) => index >= 0);
    if (indexes.length !== blockIds.length) return null;
    const startIndex = Math.min(...indexes);
    const endIndex = Math.max(...indexes);
    if (endIndex - startIndex + 1 !== blockIds.length) return null;
    return { blocks: siblings.slice(startIndex, endIndex + 1), siblings, startIndex, endIndex };
  }

  subtreeIds(rootId: string): Set<string> {
    const result = new Set<string>();
    const visit = (blockId: string): void => {
      if (result.has(blockId)) return;
      result.add(blockId);
      for (const child of this.children.get(blockId) ?? []) visit(child.id);
    };
    visit(rootId);
    return result;
  }

  private flatten(): EditorBlockSnapshot[] {
    const result: EditorBlockSnapshot[] = [];
    const active = new Set<string>();
    const visit = (block: EditorBlockSnapshot): void => {
      if (active.has(block.id)) return;
      active.add(block.id);
      result.push(block);
      for (const child of this.children.get(block.id) ?? []) visit(child);
      active.delete(block.id);
    };
    for (const root of this.children.get(null) ?? []) visit(root);
    return result;
  }
}

export function compareBlocks(left: EditorBlockSnapshot, right: EditorBlockSnapshot): number {
  return comparePositionKeys(left.positionKey, right.positionKey) || compareLexicographically(left.id, right.id);
}

export function normalizedRange(anchor: number, focus: number, textLength: number) {
  const start = Math.min(clamp(anchor, textLength), clamp(focus, textLength));
  const end = Math.max(clamp(anchor, textLength), clamp(focus, textLength));
  return { start, end };
}

function clamp(offset: number, textLength: number): number {
  return Math.min(Math.max(0, offset), textLength);
}
