import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CustomViewIframe,
  DashboardIconCap,
  DisclosureActionIcon,
  renameMarkdownDocument,
  retainEqualValue,
  useBoardYjsRuntime,
  useCustomViewBindings,
  type CatalogBoardItem,
  type CatalogState,
  type CustomViewDocument,
  type MarkdownDocument,
} from "@seosoyoung/soul-ui";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";
import { FilePlus2, Pencil } from "lucide-react";

import {
  fetchInlineCustomView,
  fetchInlineMarkdown,
  fetchTaskBoardItems,
  saveInlineMarkdown,
} from "./task-inline-board-api";
import { TaskDescriptionPanel } from "./TaskDescriptionPanel";
import "./v3-context-menus.css";
import { useV3InvalidationKey } from "./v3-live-invalidation-plane";
import { loadConfirmedResult } from "./planner-query-state";
import {
  boardMarkdownDocuments,
  findTaskMarkdownPlacement,
  metadataText,
  metadataVersion,
  patchBoardMarkdownTitle,
  type TaskBoardMarkdownDocument,
} from "./task-inline-board-model";

interface MarkdownRenameState {
  documentId: string;
  input: string;
  pending: boolean;
  error: string;
}

const INLINE_ITEM_TYPES = new Set<CatalogBoardItem["itemType"]>([
  "markdown",
  "custom_view",
  "asset",
]);

export function TaskInlineBoard({
  runbookId,
  folderId,
  onMarkdownDocumentsChanged,
}: {
  runbookId: string;
  folderId: string | null;
  onMarkdownDocumentsChanged(documents: TaskBoardMarkdownDocument[]): void;
}) {
  const [items, setItems] = useState<CatalogBoardItem[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [renameState, setRenameState] = useState<MarkdownRenameState | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const itemInvalidationKey = useV3InvalidationKey(["catalog", "runbook", "replay"]);
  const pageInvalidationKey = useV3InvalidationKey(["page", "replay"]);
  const customViewInvalidationKey = useV3InvalidationKey(["custom_view", "replay"]);
  const itemsRef = useRef(items);
  const loadedRunbookIdRef = useRef<string | null>(null);
  itemsRef.current = items;
  const boardCatalog = useMemo<CatalogState>(() => ({
    folders: [],
    sessions: {},
    boardItems: items,
    sessionList: [],
  }), [items]);
  const boardSync = useBoardYjsRuntime({
    container: status === "ready" ? { kind: "runbook", id: runbookId } : null,
    resolvedFolderId: folderId ?? items[0]?.folderId ?? runbookId,
    catalog: boardCatalog,
    selectionItemId: null,
  });

  useEffect(() => {
    setExpandedId(null);
    setRenameState(null);
  }, [runbookId]);

  useEffect(() => {
    const controller = new AbortController();
    const sameRunbook = loadedRunbookIdRef.current === runbookId;
    const previous = sameRunbook ? itemsRef.current : null;
    if (!sameRunbook) {
      setItems([]);
      setStatus("loading");
    }
    const load = () => fetchTaskBoardItems(
      runbookId,
      globalThis.fetch.bind(globalThis),
      controller.signal,
    );
    void loadConfirmedResult({
      previous,
      load,
      clearsVisibleContent: (current, next) => current.length > 0 && next.length === 0,
    }).then((next) => {
      loadedRunbookIdRef.current = runbookId;
      setItems((current) => retainEqualValue(current, next));
      setStatus("ready");
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus("error");
    });
    return () => controller.abort();
  }, [itemInvalidationKey, runbookId]);

  useEffect(() => {
    if (!boardSync.hasSynced || !boardSync.boardItems) return;
    setItems((current) => retainEqualValue(current, mergeRuntimeItems(boardSync.boardItems ?? [], current)));
  }, [boardSync.boardItems, boardSync.hasSynced]);

  useEffect(() => {
    onMarkdownDocumentsChanged(boardMarkdownDocuments(items));
  }, [items, onMarkdownDocumentsChanged]);

  const createMarkdown = () => {
    if (!boardSync.runtime || !boardSync.hasSynced) return;
    const placement = findTaskMarkdownPlacement(items);
    const result = boardSync.runtime.createMarkdownDocument({
      title: "제목 없는 문서",
      body: "",
      ...placement,
    });
    setItems((current) => retainEqualValue(current, [...current, result.boardItem]));
    setRenameState({
      documentId: result.document.id,
      input: result.document.title,
      pending: false,
      error: "",
    });
  };

  const beginRename = (item: CatalogBoardItem) => {
    setRenameState({
      documentId: item.itemId,
      input: metadataText(item, "title") || "제목 없는 문서",
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
        error: "문서 정보를 새로 불러온 뒤 다시 시도하세요.",
      } : null);
      return;
    }
    const previousTitle = metadataText(item, "title") || "제목 없는 문서";
    const title = renameState.input.trim() || "제목 없는 문서";
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
      if (boardSync.runtime && !boardSync.runtime.isProviderBacked) {
        boardSync.runtime.updateMarkdownTitle(item.itemId, updated.title);
      }
      setItems((current) => patchBoardMarkdownTitle(current, item.itemId, updated.title, updated.version));
      setRenameState(null);
    } catch (error) {
      setItems((current) => patchBoardMarkdownTitle(current, item.itemId, previousTitle, version));
      setRenameState((current) => current ? {
        ...current,
        input: previousTitle,
        pending: false,
        error: error instanceof Error ? error.message : "문서 이름을 바꾸지 못했습니다.",
      } : null);
    }
  };

  return (
    <section className="v3-detail-section v3-inline-board" data-testid="v3-inline-board">
      <div className="v3-detail-section-head">
        <h3>▦ 보드</h3><span>{status === "ready" ? `${items.length}개` : ""}</span>
        <span className="v3-spacer" />
        <DashboardIconCap
          label="마크다운 추가"
          disabled={!boardSync.runtime || !boardSync.hasSynced}
          onClick={createMarkdown}
        >
          <FilePlus2 className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
      {status === "loading" ? <p className="v3-detail-empty">보드 항목을 불러오는 중…</p> : null}
      {status === "error" ? <p className="v3-inline-board-error" role="alert">보드 항목을 불러오지 못했습니다.</p> : null}
      {status === "ready" && items.length === 0 ? <p className="v3-detail-empty">보드에 표시할 문서가 없습니다.</p> : null}
      <div className="v3-inline-board-list">
        {items.map((item) => {
          const expanded = expandedId === item.id;
          if (item.itemType === "markdown") {
            const title = metadataText(item, "title") || "제목 없는 문서";
            const activeRename = renameState?.documentId === item.itemId ? renameState : null;
            return (
              <LiquidGlassCard key={item.id} webglSurface cornerRadius={14} className="v3-inline-board-item" data-board-kind="markdown">
                <div className="v3-inline-board-row">
                  {activeRename ? (
                    <form className="v3-inline-board-rename" onSubmit={(event) => { void commitRename(event); }}>
                      <span aria-hidden="true">📄</span>
                      <input
                        autoFocus
                        aria-label="마크다운 이름"
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
                      <button type="submit" disabled={activeRename.pending}>{activeRename.pending ? "저장 중…" : "저장"}</button>
                    </form>
                  ) : (
                    <div className="v3-inline-board-label"><span>📄 {title}</span></div>
                  )}
                  {!activeRename ? (
                    <>
                      <DashboardIconCap
                        label={`${title} ${expanded ? "접기" : "펼치기"}`}
                        className="v3-inline-board-expand"
                        aria-expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : item.id)}
                      >
                        <DisclosureActionIcon expanded={expanded} className="h-4 w-4" />
                      </DashboardIconCap>
                      <DashboardIconCap label={`${title} 이름 수정`} className="v3-inline-board-rename-button" onClick={() => beginRename(item)}>
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </DashboardIconCap>
                    </>
                  ) : null}
                </div>
                {activeRename?.error ? <p className="v3-inline-board-error" role="alert">{activeRename.error}</p> : null}
                {expanded ? <InlineMarkdown documentId={item.itemId} invalidationKey={pageInvalidationKey} /> : null}
              </LiquidGlassCard>
            );
          }
          if (item.itemType === "custom_view") {
            const title = metadataText(item, "title") || "Custom view";
            return (
              <LiquidGlassCard key={item.id} webglSurface cornerRadius={14} className="v3-inline-board-item" data-board-kind="custom_view">
                <div className="v3-inline-board-row">
                  <div className="v3-inline-board-label"><span>▦ {title}</span></div>
                  <DashboardIconCap
                    label={`${title} ${expanded ? "접기" : "펼치기"}`}
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
    </section>
  );
}

function InlineMarkdown({ documentId, invalidationKey }: { documentId: string; invalidationKey: number }) {
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
  if (error) return <p className="v3-inline-board-error">문서 본문을 불러오지 못했습니다.</p>;
  if (!document) return <p className="v3-detail-empty">본문을 불러오는 중…</p>;
  return (
    <div className="v3-inline-markdown" data-testid="v3-inline-markdown">
      <TaskDescriptionPanel
        markdown={document.body}
        ariaLabel={`${document.title} 문서`}
        emptyText="클릭해서 문서 본문을 작성하세요."
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
  if (error) return <p className="v3-inline-board-error">커스텀 뷰를 불러오지 못했습니다.</p>;
  if (!document) return <p className="v3-detail-empty">커스텀 뷰를 불러오는 중…</p>;
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
  const title = metadataText(item, "originalName") || metadataText(item, "title") || "첨부 파일";
  const href = metadataText(item, "signedUrl") || metadataText(item, "sourceUrl");
  return (
    <LiquidGlassCard webglSurface cornerRadius={14} className="v3-inline-board-item" data-board-kind="asset">
      {href ? <a href={href} target="_blank" rel="noreferrer"><span>↗ {title}</span><small>열기</small></a> : <div><span>📎 {title}</span></div>}
    </LiquidGlassCard>
  );
}

function mergeRuntimeItems(
  runtimeItems: readonly CatalogBoardItem[],
  currentItems: readonly CatalogBoardItem[],
): CatalogBoardItem[] {
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  return runtimeItems.filter((item) => INLINE_ITEM_TYPES.has(item.itemType)).map((item) => {
    if (item.itemType !== "asset") return item;
    const current = currentById.get(item.id);
    const signedUrl = current?.metadata?.signedUrl;
    return typeof signedUrl === "string"
      ? { ...item, metadata: { ...(item.metadata ?? {}), signedUrl } }
      : item;
  });
}
