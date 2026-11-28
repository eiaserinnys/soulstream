import { folderErrorText } from "./folder-messages";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  CustomViewIframe,
  DashboardIconCap,
  DisclosureActionIcon,
  FrameLoading,
  FrameNotice,
  deleteMarkdownDocument,
  renameMarkdownDocument,
  retainEqualValue,
  useCustomViewBindings,
  useDashboardStore,
  type CatalogBoardItem,
  type CustomViewDocument,
  type MarkdownDocument,
} from "@seosoyoung/soul-ui";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";
import { Check, FilePlus2, X } from "lucide-react";

import {
  discardFolderBoardItems,
  fetchInlineCustomView,
  fetchInlineMarkdown,
  loadFolderBoardItems,
  refreshFolderBoardItems,
  saveInlineMarkdown,
} from "./folder-inline-board-api";
import { InlineMarkdownCard } from "./InlineMarkdownCard";
import { FolderDescriptionPanel } from "./FolderDescriptionPanel";
import { FolderDocumentContextMenu, type FolderDocumentContextTarget } from "./FolderDocumentContextMenu";
import { documentContextMenuTargetForKey } from "./document-context-menu-keyboard";
import { createMarkdownDocument, moveBoardItemToFolder } from "../lib/board-workspace-operations";
import "./v3-context-menus.css";
import { useV3InvalidationKey, useV3PageInvalidationKey } from "./v3-live-invalidation-plane";
import { loadConfirmedResult } from "./planner-query-state";
import {
  boardMarkdownDocuments,
  metadataText,
  metadataVersion,
  patchBoardMarkdownTitle,
  type FolderBoardMarkdownDocument,
} from "./folder-inline-board-model";
import type { FolderMoveTarget } from "./folder-move-targets";

interface MarkdownRenameState {
  documentId: string;
  input: string;
  pending: boolean;
  error: string;
}

const COLLAPSED_BOARD_ITEM_LIMIT = 5;
const ITEM_INVALIDATION_SOURCES = ["catalog", "folder", "replay"] as const;
const REPLAY_INVALIDATION_SOURCES = ["replay"] as const;
const CUSTOM_VIEW_INVALIDATION_SOURCES = ["custom_view", "replay"] as const;

export function FolderInlineBoard({
  folderId,
  api,
  folderMoveTargets,
  markdownDocumentsRevision = 0,
  onMarkdownDocumentsChanged,
}: {
  folderId: string;
  api: PageApiClient;
  folderMoveTargets: readonly FolderMoveTarget[];
  markdownDocumentsRevision?: number;
  onMarkdownDocumentsChanged(documents: FolderBoardMarkdownDocument[]): void;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.resolvedLanguage);
  const [items, setItems] = useState<CatalogBoardItem[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [boardExpanded, setBoardExpanded] = useState(false);
  const [renameState, setRenameState] = useState<MarkdownRenameState | null>(null);
  const [documentContext, setDocumentContext] = useState<FolderDocumentContextTarget | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const itemInvalidationKey = useV3InvalidationKey(ITEM_INVALIDATION_SOURCES);
  const pageInvalidationKey = useV3PageInvalidationKey(
    items.filter((item) => item.itemType === "markdown").map((item) => item.itemId),
  ) + useV3InvalidationKey(REPLAY_INVALIDATION_SOURCES) + markdownDocumentsRevision;
  const customViewInvalidationKey = useV3InvalidationKey(CUSTOM_VIEW_INVALIDATION_SOURCES);
  const itemsRef = useRef(items);
  const departedItemIdsRef = useRef(new Set<string>());
  const addBoardItem = useDashboardStore((state) => state.addBoardItem);
  const removeBoardItem = useDashboardStore((state) => state.removeBoardItem);
  const loadedFolderIdRef = useRef<string | null>(null);
  itemsRef.current = items;

  useEffect(() => {
    setExpandedId(null);
    setBoardExpanded(false);
    setRenameState(null);
    setDocumentContext(null);
    setCreateError("");
    departedItemIdsRef.current.clear();
  }, [folderId]);

  useEffect(() => {
    const controller = new AbortController();
    const sameFolder = loadedFolderIdRef.current === folderId;
    const previous = sameFolder ? itemsRef.current : null;
    if (!sameFolder) {
      setItems([]);
      setStatus("loading");
    }
    let confirmed = false;
    const load = () => {
      // 첫 읽기는 폴더별 공유 읽기(같은 열쇠의 다른 표면과 합류)를 쓰고,
      // loadConfirmedResult의 확인 읽기는 새로 요청해 공유 결과를 바꾼다.
      const shared = !confirmed;
      confirmed = true;
      return shared
        ? loadFolderBoardItems(folderId, itemInvalidationKey, globalThis.fetch.bind(globalThis), controller.signal)
        : refreshFolderBoardItems(folderId, itemInvalidationKey, globalThis.fetch.bind(globalThis), controller.signal);
    };
    void loadConfirmedResult({
      previous,
      load,
      clearsVisibleContent: (current, next) => current.length > 0 && next.length === 0,
    }).then((next) => {
      loadedFolderIdRef.current = folderId;
      for (const item of next) departedItemIdsRef.current.delete(item.id);
      setItems((current) => retainEqualValue(current, next));
      setStatus("ready");
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus("error");
    });
    return () => controller.abort();
  }, [itemInvalidationKey, folderId]);

  useEffect(() => {
    onMarkdownDocumentsChanged(boardMarkdownDocuments(items, t));
  }, [items, onMarkdownDocumentsChanged, t]);

  const createMarkdown = async () => {
    if (status !== "ready" || creating) return;
    setCreating(true);
    setCreateError("");
    try {
      const result = await createMarkdownDocument({
        folderId,
        title: t("folders.board.untitled"),
        body: "",
      });
      discardFolderBoardItems(folderId);
      setItems((current) => retainEqualValue(current, [...current, result.boardItem]));
      addBoardItem(result.boardItem);
      setRenameState({
        documentId: result.document.id,
        input: result.document.title,
        pending: false,
        error: "",
      });
    } catch {
      setCreateError(t("folders.board.createError"));
    } finally {
      setCreating(false);
    }
  };

  const beginRename = (item: CatalogBoardItem) => {
    setRenameState({
      documentId: item.itemId,
      input: metadataText(item, "title") || t("folders.board.untitled"),
      pending: false,
      error: "",
    });
  };

  const commitRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renameState || renameState.pending) return;
    const item = itemsRef.current.find((candidate) => (
      candidate.itemType === "markdown" && candidate.itemId === renameState.documentId
    ));
    if (!item) {
      setRenameState(null);
      return;
    }
    const version = metadataVersion(item);
    if (version === null) {
      setRenameState((current) => current ? {
        ...current,
        error: t("folders.board.reloadToRename"),
      } : null);
      return;
    }
    const previousTitle = metadataText(item, "title") || t("folders.board.untitled");
    const title = renameState.input.trim() || t("folders.board.untitled");
    if (title === previousTitle) {
      setRenameState(null);
      return;
    }
    setItems((current) => patchBoardMarkdownTitle(current, item.itemId, title));
    setRenameState((current) => current ? { ...current, pending: true, error: "" } : null);
    try {
      const updated = await renameMarkdownDocument({
        documentId: item.itemId,
        title,
        expectedVersion: version,
      });
      discardFolderBoardItems(folderId);
      setItems((current) => patchBoardMarkdownTitle(current, item.itemId, updated.title, updated.version));
      setRenameState(null);
    } catch (error) {
      setItems((current) => patchBoardMarkdownTitle(current, item.itemId, previousTitle, version));
      setRenameState((current) => current ? {
        ...current,
        input: title,
        pending: false,
        error: error instanceof Error ? folderErrorText(t, error) : t("folders.board.renameError"),
      } : null);
    }
  };

  const moveMarkdownToFolder = async (item: CatalogBoardItem, target: FolderMoveTarget) => {
    const result = await moveBoardItemToFolder({
      boardItemId: item.id,
      folderId: target.folderId,
      idempotencyKey: createMoveIdempotencyKey(item.id, target.folderId),
    });
    discardFolderBoardItems(folderId);
    discardFolderBoardItems(target.folderId);
    departedItemIdsRef.current.add(item.id);
    setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    removeBoardItem(item.id);
    addBoardItem(result.boardItem);
    if (expandedId === item.id) setExpandedId(null);
  };

  const deleteMarkdown = async (item: CatalogBoardItem) => {
    await deleteMarkdownDocument(item.itemId);
    discardFolderBoardItems(folderId);
    departedItemIdsRef.current.add(item.id);
    setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    removeBoardItem(item.id);
    if (expandedId === item.id) setExpandedId(null);
  };

  return (
    <section className="v3-detail-section v3-inline-board" data-testid="v3-inline-board">
      <div className="v3-detail-section-head">
        <h3>▦ {t("folders.sections.board")}</h3><span>{status === "ready" ? t("folders.common.itemCount", { total: number.format(items.length) }) : ""}</span>
        <span className="v3-spacer" />
        {items.length > COLLAPSED_BOARD_ITEM_LIMIT ? (
          <DashboardIconCap
            size="small"
            label={boardExpanded ? t("folders.board.collapse") : t("folders.board.expand")}
            aria-expanded={boardExpanded}
            onClick={() => setBoardExpanded((expanded) => !expanded)}
          >
            <DisclosureActionIcon expanded={boardExpanded} className="h-4 w-4" />
          </DashboardIconCap>
        ) : null}
        <DashboardIconCap
          size="small"
          label={t("folders.board.addMarkdown")}
          disabled={status !== "ready" || creating}
          onClick={() => { void createMarkdown(); }}
        >
          <FilePlus2 className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
      {status === "loading" ? <FrameLoading label={t("folders.board.loading")} /> : null}
      {status === "error" ? <p className="v3-inline-board-error" role="alert">{t("folders.board.loadError")}</p> : null}
      {createError ? <p className="v3-inline-board-error" role="alert">{createError}</p> : null}
      {status === "ready" && items.length === 0 ? <p className="v3-detail-empty">{t("folders.board.empty")}</p> : null}
      <div className="v3-inline-board-list">
        {(boardExpanded ? items : items.slice(0, COLLAPSED_BOARD_ITEM_LIMIT)).map((item) => {
          const expanded = expandedId === item.id;
          if (item.itemType === "markdown") {
            const title = metadataText(item, "title") || t("folders.board.untitled");
            const activeRename = renameState?.documentId === item.itemId ? renameState : null;
            return (
              <InlineMarkdownCard key={item.id} title={title} expanded={expanded}
                onToggle={() => setExpandedId(expanded ? null : item.id)}
                onRename={() => beginRename(item)}
                rowProps={{
                  onContextMenu: (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setDocumentContext({ item, target: { x: event.clientX, y: event.clientY } });
                  },
                  onKeyDown: (event) => {
                    const target = documentContextMenuTargetForKey(
                      { key: event.key, shiftKey: event.shiftKey },
                      event.currentTarget.getBoundingClientRect(),
                    );
                    if (!target) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setDocumentContext({ item, target });
                  },
                }}
                renameForm={activeRename ? (
                    <form className="v3-inline-board-rename" onSubmit={(event) => { void commitRename(event); }}>
                      <span aria-hidden="true">📄</span>
                      <input
                        autoFocus
                        aria-label={t("folders.board.markdownName")}
                        value={activeRename.input}
                        disabled={activeRename.pending}
                        onChange={(event) => setRenameState((current) => current ? { ...current, input: event.target.value, error: "" } : null)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            setRenameState(null);
                          }
                        }}
                      />
                      <div className="v3-inline-board-rename-actions">
                        <DashboardIconCap
                          label={t("folders.board.saveRename")}
                          type="submit"
                          disabled={activeRename.pending}
                        >
                          <Check className="h-4 w-4" aria-hidden="true" />
                        </DashboardIconCap>
                        <DashboardIconCap
                          label={t("folders.board.cancelRename")}
                          disabled={activeRename.pending}
                          onClick={() => setRenameState(null)}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </DashboardIconCap>
                      </div>
                    </form>
                ) : undefined}
                error={activeRename?.error}
              >
                {expanded ? <InlineMarkdown documentId={item.itemId} invalidationKey={pageInvalidationKey} /> : null}
              </InlineMarkdownCard>
            );
          }
          if (item.itemType === "custom_view") {
            const title = metadataText(item, "title") || "Custom view";
            return (
              <LiquidGlassCard key={item.id} webglSurface cornerRadius="floor" className="v3-inline-board-item" data-board-kind="custom_view">
                <div className="v3-inline-board-row">
                  <div className="v3-inline-board-label"><span>▦ {title}</span></div>
                  <DashboardIconCap
                    label={t(expanded ? "folders.common.collapseNamed" : "folders.common.expandNamed", { name: title })}
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : item.id)}
                  >
                    <DisclosureActionIcon expanded={expanded} className="h-4 w-4" />
                  </DashboardIconCap>
                </div>
                {expanded ? <InlineCustomView customViewId={item.itemId} invalidationKey={customViewInvalidationKey} /> : null}
              </LiquidGlassCard>
            );
          }
          return <InlineAsset key={item.id} item={item} />;
        })}
      </div>
      <FolderDocumentContextMenu
        api={api}
        currentFolderId={folderId}
        defaultTargets={folderMoveTargets}
        context={documentContext}
        onClose={() => setDocumentContext(null)}
        onOpen={(item) => setExpandedId(item.id)}
        onMove={moveMarkdownToFolder}
        onDelete={deleteMarkdown}
      />
    </section>
  );
}

function createMoveIdempotencyKey(boardItemId: string, targetFolderId: string): string {
  const randomPart = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `board-item-move:${boardItemId}:task:${targetFolderId}:${randomPart}`;
}

function InlineMarkdown({ documentId, invalidationKey }: { documentId: string; invalidationKey: number }) {
  const { t } = useTranslation();
  const [document, setDocument] = useState<MarkdownDocument | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void fetchInlineMarkdown(documentId, (input, init) => globalThis.fetch(input, { ...init, signal: controller.signal }))
      .then((next) => setDocument((current) => retainEqualValue(current ?? undefined, next)))
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(true);
      });
    return () => controller.abort();
  }, [documentId, invalidationKey]);
  if (error) return <FrameNotice><p className="v3-inline-board-error" role="alert">{t("folders.board.bodyError")}</p></FrameNotice>;
  if (!document) return <FrameLoading label={t("folders.board.bodyLoading")} />;
  return (
    <div className="v3-inline-markdown" data-testid="v3-inline-markdown">
      <FolderDescriptionPanel
        markdown={document.body}
        ariaLabel={t("folders.board.documentLabel", { name: document.title })}
        emptyText={t("folders.board.bodyEmpty")}
        variant="inline"
        onSave={async (body) => {
          const updated = await saveInlineMarkdown({
            documentId,
            title: document.title,
            body,
            expectedVersion: document.version,
          });
          setDocument(updated);
        }}
      />
    </div>
  );
}

function InlineCustomView({ customViewId, invalidationKey }: { customViewId: string; invalidationKey: number }) {
  const { t } = useTranslation();
  const bindings = useCustomViewBindings();
  const [document, setDocument] = useState<CustomViewDocument | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetchInlineCustomView(customViewId, (input, init) => globalThis.fetch(input, { ...init, signal: controller.signal }))
      .then((next) => setDocument((current) => retainEqualValue(current ?? undefined, next)))
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(true);
      });
    return () => controller.abort();
  }, [customViewId, invalidationKey]);
  if (error) return <FrameNotice><p className="v3-inline-board-error" role="alert">{t("folders.board.customViewError")}</p></FrameNotice>;
  if (!document) return <FrameLoading label={t("folders.board.customViewLoading")} />;
  return (
    <CustomViewIframe
      html={document.html}
      bindings={bindings}
      title={document.title?.trim() || "Custom view"}
      className="v3-inline-custom-view"
    />
  );
}

function InlineAsset({ item }: { item: CatalogBoardItem }) {
  const { t } = useTranslation();
  const title = metadataText(item, "originalName") || metadataText(item, "title") || t("folders.board.attachment");
  const href = metadataText(item, "signedUrl") || metadataText(item, "sourceUrl");
  return (
    <LiquidGlassCard webglSurface cornerRadius="floor" className="v3-inline-board-item" data-board-kind="asset">
      {href ? <a href={href} target="_blank" rel="noreferrer"><span>↗ {title}</span><small>{t("folders.common.open")}</small></a> : <div><span>📎 {title}</span></div>}
    </LiquidGlassCard>
  );
}

