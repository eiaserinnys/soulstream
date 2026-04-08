/**
 * AtomNodeSelector - atom 트리 노드를 드롭다운으로 탐색하여 선택하는 컴포넌트
 *
 * /api/catalog/atom/nodes (루트) 및 /api/catalog/atom/nodes/{id}/children 엔드포인트를 통해
 * atom 트리를 계층형으로 탐색하고 원하는 노드를 선택한다.
 */

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

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
  /** 선택된 tree node id ("" = 미선택) */
  value: string;
  /** 선택된 노드의 표시 제목 (없으면 nodeId 축약 표시) */
  selectedTitle?: string;
  /** nodeId, title 두 값을 함께 전달 */
  onChange: (nodeId: string, title: string) => void;
  disabled?: boolean;
}

export function AtomNodeSelector({
  value,
  selectedTitle,
  onChange,
  disabled = false,
}: AtomNodeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [nodes, setNodes] = useState<AtomNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([
    { nodeId: null, title: "루트" },
  ]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({
    visibility: "hidden",
  });

  const loadNodes = async (nodeId: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const url =
        nodeId === null
          ? "/api/catalog/atom/nodes"
          : `/api/catalog/atom/nodes/${nodeId}/children`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { children: AtomNode[] };
      setNodes(data.children ?? []);
    } catch {
      setError("노드를 불러오지 못했습니다");
      setNodes([]);
    } finally {
      setLoading(false);
    }
  };

  // 열릴 때 브레드크럼 초기화 및 루트 노드 로드
  useEffect(() => {
    if (open) {
      setBreadcrumbs([{ nodeId: null, title: "루트" }]);
      loadNodes(null);
    }
  }, [open]);

  // 열릴 때 포지션 계산 (scroll/resize 이벤트도 구독)
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const updatePos = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const openUpward = spaceBelow < 200 && spaceAbove > spaceBelow;
      setPanelStyle(
        openUpward
          ? {
              position: "fixed",
              bottom: window.innerHeight - rect.top + 4,
              left: rect.left,
              width: Math.max(rect.width, 256),
            }
          : {
              position: "fixed",
              top: rect.bottom + 4,
              left: rect.left,
              width: Math.max(rect.width, 256),
            }
      );
    };
    updatePos();
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    return () => {
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
    };
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
  };

  const clearSelection = () => {
    onChange("", "");
    setOpen(false);
  };

  // 패널/트리거 바깥 클릭 시 닫기
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        !panelRef.current?.contains(t) &&
        !triggerRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const displayLabel = value
    ? selectedTitle || value.slice(0, 8) + "…"
    : "노드 선택...";

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="w-full rounded-lg border border-input bg-background dark:bg-input/32 px-3 py-1.5 text-sm text-left flex items-center justify-between gap-2 disabled:opacity-50 disabled:pointer-events-none"
      >
        <span className={value ? "" : "text-muted-foreground"}>
          {displayLabel}
        </span>
        <span className="text-muted-foreground text-xs flex-shrink-0">▼</span>
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={panelStyle}
            className="z-[200] min-w-64 rounded-lg border bg-popover not-dark:bg-clip-padding shadow-lg/5"
          >
            {/* 브레드크럼 + 뒤로가기 버튼 */}
            <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border text-xs">
              {breadcrumbs.length > 1 && (
                <button
                  type="button"
                  onClick={() => navigateToBreadcrumb(breadcrumbs.length - 2)}
                  className="flex-shrink-0 text-muted-foreground hover:text-foreground px-1"
                  title="뒤로 가기"
                >
                  ←
                </button>
              )}
              <div className="flex flex-wrap items-center gap-0.5 min-w-0">
                {breadcrumbs.map((crumb, i) => (
                  <span key={i} className="flex items-center gap-0.5">
                    {i > 0 && (
                      <span className="text-muted-foreground mx-0.5">/</span>
                    )}
                    <button
                      type="button"
                      onClick={() => navigateToBreadcrumb(i)}
                      className={
                        i === breadcrumbs.length - 1
                          ? "font-medium"
                          : "text-muted-foreground hover:text-foreground hover:underline"
                      }
                    >
                      {crumb.title}
                    </button>
                  </span>
                ))}
              </div>
            </div>

            {/* 노드 목록 */}
            <div className="max-h-48 overflow-y-auto">
              {loading && (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  불러오는 중...
                </div>
              )}
              {error && (
                <div className="px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}
              {!loading && !error && nodes.length === 0 && (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  하위 노드 없음
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
                      className="flex-1 text-left text-sm px-3 py-1.5 truncate"
                    >
                      {node.card.title}
                    </button>
                    <button
                      type="button"
                      onClick={() => navigateInto(node)}
                      className="flex-shrink-0 text-xs text-muted-foreground hover:text-foreground px-2 py-1.5"
                      title="자식 보기"
                    >
                      ▶
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
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  선택 해제
                </button>
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
