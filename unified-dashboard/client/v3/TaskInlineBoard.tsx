import { useEffect, useState } from "react";
import {
  CustomViewIframe,
  MarkdownContent,
  useCustomViewBindings,
  type CatalogBoardItem,
  type CustomViewDocument,
  type MarkdownDocument,
} from "@seosoyoung/soul-ui";

import {
  fetchInlineCustomView,
  fetchInlineMarkdown,
  fetchTaskBoardItems,
} from "./task-inline-board-api";
import "./v3-context-menus.css";
import { useV3InvalidationKey } from "./v3-live-invalidation-plane";

export function TaskInlineBoard({ runbookId }: { runbookId: string }) {
  const [items, setItems] = useState<CatalogBoardItem[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const invalidationKey = useV3InvalidationKey([
    "catalog", "runbook", "custom_view", "page", "replay", "local",
  ]);

  useEffect(() => setExpandedId(null), [runbookId]);

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    void fetchTaskBoardItems(runbookId, (input, init) => globalThis.fetch(input, {
      ...init,
      signal: controller.signal,
    })).then((next) => {
      setItems(next);
      setStatus("ready");
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus("error");
    });
    return () => controller.abort();
  }, [invalidationKey, runbookId]);

  return (
    <section className="v3-detail-section v3-inline-board" data-testid="v3-inline-board">
      <div className="v3-detail-section-head">
        <h3>▦ 보드</h3><span>{status === "ready" ? `${items.length}개` : ""}</span>
      </div>
      {status === "loading" ? <p className="v3-detail-empty">보드 항목을 불러오는 중…</p> : null}
      {status === "error" ? <p className="v3-inline-board-error" role="alert">보드 항목을 불러오지 못했습니다.</p> : null}
      {status === "ready" && items.length === 0 ? <p className="v3-detail-empty">보드에 표시할 문서가 없습니다.</p> : null}
      <div className="v3-inline-board-list">
        {items.map((item) => {
          const expanded = expandedId === item.id;
          if (item.itemType === "markdown") {
            return (
              <article key={item.id} className="v3-inline-board-item" data-board-kind="markdown">
                <button type="button" onClick={() => setExpandedId(expanded ? null : item.id)}>
                  <span>📄 {metadataText(item, "title") || "제목 없는 문서"}</span><small>{expanded ? "접기" : "펼치기"}</small>
                </button>
                {expanded ? <InlineMarkdown documentId={item.itemId} invalidationKey={invalidationKey} /> : null}
              </article>
            );
          }
          if (item.itemType === "custom_view") {
            return (
              <article key={item.id} className="v3-inline-board-item" data-board-kind="custom_view">
                <button type="button" onClick={() => setExpandedId(expanded ? null : item.id)}>
                  <span>▦ {metadataText(item, "title") || "Custom view"}</span><small>{expanded ? "접기" : "펼치기"}</small>
                </button>
                {expanded ? <InlineCustomView customViewId={item.itemId} invalidationKey={invalidationKey} /> : null}
              </article>
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
    void fetchInlineMarkdown(documentId, (input, init) => globalThis.fetch(input, { ...init, signal: controller.signal }))
      .then(setDocument)
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(true);
      });
    return () => controller.abort();
  }, [documentId, invalidationKey]);
  if (error) return <p className="v3-inline-board-error">문서 본문을 불러오지 못했습니다.</p>;
  if (!document) return <p className="v3-detail-empty">본문을 불러오는 중…</p>;
  return <div className="v3-inline-markdown" data-testid="v3-inline-markdown"><MarkdownContent content={document.body || "빈 문서"} /></div>;
}

function InlineCustomView({ customViewId, invalidationKey }: { customViewId: string; invalidationKey: number }) {
  const bindings = useCustomViewBindings();
  const [document, setDocument] = useState<CustomViewDocument | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetchInlineCustomView(customViewId, (input, init) => globalThis.fetch(input, { ...init, signal: controller.signal }))
      .then(setDocument)
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
    <article className="v3-inline-board-item" data-board-kind="asset">
      {href ? <a href={href} target="_blank" rel="noreferrer"><span>↗ {title}</span><small>열기</small></a> : <div><span>📎 {title}</span></div>}
    </article>
  );
}

function metadataText(item: CatalogBoardItem, key: string): string {
  const value = item.metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}
