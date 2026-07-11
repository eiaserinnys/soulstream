import { expect } from "vitest";

import type {
  BlockReference,
  EditorBlockSnapshot,
  SemanticEditIntent,
} from "../src/index.js";

interface BlockFixtureInput {
  id: string;
  text?: string;
  parentId?: string | null;
  positionKey?: string;
  collapsed?: boolean;
  type?: string;
}

export interface ProjectedBlock {
  ref: string;
  id: string;
  text: string;
  parentRef: string | null;
  type: string;
  collapsed: boolean;
}

export function createSnapshot(inputs: readonly BlockFixtureInput[]): EditorBlockSnapshot[] {
  const siblingCounts = new Map<string | null, number>();
  return inputs.map((input) => {
    const parentId = input.parentId ?? null;
    const siblingIndex = siblingCounts.get(parentId) ?? 0;
    siblingCounts.set(parentId, siblingIndex + 1);
    return {
      id: input.id,
      pageId: "page-1",
      parentId,
      positionKey: input.positionKey ?? String(siblingIndex).padStart(4, "0"),
      collapsed: input.collapsed ?? false,
      type: input.type ?? "paragraph",
      text: input.text ?? "",
    };
  });
}

export class IntentProjection {
  readonly nodes = new Map<string, ProjectedBlock>();
  readonly children = new Map<string | null, string[]>();

  constructor(snapshot: readonly EditorBlockSnapshot[]) {
    for (const block of snapshot) {
      this.nodes.set(block.id, {
        ref: block.id,
        id: block.id,
        text: block.text,
        parentRef: block.parentId,
        type: block.type,
        collapsed: block.collapsed,
      });
    }
    for (const block of snapshot) {
      const siblings = this.children.get(block.parentId) ?? [];
      siblings.push(block.id);
      this.children.set(block.parentId, siblings);
    }
    for (const [parentRef, refs] of this.children) {
      refs.sort((left, right) => {
        const leftBlock = snapshot.find((block) => block.id === left)!;
        const rightBlock = snapshot.find((block) => block.id === right)!;
        return leftBlock.positionKey.localeCompare(rightBlock.positionKey) || left.localeCompare(right);
      });
      this.children.set(parentRef, refs);
    }
  }

  apply(intents: readonly SemanticEditIntent[]): this {
    for (const intent of intents) {
      if (intent.type === "update-text") {
        this.require(intent.target).text = intent.text;
      } else if (intent.type === "create-block") {
        const ref = intent.tempId;
        const parentRef = refKey(intent.parent);
        this.nodes.set(ref, {
          ref,
          id: ref,
          text: intent.text,
          parentRef,
          type: intent.blockType,
          collapsed: intent.collapsed,
        });
        this.insert(ref, parentRef, refKey(intent.after));
      } else if (intent.type === "move-block") {
        const ref = refKey(intent.target)!;
        const node = this.require(intent.target);
        this.remove(ref, node.parentRef);
        node.parentRef = refKey(intent.parent);
        this.insert(ref, node.parentRef, refKey(intent.after));
      } else {
        this.deleteSubtree(refKey(intent.target)!);
      }
    }
    return this;
  }

  childIds(parentRef: string | null = null): string[] {
    return [...(this.children.get(parentRef) ?? [])];
  }

  text(ref: string): string {
    return this.require({ kind: "existing", blockId: ref }).text;
  }

  parent(ref: string): string | null {
    return this.require({ kind: "existing", blockId: ref }).parentRef;
  }

  private require(reference: BlockReference): ProjectedBlock {
    const key = refKey(reference)!;
    const node = this.nodes.get(key);
    expect(node, `missing projected block ${key}`).toBeDefined();
    return node!;
  }

  private insert(ref: string, parentRef: string | null, afterRef: string | null): void {
    const siblings = this.children.get(parentRef) ?? [];
    const index = afterRef === null ? 0 : siblings.indexOf(afterRef) + 1;
    expect(index, `after reference ${afterRef ?? "<start>"} must be a sibling`).toBeGreaterThanOrEqual(0);
    siblings.splice(index, 0, ref);
    this.children.set(parentRef, siblings);
  }

  private remove(ref: string, parentRef: string | null): void {
    const siblings = this.children.get(parentRef) ?? [];
    const index = siblings.indexOf(ref);
    if (index >= 0) siblings.splice(index, 1);
  }

  private deleteSubtree(ref: string): void {
    for (const child of [...(this.children.get(ref) ?? [])]) this.deleteSubtree(child);
    const node = this.nodes.get(ref);
    if (!node) return;
    this.remove(ref, node.parentRef);
    this.children.delete(ref);
    this.nodes.delete(ref);
  }
}

export function project(
  snapshot: readonly EditorBlockSnapshot[],
  intents: readonly SemanticEditIntent[],
): IntentProjection {
  return new IntentProjection(snapshot).apply(intents);
}

export function existing(blockId: string): BlockReference {
  return { kind: "existing", blockId };
}

export function temporary(tempId: string): BlockReference {
  return { kind: "temporary", tempId };
}

function refKey(reference: BlockReference | null): string | null {
  if (reference === null) return null;
  return reference.kind === "existing" ? reference.blockId : reference.tempId;
}
