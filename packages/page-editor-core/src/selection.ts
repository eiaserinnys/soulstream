import { focusAt, type BlockReference, type FocusResult, type TextRange } from "./types.js";

export interface FocusableTextControl {
  readonly value: string;
  readonly isConnected?: boolean;
  focus(): void;
  setSelectionRange(selectionStart: number, selectionEnd: number): void;
}

export interface FocusSelectionHost {
  getTextControlByBlockId(blockId: string): FocusableTextControl | null;
}

export interface SelectionScheduler {
  queueMicrotask(callback: () => void): void;
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
}

export interface PostRenderFocusSelectionApplier {
  requestApply(state: FocusResult | null, onApplied?: (applied: boolean) => void): void;
  cancel(): void;
}

export interface VisualLineMetrics {
  readonly caretTop: number;
  readonly caretBottom: number;
  readonly firstLineTop: number;
  readonly firstLineBottom: number;
  readonly lastLineTop: number;
  readonly lastLineBottom: number;
  readonly tolerancePx?: number;
}

export interface AdjacentEditableBlock {
  readonly target: BlockReference;
  readonly textLength: number;
}

export type ArrowNavigationDecision = { readonly kind: "native" } | { readonly kind: "focus"; readonly focus: FocusResult };

export interface VerticalEdgeNavigationInput {
  readonly direction: "up" | "down";
  readonly selection: TextRange;
  readonly metrics: VisualLineMetrics | null;
  readonly previousBlock?: AdjacentEditableBlock | null;
  readonly nextBlock?: AdjacentEditableBlock | null;
}

export interface HorizontalEdgeNavigationInput {
  readonly direction: "left" | "right";
  readonly selection: TextRange;
  readonly textLength: number;
  readonly previousBlock?: AdjacentEditableBlock | null;
  readonly nextBlock?: AdjacentEditableBlock | null;
}

export interface CompositionGuard {
  readonly isComposing: boolean;
  compositionStart(): void;
  compositionEnd(): void;
  structuralOperationState(): { readonly isComposing: boolean };
  canRunStructuralOperation(): boolean;
}

const MAX_POST_RENDER_FOCUS_ATTEMPTS = 60;

export function applyFocusSelection(host: FocusSelectionHost, state: FocusResult | null): boolean {
  if (!state) return false;
  const key = state.target.kind === "existing" ? state.target.blockId : state.target.tempId;
  const control = host.getTextControlByBlockId(key);
  if (!control || control.isConnected === false) return false;
  const anchor = clamp(state.selection.anchor, control.value.length);
  const focus = clamp(state.selection.focus, control.value.length);
  control.focus();
  control.setSelectionRange(anchor, focus);
  return true;
}

export function createPostRenderFocusSelectionApplier(
  host: FocusSelectionHost,
  scheduler: SelectionScheduler = browserScheduler(),
): PostRenderFocusSelectionApplier {
  let pending: { state: FocusResult; onApplied?: (applied: boolean) => void; attempts: number } | null = null;
  let microtaskQueued = false;
  let frame: number | null = null;
  let generation = 0;

  const scheduleFrame = (requestedGeneration: number) => {
    if (requestedGeneration !== generation || pending === null) return;
    if (frame !== null) scheduler.cancelAnimationFrame(frame);
    frame = scheduler.requestAnimationFrame(() => {
      frame = null;
      const latest = pending;
      if (latest === null || requestedGeneration !== generation) return;
      const applied = applyFocusSelection(host, latest.state);
      latest.onApplied?.(applied);
      if (pending !== latest) return;
      if (applied) {
        pending = null;
        return;
      }
      latest.attempts += 1;
      if (latest.attempts >= MAX_POST_RENDER_FOCUS_ATTEMPTS) {
        pending = null;
        return;
      }
      scheduleFrame(requestedGeneration);
    });
  };

  return {
    requestApply(state, onApplied) {
      pending = state === null ? null : { state, onApplied, attempts: 0 };
      if (microtaskQueued) return;
      microtaskQueued = true;
      const requestedGeneration = generation;
      scheduler.queueMicrotask(() => {
        if (requestedGeneration !== generation) return;
        microtaskQueued = false;
        if (pending === null) return;
        scheduleFrame(requestedGeneration);
      });
    },
    cancel() {
      generation += 1;
      pending = null;
      microtaskQueued = false;
      if (frame !== null) scheduler.cancelAnimationFrame(frame);
      frame = null;
    },
  };
}

export function decideVerticalEdgeNavigation(input: VerticalEdgeNavigationInput): ArrowNavigationDecision {
  if (!collapsed(input.selection) || !input.metrics) return { kind: "native" };
  if (input.direction === "up") {
    if (!onFirstLine(input.metrics) || !input.previousBlock) return { kind: "native" };
    return focusDecision(input.previousBlock, input.selection.focus);
  }
  if (!onLastLine(input.metrics) || !input.nextBlock) return { kind: "native" };
  return focusDecision(input.nextBlock, input.selection.focus);
}

export function decideHorizontalEdgeNavigation(input: HorizontalEdgeNavigationInput): ArrowNavigationDecision {
  if (!collapsed(input.selection)) return { kind: "native" };
  const offset = clamp(input.selection.focus, input.textLength);
  if (input.direction === "left") {
    if (offset !== 0 || !input.previousBlock) return { kind: "native" };
    return focusDecision(input.previousBlock, input.previousBlock.textLength);
  }
  if (offset !== input.textLength || !input.nextBlock) return { kind: "native" };
  return focusDecision(input.nextBlock, 0);
}

export function createCompositionGuard(initialIsComposing = false): CompositionGuard {
  let isComposing = initialIsComposing;
  return {
    get isComposing() { return isComposing; },
    compositionStart() { isComposing = true; },
    compositionEnd() { isComposing = false; },
    structuralOperationState() { return { isComposing }; },
    canRunStructuralOperation() { return !isComposing; },
  };
}

function focusDecision(block: AdjacentEditableBlock, offset: number): ArrowNavigationDecision {
  return { kind: "focus", focus: focusAt(block.target, clamp(offset, block.textLength)) };
}

function onFirstLine(metrics: VisualLineMetrics): boolean {
  return metrics.caretTop <= metrics.firstLineBottom + (metrics.tolerancePx ?? 1);
}

function onLastLine(metrics: VisualLineMetrics): boolean {
  return metrics.caretBottom >= metrics.lastLineTop - (metrics.tolerancePx ?? 1);
}

function collapsed(selection: TextRange): boolean {
  return selection.anchor === selection.focus;
}

function clamp(offset: number, length: number): number {
  return Math.min(Math.max(0, offset), length);
}

function browserScheduler(): SelectionScheduler {
  const runtime = globalThis as typeof globalThis & {
    requestAnimationFrame?: (callback: () => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
  };
  return {
    queueMicrotask(callback) { globalThis.queueMicrotask(callback); },
    requestAnimationFrame(callback) {
      return typeof runtime.requestAnimationFrame === "function"
        ? runtime.requestAnimationFrame(callback)
        : globalThis.setTimeout(callback, 0) as unknown as number;
    },
    cancelAnimationFrame(handle) {
      if (typeof runtime.cancelAnimationFrame === "function") runtime.cancelAnimationFrame(handle);
      else globalThis.clearTimeout(handle);
    },
  };
}
