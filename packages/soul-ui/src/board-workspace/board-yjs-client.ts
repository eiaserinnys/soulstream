import { useEffect, useMemo, useRef, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import type { BoardContainerRef, CatalogBoardItem, CatalogState, MarkdownDocument } from "../shared/types";

export const BOARD_YJS_LEGACY_FOLDER_PREFIX = "board-folder:";
export const BOARD_YJS_CONTAINER_PREFIX = "board:";
export const BOARD_YJS_PREFIX = BOARD_YJS_LEGACY_FOLDER_PREFIX;
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
  container: BoardContainerRef;
  containerKey: string;
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

type BoardContainerInput = string | BoardContainerRef;

const runtimeByContainer = new Map<string, BoardYjsRuntime>();
const registryListeners = new Set<() => void>();

export function getBoardContainerKey(container: BoardContainerRef): string {
  return `${container.kind}:${container.id}`;
}

export function folderBoardContainer(folderId: string): BoardContainerRef {
  return { kind: "folder", id: folderId };
}

export function getBoardYjsDocumentName(containerInput: BoardContainerInput): string {
  const container = normalizeBoardContainer(containerInput);
  if (container.kind === "folder") {
    return `${BOARD_YJS_LEGACY_FOLDER_PREFIX}${container.id}`;
  }
  return `${BOARD_YJS_CONTAINER_PREFIX}${container.kind}:${container.id}`;
}

export function buildBoardYjsUrl(
  containerInput: BoardContainerInput,
  locationLike: Location = window.location,
): string {
  const container = normalizeBoardContainer(containerInput);
  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  if (container.kind === "folder") {
    return `${protocol}//${locationLike.host}/yjs/${encodeURIComponent(container.id)}`;
  }
  return `${protocol}//${locationLike.host}/yjs/${encodeURIComponent(container.kind)}/${encodeURIComponent(container.id)}`;
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

export function catalogBoardItemsFromYDoc(
  containerInput: BoardContainerInput,
  doc: Y.Doc,
  resolvedFolderId?: string | null,
): CatalogBoardItem[] {
  const container = normalizeBoardContainer(containerInput);
  const folderId = resolveFolderIdForContainer(container, resolvedFolderId);
  const map = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  return Array.from(map.entries())
    .map(([id, value]) => ({
      id,
      folderId,
      containerKind: container.kind,
      containerId: container.id,
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
  containerInput: BoardContainerInput,
  catalog: CatalogState | null,
): void {
  const container = normalizeBoardContainer(containerInput);
  const items = catalog?.boardItems?.filter((item) => boardItemBelongsToContainer(item, container)) ?? [];
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
  containerInput: BoardContainerInput,
  input: { title: string; body: string; x: number; y: number; documentId?: string },
  resolvedFolderId?: string | null,
): { document: MarkdownDocument; boardItem: CatalogBoardItem } {
  const container = normalizeBoardContainer(containerInput);
  const folderId = resolveFolderIdForContainer(container, resolvedFolderId);
  const documentId = input.documentId ?? createDocumentId();
  const title = input.title.trim() || "Untitled document";
  const body = input.body;
  const text = getOrCreateMarkdownText(doc, documentId);
  text.delete(0, text.length);
  text.insert(0, body);
  const boardItem: CatalogBoardItem = {
    id: `markdown:${documentId}`,
    folderId,
    containerKind: container.kind,
    containerId: container.id,
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
  runtimeByContainer.set(runtime.containerKey, runtime);
  emitRegistryChange();
  return () => {
    if (runtimeByContainer.get(runtime.containerKey) === runtime) {
      runtimeByContainer.delete(runtime.containerKey);
      emitRegistryChange();
    }
  };
}

export function getBoardYjsRuntime(
  containerInput: BoardContainerInput | null | undefined,
): BoardYjsRuntime | null {
  if (!containerInput) return null;
  const container = normalizeBoardContainer(containerInput);
  return runtimeByContainer.get(getBoardContainerKey(container)) ?? null;
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
    containerKind: "folder",
    containerId: folderId,
    itemType: "session",
    itemId: sessionId,
    x: position.x,
    y: position.y,
  });
  return true;
}

export function useBoardYjsRuntime(params: {
  container: BoardContainerRef | null;
  resolvedFolderId?: string | null;
  catalog: CatalogState | null;
  selectionItemId: string | null;
  localSelectionColor?: string;
}): {
  runtime: BoardYjsRuntime | null;
  boardItems: CatalogBoardItem[] | null;
  hasSynced: boolean;
  isLoading: boolean;
  remoteSelections: RemoteBoardSelection[];
  connectionStatus: BoardYjsConnectionStatus;
  connectionError: string | null;
} {
  const { container, resolvedFolderId, catalog, selectionItemId, localSelectionColor = "#22c55e" } = params;
  const containerKey = container ? getBoardContainerKey(container) : null;
  const runtimeFolderId = container ? resolveFolderIdForContainer(container, resolvedFolderId) : null;
  const [state, setState] = useState<{
    runtime: BoardYjsRuntime | null;
    boardItems: CatalogBoardItem[] | null;
    hasSynced: boolean;
    isLoading: boolean;
    remoteSelections: RemoteBoardSelection[];
    connectionStatus: BoardYjsConnectionStatus;
    connectionError: string | null;
  }>({
    runtime: null,
    boardItems: null,
    hasSynced: false,
    isLoading: false,
    remoteSelections: [],
    connectionStatus: "disconnected",
    connectionError: null,
  });
  const latestCatalogRef = useRef(catalog);
  latestCatalogRef.current = catalog;

  useEffect(() => {
    if (!container || !containerKey || !runtimeFolderId) {
      setState({
        runtime: null,
        boardItems: null,
        hasSynced: false,
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
      seedBoardYDocFromCatalog(doc, container, latestCatalogRef.current);
    }
    const runtime = createRuntime(container, runtimeFolderId, doc, awareness, listeners, canConnect);
    const unsubscribeRuntime = registerBoardYjsRuntime(runtime);
    const boardItemsMap = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
    const markdownBodies = doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
    const refresh = () => {
      const hasSynced = !canConnect || provider?.isSynced === true;
      setState({
        runtime,
        boardItems: runtime.getBoardItems(),
        hasSynced,
        isLoading: canConnect && connectionStatus === "reconnecting" && !hasSynced,
        remoteSelections: runtime.getRemoteSelections(),
        connectionStatus,
        connectionError,
      });
    };
    if (canConnect) {
      provider = new HocuspocusProvider({
        url: buildBoardYjsUrl(container),
        name: getBoardYjsDocumentName(container),
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
  }, [containerKey, runtimeFolderId]);

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
  container: BoardContainerRef,
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
    container,
    containerKey: getBoardContainerKey(container),
    doc,
    awareness,
    isProviderBacked,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getBoardItems: () => catalogBoardItemsFromYDoc(container, doc, folderId),
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
      const created = createMarkdownYjsDocument(doc, container, input, folderId);
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
      setBoardAwarenessSelection(awareness, itemId, selectionColorForContainer(container));
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

function normalizeBoardContainer(containerInput: BoardContainerInput): BoardContainerRef {
  if (typeof containerInput === "string") return folderBoardContainer(containerInput);
  return containerInput;
}

function resolveFolderIdForContainer(
  container: BoardContainerRef,
  resolvedFolderId?: string | null,
): string {
  if (container.kind === "folder") return container.id;
  return resolvedFolderId || container.id;
}

function boardItemBelongsToContainer(
  item: CatalogBoardItem,
  container: BoardContainerRef,
): boolean {
  const itemContainerKind = item.containerKind ?? "folder";
  const itemContainerId = item.containerId ?? item.folderId;
  return itemContainerKind === container.kind && itemContainerId === container.id;
}

function selectionColorForContainer(container: BoardContainerRef): string {
  const seed = getBoardContainerKey(container);
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 70% 48%)`;
}
