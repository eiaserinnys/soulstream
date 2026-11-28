/**
 * AtomNodeSelector - atom 트리 노드를 드롭다운으로 탐색하여 선택하는 컴포넌트
 *
 * /api/atom/nodes (루트) 및 /api/atom/nodes/{id}/children 엔드포인트를 통해
 * atom 트리를 계층형으로 탐색하고 원하는 노드를 선택한다.
 *
 * 포지셔닝/포털/바깥 클릭/포커스 복원은 Base UI Popover 래퍼(`./ui/popover`)에 위임한다.
 */

import { useTranslation } from "react-i18next";
import { useState, useEffect, useRef } from "react";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";

import { FrameLoading } from "./FrameLoading";
import { Button } from "./ui/button";
import { Popover, PopoverTrigger, PopoverPopup } from "./ui/popover";

interface AtomNode {
  id: string;
  card_id: string;
  card: {
    title: string;
    card_type: "structure" | "knowledge";
  };
}

interface BreadcrumbEntry {
  nodeId: string | null; // null = 루트
  title: string;
}

export interface AtomNodeSelectorProps {
  request?: typeof fetch;
  /** 선택된 tree node id ("" = 미선택) */
  value: string;
  /** 선택된 노드의 표시 제목 (없으면 nodeId 축약 표시) */
  selectedTitle?: string;
  /** nodeId, title 두 값을 함께 전달 */
  onChange: (nodeId: string, title: string) => void;
  disabled?: boolean;
  presentation?: "popup" | "inline";
  open?: boolean;
  onOpenChange?(open: boolean): void;
  onStatusChange?(status: "loading" | "ready" | "error"): void;
}

export function AtomNodeSelector({
  request = fetch,
  value,
  selectedTitle,
  onChange,
  disabled = false,
  presentation = "popup",
  open: controlledOpen, onOpenChange, onStatusChange,
}: AtomNodeSelectorProps) {
  const { t } = useTranslation();
  const [localOpen, setLocalOpen] = useState(false);
  const inlineTriggerRef = useRef<HTMLButtonElement>(null);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => { setLocalOpen(next); onOpenChange?.(next); };
  const [nodes, setNodes] = useState<AtomNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([
    { nodeId: null, title: "" },
  ]);
  // 다시 시도 결과에 따라 초점을 옮길 곳. 목록이 그려진 뒤 효과에서 처리한다.
  const [pendingFocus, setPendingFocus] = useState<"first-node" | "retry" | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);

  const loadNodes = async (nodeId: string | null): Promise<boolean> => {
    setLoading(true);
    onStatusChange?.("loading");
    setError(false);
    try {
      const url =
        nodeId === null
          ? "/api/atom/nodes"
          : `/api/atom/nodes/${nodeId}/children`;
      const res = await request(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { children: AtomNode[] };
      setNodes(data.children ?? []);
      onStatusChange?.("ready");
      return true;
    } catch {
      setError(true);
      onStatusChange?.("error");
      setNodes([]);
      return false;
    } finally {
      setLoading(false);
    }
  };

  // 실패한 단계(지금 빵부스러기의 마지막 노드)를 다시 불러온다.
  const retryLoad = async () => {
    const ok = await loadNodes(breadcrumbs[breadcrumbs.length - 1].nodeId);
    setPendingFocus(ok ? "first-node" : "retry");
  };

  useEffect(() => {
    if (!pendingFocus) return;
    const target = pendingFocus === "first-node"
      ? listRef.current?.querySelector<HTMLButtonElement>("button")
      : retryButtonRef.current;
    target?.focus();
    // 감싼 Popover의 포커스 관리자는 초점이 잠깐 body로 떨어진 사이 팝업으로
    // 되돌아갈 수 있다. 한 프레임 뒤 한 번 더 잡아 그 되돌림을 이긴다.
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (target?.isConnected && document.activeElement !== target) target.focus();
      });
    }
    setPendingFocus(null);
  }, [pendingFocus]);

  // 열릴 때 브레드크럼 초기화 및 루트 노드 로드
  useEffect(() => {
    if (open) {
      setBreadcrumbs([{ nodeId: null, title: "" }]);
      loadNodes(null);
    }
  }, [open]);

  const navigateInto = (node: AtomNode) => {
    setBreadcrumbs((prev) => [
      ...prev,
      { nodeId: node.id, title: node.card.title },
    ]);
    loadNodes(node.id);
  };

  const navigateToBreadcrumb = (index: number) => {
    const next = breadcrumbs.slice(0, index + 1);
    setBreadcrumbs(next);
    loadNodes(next[next.length - 1].nodeId);
  };

  const selectNode = (node: AtomNode) => {
    onChange(node.id, node.card.title);
    setOpen(false);
    inlineTriggerRef.current?.focus();
  };

  const clearSelection = () => {
    onChange("", "");
    setOpen(false);
    inlineTriggerRef.current?.focus();
  };

  const displayLabel = value
    ? selectedTitle || value.slice(0, 8) + "…"
    : t("ui.node.select");

  // 판 안의 맨 <button>도 soul-ui Button과 같은 초점 고리를 쓴다. popup 목록은
  // overflow-y-auto라 바깥 고리가 잘리고, inline은 행이 판 테두리에 붙어 있어
  // inset으로 그린다.
  const panelButtonFocus = "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

  const triggerClass = "w-full rounded-floor border border-input bg-background dark:bg-input/32 px-3 py-1.5 text-sm text-left flex items-center justify-between gap-2 disabled:opacity-50 disabled:pointer-events-none";
  const triggerContent = <>
    <span className={`${value ? "" : "text-muted-foreground"} ${presentation === "inline" ? "min-w-0 truncate" : ""}`}>{displayLabel}</span>
    <ChevronDown className="size-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
  </>;
  const panel = <>
        {/* 브레드크럼 + 뒤로가기 버튼 */}
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border text-sm">
          {breadcrumbs.length > 1 && (
            <button
              type="button"
              onClick={() => navigateToBreadcrumb(breadcrumbs.length - 2)}
              className={`flex-shrink-0 rounded-full p-1 text-muted-foreground hover:text-foreground ${panelButtonFocus}`}
              title={t("ui.node.back")}
              aria-label={t("ui.node.back")}
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
            </button>
          )}
          <div className={`flex items-center gap-0.5 min-w-0 ${presentation === "inline" ? "overflow-hidden" : "flex-wrap"}`}>
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className={`flex items-center gap-0.5 ${presentation === "inline" ? "min-w-0" : ""}`}>
                {i > 0 && (
                  <span className="text-muted-foreground mx-0.5">/</span>
                )}
                <button
                  type="button"
                  onClick={() => navigateToBreadcrumb(i)}
                  className={`${panelButtonFocus} ${presentation === "inline" ? "truncate" : ""} ${i === breadcrumbs.length - 1 ? "font-medium" : "text-muted-foreground hover:text-foreground hover:underline"}`}
                >
                  {crumb.nodeId === null ? t("ui.node.root") : crumb.title}
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* 노드 목록 */}
        <div ref={listRef} className={presentation === "popup" ? "max-h-48 overflow-y-auto" : undefined}>
          {loading && <FrameLoading inline label={t("ui.common.loading")} />}
          {error && (
            <div className="px-3 py-2 text-sm text-destructive" data-slot="dialog-error-message">
              <div>{t("ui.node.loadFailed")}</div>
              <Button ref={retryButtonRef} variant="outline" size="sm" className="mt-1.5"
                onClick={() => { void retryLoad(); }}>
                {t("ui.common.retry")}
              </Button>
            </div>
          )}
          {!loading && !error && nodes.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {t("ui.node.noChildren")}
            </div>
          )}
          {!loading &&
            nodes.map((node) => (
              <div
                key={node.id}
                className={`flex items-center hover:bg-accent/50 ${
                  node.id === value ? "bg-accent/30" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => selectNode(node)}
                  className={`flex-1 text-left text-sm px-3 py-1.5 truncate ${presentation === "inline" ? "min-w-0" : ""} ${panelButtonFocus}`}
                >
                  {node.card.title}
                </button>
                <button
                  type="button"
                  onClick={() => navigateInto(node)}
                  className={`flex-shrink-0 text-muted-foreground hover:text-foreground px-2 py-1.5 ${panelButtonFocus}`}
                  title={t("ui.node.viewChildren")}
                  aria-label={t("ui.node.viewChildren")}
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </button>
              </div>
            ))}
        </div>

        {/* 선택 해제 */}
        {value && (
          <div className="border-t border-border px-2 py-1.5">
            <button
              type="button"
              onClick={clearSelection}
              className={`text-sm text-muted-foreground hover:text-foreground ${panelButtonFocus}`}
            >
              {t("ui.node.clearSelection")}
            </button>
          </div>
        )}
  </>;

  if (presentation === "inline") {
    return <div className="min-w-0 w-full">
      <button ref={inlineTriggerRef} type="button" data-slot="atom-node-selector-trigger" className={triggerClass} disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>{triggerContent}</button>
      {open && <div data-slot="atom-node-selector-panel" className="w-full min-w-0 rounded-floor border border-input bg-background dark:bg-input/32">{panel}</div>}
    </div>;
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger type="button" disabled={disabled} className={triggerClass}>{triggerContent}</PopoverTrigger>
      <PopoverPopup align="start" side="bottom" sideOffset={4}
        className="min-w-64 [--viewport-inline-padding:0] [&_[data-slot=popover-viewport]]:py-0">
        {panel}
      </PopoverPopup>
    </Popover>
  );
}
