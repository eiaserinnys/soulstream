import { useEffect, useMemo, useState } from "react";
import { AtomNodeSelector, Button } from "@seosoyoung/soul-ui";
import {
  createPageApiClient,
  type BlockDto,
  type BrowserPageSearchItemDto,
} from "@seosoyoung/soul-ui/page";

import { BrowserPlannerMutationPort } from "./planner-browser-port";
import {
  estimateContextPayload,
  type ContextPickerSelection,
} from "./context-picker-model";
import { addTaskContextBlocks } from "./task-workspace-api";

type ContextTab = "page" | "atom";

const TABS: readonly { id: ContextTab; icon: string; label: string }[] = [
  { id: "page", icon: "📄", label: "페이지" },
  { id: "atom", icon: "🧠", label: "atom" },
];

export function TaskContextPicker({
  mode = "context",
  taskPageId,
  taskBlocks,
  onBlocksChanged,
  onClose,
}: {
  mode?: "context" | "document";
  taskPageId: string;
  taskBlocks: readonly BlockDto[];
  onBlocksChanged(blocks: BlockDto[]): void;
  onClose(): void;
}) {
  const documentMode = mode === "document";
  const api = useMemo(() => createPageApiClient(), []);
  const mutationPort = useMemo(() => new BrowserPlannerMutationPort(api), [api]);
  const [tab, setTab] = useState<ContextTab>("page");
  const [selected, setSelected] = useState<Map<string, ContextPickerSelection>>(() => new Map());
  const [pageQuery, setPageQuery] = useState("");
  const [pages, setPages] = useState<BrowserPageSearchItemDto[]>([]);
  const [atomNodeId, setAtomNodeId] = useState("");
  const [atomTitle, setAtomTitle] = useState("");
  const [newPageTitle, setNewPageTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const query = pageQuery.trim();
    const request = query
      ? api.searchPages(query, 8)
      : api.listPages({ limit: 8 }).then((result) => ({
          items: result.items.map((page) => ({ pageId: page.id, title: page.title })),
        }));
    void request.then((result) => {
      if (active) setPages(result.items.filter((page) => page.pageId !== taskPageId));
    }).catch((caught: unknown) => {
      if (active) setError(errorText(caught));
    });
    return () => { active = false; };
  }, [api, pageQuery, taskPageId]);

  const existing = useMemo(() => existingContextKeys(taskBlocks), [taskBlocks]);
  const selectedValues = [...selected.values()];
  const estimateValues = [
    ...taskBlocks.filter(isSpecialContextBlock).map(blockEstimateValue),
    ...selectedValues.map(selectionEstimateValue),
  ];
  const estimate = estimateContextPayload(estimateValues);

  const toggle = (selection: ContextPickerSelection) => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(selection.key)) {
        next.delete(selection.key);
      } else {
        next.set(selection.key, selection);
      }
      return next;
    });
  };

  const apply = async () => {
    const choices = selectedValues.filter((selection) => (
      !existing.has(selection.key) && (!documentMode || selection.kind === "page")
    ));
    setPending(true);
    setError(null);
    try {
      const result = await addTaskContextBlocks(api, taskPageId, choices);
      onBlocksChanged(result.blocks);
      onClose();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  };

  const createPage = async () => {
    const title = newPageTitle.trim();
    if (!title) return;
    setPending(true);
    setError(null);
    try {
      await mutationPort.createDocument({ title, sourcePageId: taskPageId });
      const refreshed = await api.getPage(taskPageId);
      onBlocksChanged(refreshed.blocks);
      onClose();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  };

  const selectAtomNode = (nodeId: string, title: string) => {
    setAtomNodeId(nodeId);
    setAtomTitle(title);
    const normalized = nodeId.trim();
    if (!normalized || existing.has(`atom:${normalized}`)) return;
    const selection = {
      key: `atom:${normalized}`,
      kind: "atom" as const,
      nodeId: normalized,
      label: title.trim() || normalized,
    };
    setSelected((current) => new Map(current).set(selection.key, selection));
  };

  return (
    <div className={`v3-context-picker${documentMode ? " v3-context-picker--document" : ""}`}>
      {!documentMode ? <div className="v3-context-tabs" role="tablist" aria-label="컨텍스트 종류">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}>
            <span className="v3-emoji" aria-hidden="true">{item.icon}</span> {item.label}
          </button>
        ))}
      </div> : null}

      <div className="v3-context-panel" role="tabpanel">
        {tab === "page" ? (
          <>
            <input type="search" value={pageQuery} onChange={(event) => setPageQuery(event.target.value)} placeholder="최근 페이지 검색…" aria-label="페이지 검색" />
            <div className="v3-context-options">
              {pages.map((page) => {
                const selection = { key: `page:${page.pageId}`, kind: "page", pageId: page.pageId, title: page.title } as const;
                const mounted = existing.has(`page:${page.title}`);
                return <ContextOption key={selection.key} icon="📄" title={page.title} meta={mounted ? "이미 첨부됨" : "페이지"} selected={selected.has(selection.key)} disabled={mounted} onClick={() => toggle(selection)} />;
              })}
            </div>
            <div className="v3-context-create-page">
              <input value={newPageTitle} onChange={(event) => setNewPageTitle(event.target.value)} placeholder="새 페이지 제목…" aria-label="첨부할 새 페이지 제목" />
              <Button variant="secondary" size="sm" disabled={pending || !newPageTitle.trim()} onClick={() => { void createPage(); }}>＋ 새 페이지 만들며 첨부</Button>
            </div>
          </>
        ) : null}
        {tab === "atom" ? (
          <>
            <AtomNodeSelector
              value={atomNodeId}
              selectedTitle={atomTitle}
              disabled={pending}
              onChange={selectAtomNode}
            />
            <div className="v3-context-options">
              {selectedValues.filter((selection) => selection.kind === "atom").map((selection) => (
                <ContextOption key={selection.key} icon="🧠" title={selection.label} meta={selection.nodeId} selected onClick={() => toggle(selection)} />
              ))}
              {atomNodeId && existing.has(`atom:${atomNodeId}`) ? <p>이미 연결된 atom 노드입니다.</p> : null}
            </div>
          </>
        ) : null}
      </div>

      {error ? <div className="v3-context-error" role="alert">{error}</div> : null}
      <footer className="v3-context-footer">
        <span>{documentMode ? `선택한 문서 ${selectedValues.filter((selection) => selection.kind === "page").length}개` : `업무 컨텍스트 ${estimate.count}건 · ${estimate.label}`}</span>
        <Button disabled={pending} onClick={() => { void apply(); }}>{pending ? "추가 중…" : documentMode ? "선택 문서 마운트" : "선택 추가"}</Button>
      </footer>
    </div>
  );
}

function ContextOption({ icon, title, meta, selected, disabled = false, onClick }: {
  icon: string;
  title: string;
  meta: string;
  selected: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" className={`v3-context-option${selected ? " is-selected" : ""}`} disabled={disabled} aria-pressed={selected} onClick={onClick}>
      <span className="v3-emoji" aria-hidden="true">{icon}</span><span><strong>{title}</strong><small>{meta}</small></span><i aria-hidden="true" />
    </button>
  );
}

function existingContextKeys(blocks: readonly BlockDto[]): Set<string> {
  const keys = new Set<string>();
  for (const block of blocks) {
    const mount = /^\[\[([^\[\]]+)\]\]$/.exec(block.text.trim());
    if (mount) keys.add(`page:${mount[1]}`);
    if (block.block_type === "atom_ref" && typeof block.properties.nodeId === "string") keys.add(`atom:${block.properties.nodeId}`);
  }
  return keys;
}

function isSpecialContextBlock(block: BlockDto): boolean {
  return block.block_type === "atom_ref"
    || block.block_type === "guidance"
    || /^\[\[[^\[\]]+\]\]$/.test(block.text.trim());
}

function blockEstimateValue(block: BlockDto): string {
  return `${block.block_type}\n${block.text}\n${JSON.stringify(block.properties)}`;
}

function selectionEstimateValue(selection: ContextPickerSelection): string {
  if (selection.kind === "page") return selection.title;
  return `${selection.nodeId}\n${selection.label}`;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
