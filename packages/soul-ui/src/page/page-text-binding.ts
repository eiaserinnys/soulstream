import type * as Y from "yjs";

export interface TextSelection {
  readonly anchor: number;
  readonly head: number;
}

export interface MinimalTextChange {
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: string;
}

export interface PageTextBindingSnapshot {
  readonly text: string;
  readonly selection: TextSelection | null;
  readonly remote: boolean;
}

export interface PageTextBinding {
  getSnapshot(): PageTextBindingSnapshot;
  subscribe(listener: () => void): () => void;
  setSelection(selection: TextSelection | null): void;
  replaceText(value: string, selection?: TextSelection | null): MinimalTextChange | null;
  destroy(): void;
}

type TextDelta = readonly {
  retain?: number;
  insert?: string | object;
  delete?: number;
}[];

const LOCAL_TEXT_BINDING_ORIGIN = Symbol("page-text-binding");

export function applyMinimalTextChange(
  text: Y.Text,
  nextValue: string,
  origin: unknown = LOCAL_TEXT_BINDING_ORIGIN,
): MinimalTextChange | null {
  const current = text.toString();
  if (current === nextValue) return null;
  let prefix = 0;
  const sharedLength = Math.min(current.length, nextValue.length);
  while (prefix < sharedLength && current[prefix] === nextValue[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < nextValue.length - prefix &&
    current[current.length - 1 - suffix] === nextValue[nextValue.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const change = {
    index: prefix,
    deleteCount: current.length - prefix - suffix,
    insert: nextValue.slice(prefix, nextValue.length - suffix),
  };
  const apply = () => {
    if (change.deleteCount > 0) text.delete(change.index, change.deleteCount);
    if (change.insert) text.insert(change.index, change.insert);
  };
  if (text.doc) text.doc.transact(apply, origin);
  else apply();
  return change;
}

export function transformSelectionByDelta(
  selection: TextSelection,
  delta: TextDelta,
): TextSelection {
  return {
    anchor: transformIndex(selection.anchor, delta),
    head: transformIndex(selection.head, delta),
  };
}

export function createPageTextBinding(text: Y.Text): PageTextBinding {
  const listeners = new Set<() => void>();
  let destroyed = false;
  let selection: TextSelection | null = null;
  let snapshot: PageTextBindingSnapshot = Object.freeze({
    text: text.toString(),
    selection,
    remote: false,
  });
  const publish = (remote: boolean) => {
    snapshot = Object.freeze({ text: text.toString(), selection, remote });
    for (const listener of listeners) listener();
  };
  const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    const remote = transaction.origin !== LOCAL_TEXT_BINDING_ORIGIN;
    if (remote && selection) selection = transformSelectionByDelta(selection, event.delta);
    publish(remote);
  };
  text.observe(observer);
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) throw new Error("page text binding is destroyed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSelection(nextSelection) {
      selection = nextSelection === null ? null : clampSelection(nextSelection, text.length);
      publish(false);
    },
    replaceText(value, nextSelection) {
      if (nextSelection !== undefined) {
        selection = nextSelection === null ? null : clampSelection(nextSelection, value.length);
      }
      const change = applyMinimalTextChange(text, value, LOCAL_TEXT_BINDING_ORIGIN);
      if (!change && nextSelection !== undefined) publish(false);
      return change;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      text.unobserve(observer);
    },
  };
}

function transformIndex(index: number, delta: TextDelta): number {
  const target = Math.max(0, index);
  let oldOffset = 0;
  let newOffset = 0;
  for (const part of delta) {
    if (part.insert !== undefined) {
      newOffset += typeof part.insert === "string" ? part.insert.length : 1;
      continue;
    }
    if (part.retain !== undefined) {
      if (target <= oldOffset + part.retain) return newOffset + target - oldOffset;
      oldOffset += part.retain;
      newOffset += part.retain;
      continue;
    }
    if (part.delete !== undefined) {
      if (target <= oldOffset + part.delete) return newOffset;
      oldOffset += part.delete;
    }
  }
  return newOffset + target - oldOffset;
}

function clampSelection(selection: TextSelection, length: number): TextSelection {
  return {
    anchor: Math.max(0, Math.min(length, selection.anchor)),
    head: Math.max(0, Math.min(length, selection.head)),
  };
}
