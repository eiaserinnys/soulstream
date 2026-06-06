import { useEffect, useMemo, useRef, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import type { CatalogBoardItem, CatalogState, MarkdownDocument } from "../shared/types";

export const BOARD_YJS_PREFIX = "board-folder:";
export const BOARD_ITEMS_MAP = "boardItems";
export const MARKDOWN_BODIES_MAP = "markdownBodies";

export interface BoardYjsItemValue {
  item_type: CatalogBoardItem["itemType"];
  item_id: string;
  x: number;
  y: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface RemoteBoardSelection {
  clientId: number;
  itemId: string;
  color: string;
}

export type BoardYjsConnectionStatus = "connected" | "disconnected" | "reconnecting";

export interface BoardYjsRuntime {
  folderId: string;
  doc: Y.Doc;
  awareness: Awareness;
  isProviderBacked: boolean;
  subscribe: (listener: () => void) => () => void;
  getBoardItems: () => CatalogBoardItem[];
  updateBoardItemPosition: (boardItemId: string, x: number, y: number) => void;
  upsertBoardItem: (boardItem: CatalogBoardItem) => void;
  deleteBoardItem: (boardItemId: string) => void;
  createMarkdownDocument: (input: {
    title: string;
    body: string;
    x: number;
    y: number;
  }) => { document: MarkdownDocument; boardItem: CatalogBoardItem };
  getMarkdownText: (documentId: string) => Y.Text;
  updateMarkdownTitle: (documentId: string, title: string) => void;
  updateMarkdownBody: (documentId: string, body: string) => void;
  deleteMarkdownDocument: (documentId: string) => void;
  setLocalSelection: (itemId: string | null) => void;
  getRemoteSelections: () => RemoteBoardSelection[];
}

const runtimeByFolder = new Map<string, BoardYjsRuntime>();
const registryListeners = new Set<() => void>();

export function getBoardYjsDocumentName(folderId: string): string {
  return `${BOARD_YJS_PREFIX}${folderId}`;
}

export function buildBoardYjsUrl(folderId: string, locationLike: Location = window.location): string {
  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${locationLike.host}/yjs/${encodeURIComponent(folderId)}`;
}

export function isBoardYjsBrowserConnectionAvailable(locationLike: Location = window.location): boolean {
  const isJsdom = typeof navigator !== "undefined" && navigator.userAgent.includes("jsdom");
  return (
    typeof window !== "undefined" &&
    typeof window.WebSocket !== "undefined" &&
    !isJsdom &&
    (locationLike.protocol === "http:" || locationLike.protocol === "https:")
  );
}

export function catalogBoardItemsFromYDoc(folderId: string, doc: Y.Doc): CatalogBoardItem[] {
  const map = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  return Array.from(map.entries())
    .map(([id, value]) => ({
      id,
      folderId,
      itemType: value.item_type,
      itemId: value.item_id,
      x: value.x,
      y: value.y,
      metadata: value.metadata ?? {},
      ...(value.created_at ? { createdAt: value.created_at } : {}),
      ...(value.updated_at ? { updatedAt: value.updated_at } : {}),
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
}

export function seedBoardYDocFromCatalog(
  doc: Y.Doc,
  folderId: string,
  catalog: CatalogState | null,
): void {
  const items = catalog?.boardItems?.filter((item) => item.folderId === folderId) ?? [];
  const map = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  doc.transact(() => {
    for (const item of items) {
      map.set(item.id, toYjsItemValue(item));
      if (item.itemType === "markdown") {
        getOrCreateMarkdownText(doc, item.itemId);
      }
    }
  });
}

export function upsertBoardYjsItem(doc: Y.Doc, boardItem: CatalogBoardItem): void {
  doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP).set(boardItem.id, toYjsItemValue(boardItem));
}

export function updateBoardYjsItemPosition(
  doc: Y.Doc,
  boardItemId: string,
  x: number,
  y: number,
): void {
  const map = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const current = map.get(boardItemId);
  if (!current) return;
  map.set(boardItemId, {
    ...current,
    x,
    y,
    updated_at: new Date().toISOString(),
  });
}

export function deleteBoardYjsItem(doc: Y.Doc, boardItemId: string): void {
  doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP).delete(boardItemId);
}

export function createMarkdownYjsDocument(
  doc: Y.Doc,
  folderId: string,
  input: { title: string; body: string; x: number; y: number; documentId?: string },
): { document: MarkdownDocument; boardItem: CatalogBoardItem } {
  const documentId = input.documentId ?? createDocumentId();
  const title = input.title.trim() || "Untitled document";
  const body = input.body;
  const text = getOrCreateMarkdownText(doc, documentId);
  text.delete(0, text.length);
  text.insert(0, body);
  const boardItem: CatalogBoardItem = {
    id: `markdown:${documentId}`,
    folderId,
    itemType: "markdown",
    itemId: documentId,
    x: input.x,
    y: input.y,
    metadata: {
      title,
      preview: getMarkdownPreview(body),
      version: 1,
    },
  };
  upsertBoardYjsItem(doc, boardItem);
  return {
    document: { id: documentId, title, body, version: 1 },
    boardItem,
  };
}

export function getOrCreateMarkdownText(doc: Y.Doc, documentId: string): Y.Text {
  const map = doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
  let text = map.get(documentId);
  if (!text) {
    text = new Y.Text();
    map.set(documentId, text);
  }
  return text;
}

export function updateMarkdownYjsTitle(doc: Y.Doc, documentId: string, title: string): void {
  const boardItemId = `markdown:${documentId}`;
  const map = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const current = map.get(boardItemId);
  if (!current) return;
  map.set(boardItemId, {
    ...current,
    metadata: {
      ...(current.metadata ?? {}),
      title: title.trim() || "Untitled document",
      version: nextMarkdownVersion(current.metadata),
    },
    updated_at: new Date().toISOString(),
  });
}

export function updateMarkdownYjsBody(doc: Y.Doc, documentId: string, body: string): void {
  const text = getOrCreateMarkdownText(doc, documentId);
  text.delete(0, text.length);
  text.insert(0, body);
  const boardItemId = `markdown:${documentId}`;
  const map = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const current = map.get(boardItemId);
  if (!current) return;
  map.set(boardItemId, {
    ...current,
    metadata: {
      ...(current.metadata ?? {}),
      preview: getMarkdownPreview(body),
      version: nextMarkdownVersion(current.metadata),
    },
    updated_at: new Date().toISOString(),
  });
}

export function setBoardAwarenessSelection(
  awareness: Awareness,
  itemId: string | null,
  color: string,
): void {
  awareness.setLocalStateField("boardSelection", itemId ? { itemId, color } : null);
}

export function readRemoteBoardSelections(awareness: Awareness): RemoteBoardSelection[] {
  const localClientId = awareness.clientID;
  const result: RemoteBoardSelection[] = [];
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === localClientId) continue;
    const selection = state.boardSelection;
    if (!selection || typeof selection !== "object") continue;
    const itemId = (selection as Record<string, unknown>).itemId;
    const color = (selection as Record<string, unknown>).color;
    if (typeof itemId !== "string" || typeof color !== "string") continue;
    result.push({ clientId, itemId, color });
  }
  return result;
}

export function registerBoardYjsRuntime(runtime: BoardYjsRuntime): () => void {
  runtimeByFolder.set(runtime.folderId, runtime);
  emitRegistryChange();
  return () => {
    if (runtimeByFolder.get(runtime.folderId) === runtime) {
      runtimeByFolder.delete(runtime.folderId);
      emitRegistryChange();
    }
  };
}

export function getBoardYjsRuntime(folderId: string | null | undefined): BoardYjsRuntime | null {
  return folderId ? runtimeByFolder.get(folderId) ?? null : null;
}

export function subscribeBoardYjsRuntime(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}

export function placeBoardSessionInYjs(
  folderId: string,
  sessionId: string,
  position: { x: number; y: number },
): boolean {
  const runtime = getBoardYjsRuntime(folderId);
  if (!runtime) return false;
  runtime.upsertBoardItem({
    id: `session:${sessionId}`,
    folderId,
    itemType: "session",
    itemId: sessionId,
    x: position.x,
    y: position.y,
  });
  return true;
}

export function useBoardYjsRuntime(params: {
  folderId: string | null;
  catalog: CatalogState | null;
  selectionItemId: string | null;
  localSelectionColor?: string;
}): {
  runtime: BoardYjsRuntime | null;
  boardItems: CatalogBoardItem[] | null;
  isLoading: boolean;
  remoteSelections: RemoteBoardSelection[];
  connectionStatus: BoardYjsConnectionStatus;
  connectionError: string | null;
} {
  const { folderId, catalog, selectionItemId, localSelectionColor = "#22c55e" } = params;
  const [state, setState] = useState<{
    runtime: BoardYjsRuntime | null;
    boardItems: CatalogBoardItem[] | null;
    isLoading: boolean;
    remoteSelections: RemoteBoardSelection[];
    connectionStatus: BoardYjsConnectionStatus;
    connectionError: string | null;
  }>({
    runtime: null,
    boardItems: null,
    isLoading: false,
    remoteSelections: [],
    connectionStatus: "disconnected",
    connectionError: null,
  });
  const latestCatalogRef = useRef(catalog);
  latestCatalogRef.current = catalog;

  useEffect(() => {
    if (!folderId) {
      setState({
        runtime: null,
        boardItems: null,
        isLoading: false,
        remoteSelections: [],
        connectionStatus: "disconnected",
        connectionError: null,
      });
      return;
    }

    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const listeners = new Set<() => void>();
    const canConnect = isBoardYjsBrowserConnectionAvailable();
    let connectionStatus: BoardYjsConnectionStatus = canConnect ? "reconnecting" : "disconnected";
    let connectionError: string | null = canConnect
      ? null
      : "Board sync websocket is unavailable in this browser environment.";
    let hasConnected = false;
    let provider: HocuspocusProvider | null = null;
    if (!canConnect) {
      seedBoardYDocFromCatalog(doc, folderId, latestCatalogRef.current);
    }
    const runtime = createRuntime(folderId, doc, awareness, listeners, canConnect);
    const unsubscribeRuntime = registerBoardYjsRuntime(runtime);
    const boardItemsMap = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
    const markdownBodies = doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
    const refresh = () => {
      setState({
        runtime,
        boardItems: runtime.getBoardItems(),
        isLoading: canConnect && connectionStatus === "reconnecting" && !provider?.isSynced,
        remoteSelections: runtime.getRemoteSelections(),
        connectionStatus,
        connectionError,
      });
    };
    if (canConnect) {
      provider = new HocuspocusProvider({
        url: buildBoardYjsUrl(folderId),
        name: getBoardYjsDocumentName(folderId),
        document: doc,
        awareness,
        token: "cookie",
        onSynced: refresh,
        onAuthenticationFailed: ({ reason }) => {
          connectionStatus = "disconnected";
          connectionError = reason || "Authentication failed";
          refresh();
        },
        onStatus: ({ status }) => {
          if (status === "connected") {
            hasConnected = true;
            connectionStatus = "connected";
            connectionError = null;
          } else if (status === "connecting") {
            connectionStatus = "reconnecting";
            connectionError = hasConnected ? "Reconnecting board sync websocket." : null;
          } else {
            connectionStatus = "disconnected";
            connectionError = hasConnected
              ? "Board sync websocket disconnected."
              : "Board sync websocket failed to connect.";
          }
          refresh();
        },
        onAwarenessChange: refresh,
      });
    }

    boardItemsMap.observe(refresh);
    markdownBodies.observe(refresh);
    awareness.on("change", refresh);
    listeners.add(refresh);
    refresh();

    return () => {
      listeners.delete(refresh);
      awareness.off("change", refresh);
      boardItemsMap.unobserve(refresh);
      markdownBodies.unobserve(refresh);
      unsubscribeRuntime();
      provider?.destroy();
      awareness.destroy();
      doc.destroy();
    };
  }, [folderId]);

  useEffect(() => {
    state.runtime?.setLocalSelection(selectionItemId);
  }, [selectionItemId, state.runtime]);

  useEffect(() => {
    if (!state.runtime) return;
    setBoardAwarenessSelection(state.runtime.awareness, selectionItemId, localSelectionColor);
  }, [localSelectionColor, selectionItemId, state.runtime]);

  return useMemo(() => state, [state]);
}

function createRuntime(
  folderId: string,
  doc: Y.Doc,
  awareness: Awareness,
  listeners: Set<() => void>,
  isProviderBacked: boolean,
): BoardYjsRuntime {
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    folderId,
    doc,
    awareness,
    isProviderBacked,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getBoardItems: () => catalogBoardItemsFromYDoc(folderId, doc),
    updateBoardItemPosition: (boardItemId, x, y) => {
      updateBoardYjsItemPosition(doc, boardItemId, x, y);
      notify();
    },
    upsertBoardItem: (boardItem) => {
      upsertBoardYjsItem(doc, boardItem);
      notify();
    },
    deleteBoardItem: (boardItemId) => {
      deleteBoardYjsItem(doc, boardItemId);
      notify();
    },
    createMarkdownDocument: (input) => {
      const created = createMarkdownYjsDocument(doc, folderId, input);
      notify();
      return created;
    },
    getMarkdownText: (documentId) => getOrCreateMarkdownText(doc, documentId),
    updateMarkdownTitle: (documentId, title) => {
      updateMarkdownYjsTitle(doc, documentId, title);
      notify();
    },
    updateMarkdownBody: (documentId, body) => {
      updateMarkdownYjsBody(doc, documentId, body);
      notify();
    },
    deleteMarkdownDocument: (documentId) => {
      deleteBoardYjsItem(doc, `markdown:${documentId}`);
      doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP).delete(documentId);
      notify();
    },
    setLocalSelection: (itemId) => {
      setBoardAwarenessSelection(awareness, itemId, selectionColorForFolder(folderId));
      notify();
    },
    getRemoteSelections: () => readRemoteBoardSelections(awareness),
  };
}

function toYjsItemValue(item: CatalogBoardItem): BoardYjsItemValue {
  return {
    item_type: item.itemType,
    item_id: item.itemId,
    x: item.x,
    y: item.y,
    metadata: sanitizeBoardItemMetadata(item.metadata),
    ...(item.createdAt ? { created_at: item.createdAt } : {}),
    ...(item.updatedAt ? { updated_at: item.updatedAt } : {}),
  };
}

function nextMarkdownVersion(metadata: Record<string, unknown> | undefined): number {
  const value = metadata?.version;
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.trunc(value) + 1;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.trunc(parsed) + 1;
  }
  return 2;
}

function sanitizeBoardItemMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const cleaned = { ...(metadata ?? {}) };
  delete cleaned.signedUrl;
  delete cleaned.uploadUrl;
  delete cleaned.uploadUrls;
  delete cleaned.uploadProgress;
  return cleaned;
}

function createDocumentId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getMarkdownPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 180);
}

function emitRegistryChange(): void {
  for (const listener of registryListeners) listener();
}

function selectionColorForFolder(folderId: string): string {
  let hash = 0;
  for (const char of folderId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 70% 48%)`;
}
