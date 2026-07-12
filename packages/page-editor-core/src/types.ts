export interface EditorBlockSnapshot {
  readonly id: string;
  readonly pageId: string;
  readonly parentId: string | null;
  readonly positionKey: string;
  readonly collapsed: boolean;
  readonly type: string;
  readonly text: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface TextRange {
  readonly anchor: number;
  readonly focus: number;
}

export type BlockReference =
  | { readonly kind: "existing"; readonly blockId: string }
  | { readonly kind: "temporary"; readonly tempId: string };

export interface FocusResult {
  readonly target: BlockReference;
  readonly selection: TextRange;
}

export type SemanticEditIntent =
  | {
      readonly type: "update-text";
      readonly target: BlockReference;
      readonly text: string;
    }
  | {
      readonly type: "create-block";
      readonly tempId: string;
      readonly parent: BlockReference | null;
      readonly after: BlockReference | null;
      readonly blockType: string;
      readonly text: string;
      readonly properties: Readonly<Record<string, unknown>>;
      readonly collapsed: boolean;
    }
  | {
      readonly type: "update-type-and-properties";
      readonly target: BlockReference;
      readonly blockType: string;
      readonly properties: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "move-block";
      readonly target: BlockReference;
      readonly parent: BlockReference | null;
      readonly after: BlockReference | null;
    }
  | {
      readonly type: "delete-subtree";
      readonly target: BlockReference;
    };

export interface ParsedClipboardBlock {
  readonly text: string;
  readonly type?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly collapsed?: boolean;
  readonly children: readonly ParsedClipboardBlock[];
}

export interface ClipboardInput {
  readonly plainText?: string;
  readonly html?: string;
  readonly structured?: { readonly blocks?: readonly ParsedClipboardBlock[] };
  readonly files?: readonly { readonly type?: string; readonly name?: string }[];
  readonly forcePlainText?: boolean;
}

export type ParsedClipboard =
  | { readonly kind: "plain-text"; readonly text: string }
  | { readonly kind: "block-tree"; readonly blocks: readonly ParsedClipboardBlock[] }
  | { readonly kind: "unsupported"; readonly reason: string };

interface CompositionAwareOperation {
  readonly isComposing?: boolean;
}

export type EditorOperation =
  | ({
      readonly type: "splitBlock";
      readonly blockId: string;
      readonly selection: TextRange;
      readonly newBlockTempId?: string;
    } & CompositionAwareOperation)
  | ({
      readonly type: "mergePrevious" | "mergeNext";
      readonly blockId: string;
      readonly selection: TextRange;
    } & CompositionAwareOperation)
  | {
      readonly type: "indent" | "outdent";
      readonly blockIds: readonly string[];
      readonly focus?: {
        readonly blockId: string;
        readonly selection: TextRange;
      };
    }
  | { readonly type: "deleteSelection"; readonly blockIds: readonly string[] }
  | {
      readonly type: "paste";
      readonly blockId: string;
      readonly selection: TextRange;
      readonly payload: ParsedClipboard;
      readonly tempIdPrefix?: string;
    }
  | {
      readonly type: "pasteOverSelection";
      readonly blockIds: readonly string[];
      readonly placeholderTempId: string;
      readonly payload: ParsedClipboard;
      readonly tempIdPrefix?: string;
    }
  | { readonly type: "noop"; readonly reason: string };

export interface EditorOperationPlan {
  readonly intents: readonly SemanticEditIntent[];
  readonly focus: FocusResult | null;
  readonly noopReason?: string;
}

export function existingBlock(blockId: string): BlockReference {
  return { kind: "existing", blockId };
}

export function temporaryBlock(tempId: string): BlockReference {
  return { kind: "temporary", tempId };
}

export function focusAt(target: BlockReference, offset: number): FocusResult {
  return { target, selection: { anchor: offset, focus: offset } };
}

export function noopPlan(reason: string): EditorOperationPlan {
  return { intents: [], focus: null, noopReason: reason };
}
