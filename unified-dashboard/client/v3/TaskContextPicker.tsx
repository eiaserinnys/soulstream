import { useEffect, useMemo, useState } from "react";
import type { SessionSummary } from "@seosoyoung/soul-ui";
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
import {
  addTaskContextBlocks,
  type PageSessionDefaults,
} from "./task-workspace-api";

type ContextTab = "page" | "atom" | "session" | "guidance";

const TABS: readonly { id: ContextTab; label: string }[] = [
  { id: "page", label: "📄 페이지" },
  { id: "atom", label: "🧠 atom" },
  { id: "session", label: "💬 이전 세션" },
  { id: "guidance", label: "📝 guidance" },
];

export function TaskContextPicker({
  taskPageId,
  taskBlocks,
  projectPageId,
  sessionIds,
  sessions,
  sessionDefaults,
  predecessorSessionId,
  onBlocksChanged,
  onPredecessorChanged,
  onClose,
}: {
  taskPageId: string;
  taskBlocks: readonly BlockDto[];
  projectPageId: string | null;
  sessionIds: readonly string[];
  sessions: readonly SessionSummary[];
  sessionDefaults: PageSessionDefaults | null;
  predecessorSessionId: string | null;
  onBlocksChanged(blocks: BlockDto[]): void;
  onPredecessorChanged(sessionId: string | null): void;
  onClose(): void;
}) {
  const api = useMemo(() => createPageApiClient(), []);
  const mutationPort = useMemo(() => new BrowserPlannerMutationPort(api), [api]);
  const [tab, setTab] = useState<ContextTab>("page");
  const [selected, setSelected] = useState<Map<string, ContextPickerSelection>>(() => new Map());
  const [pageQuery, setPageQuery] = useState("");
  const [pages, setPages] = useState<BrowserPageSearchItemDto[]>([]);
  const [inheritedBlocks, setInheritedBlocks] = useState<BlockDto[]>([]);
  const [atomNodeId, setAtomNodeId] = useState("");
  const [atomLabel, setAtomLabel] = useState("");
  const [guidance, setGuidance] = useState("");
  const [newPageTitle, setNewPageTitle] = useState("");
  const [draftPredecessorSessionId, setDraftPredecessorSessionId] = useState(predecessorSessionId);
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

  useEffect(() => {
    if (!projectPageId) { setInheritedBlocks([]); return; }
    let active = true;
    void api.getPage(projectPageId).then((result) => {
      if (active) setInheritedBlocks(result.blocks.filter(isInheritedContextBlock));
    }).catch((caught: unknown) => {
      if (active) setError(`상속 컨텍스트 조회 실패 · ${errorText(caught)}`);
    });
    return () => { active = false; };
  }, [api, projectPageId]);

  const runIds = useMemo(() => new Set(sessionIds), [sessionIds]);
  const completedSessions = useMemo(() => sessions
    .filter((session) => runIds.has(session.agentSessionId) && session.status === "completed")
    .sort((left, right) => sessionTime(right) - sessionTime(left)), [runIds, sessions]);
  const existing = useMemo(() => existingContextKeys(taskBlocks), [taskBlocks]);
  const selectedValues = [...selected.values()];
  const draftPredecessor = completedSessions.find(
    (session) => session.agentSessionId === draftPredecessorSessionId,
  ) ?? null;
  const guidanceSelection = guidance.trim() && !existing.has(`guidance:${guidance.trim()}`)
    ? ({ key: `guidance:${guidance.trim()}`, kind: "guidance", text: guidance.trim() } as const)
    : null;
  const estimateValues = [
    ...inheritedBlocks.map(blockEstimateValue),
    ...taskBlocks.filter(isSpecialContextBlock).map(blockEstimateValue),
    ...selectedValues.map(selectionEstimateValue),
    ...(draftPredecessor ? [sessionEstimateValue(draftPredecessor)] : []),
    ...(guidanceSelection && !selected.has(guidanceSelection.key) ? [guidanceSelection.text] : []),
    ...(sessionDefaults?.agentId || sessionDefaults?.nodeId
      ? [`${sessionDefaults.agentId ?? ""}@${sessionDefaults.nodeId ?? ""}`]
      : []),
  ];
  const estimate = estimateContextPayload(estimateValues);

  const toggle = (selection: ContextPickerSelection) => {
    if (selection.kind === "session") {
      setDraftPredecessorSessionId((current) => current === selection.sessionId ? null : selection.sessionId);
      return;
    }
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
    const choices = selectedValues.filter((selection) => !existing.has(selection.key));
    if (guidanceSelection && !choices.some((selection) => selection.key === guidanceSelection.key)) {
      choices.push(guidanceSelection);
    }
    setPending(true);
    setError(null);
    try {
      const result = await addTaskContextBlocks(api, taskPageId, choices);
      onBlocksChanged(result.blocks);
      onPredecessorChanged(draftPredecessorSessionId);
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

  const atomSelection = atomNodeId.trim()
    ? ({
        key: `atom:${atomNodeId.trim()}`,
        kind: "atom",
        nodeId: atomNodeId.trim(),
        label: atomLabel.trim() || atomNodeId.trim(),
      } as const)
    : null;

  return (
    <div className="v3-context-picker">
      <section className="v3-context-inherited">
        <strong>상속됨(프로젝트에서)</strong>
        <div>
          {inheritedBlocks.map((block) => <span key={block.id}>{contextBlockLabel(block)}</span>)}
          {sessionDefaults?.agentId || sessionDefaults?.nodeId ? (
            <span>◉ 기본 에이전트 · {sessionDefaults.agentId ?? "미지정"}@{sessionDefaults.nodeId ?? "미지정"}</span>
          ) : null}
          {inheritedBlocks.length === 0 && !sessionDefaults ? <small>상속된 컨텍스트가 없습니다.</small> : null}
        </div>
      </section>

      <div className="v3-context-tabs" role="tablist" aria-label="컨텍스트 종류">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}>
            {item.label}{item.id === "session" ? <small>요약</small> : null}
          </button>
        ))}
      </div>

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
              <button type="button" disabled={pending || !newPageTitle.trim()} onClick={() => { void createPage(); }}>＋ 새 페이지 만들며 첨부</button>
            </div>
          </>
        ) : null}
        {tab === "atom" ? (
          <>
            <input value={atomNodeId} onChange={(event) => setAtomNodeId(event.target.value)} placeholder="atom nodeId 입력…" aria-label="atom nodeId" />
            <input value={atomLabel} onChange={(event) => setAtomLabel(event.target.value)} placeholder="표시 이름(선택)…" aria-label="atom 표시 이름" />
            {atomSelection ? <ContextOption icon="🧠" title={atomSelection.label} meta={atomSelection.nodeId} selected={selected.has(atomSelection.key)} disabled={existing.has(atomSelection.key)} onClick={() => toggle(atomSelection)} /> : null}
          </>
        ) : null}
        {tab === "session" ? (
          <div className="v3-context-options">
            {completedSessions.map((session) => {
              const label = session.displayName ?? session.agentName ?? session.agentSessionId.slice(0, 12);
              const selection = { key: `session:${session.agentSessionId}`, kind: "session", sessionId: session.agentSessionId, label, summary: session.awaySummary } as const;
              return <ContextOption key={selection.key} icon="💬" title={label} meta="마지막 run 요약 첨부" selected={draftPredecessorSessionId === session.agentSessionId} onClick={() => toggle(selection)} />;
            })}
            {completedSessions.length === 0 ? <p>완료된 이전 세션이 없습니다.</p> : null}
          </div>
        ) : null}
        {tab === "guidance" ? (
          <input value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder="이 세션에 적용할 guidance 한 줄…" aria-label="guidance 입력" />
        ) : null}
      </div>

      {error ? <div className="v3-context-error" role="alert">{error}</div> : null}
      <footer className="v3-context-footer">
        <span>이 세션이 받는 것: {estimate.count}건 · {estimate.label}</span>
        <button type="button" className="v3-button v3-button--soft" disabled={pending} onClick={() => { void apply(); }}>{pending ? "추가 중…" : "선택 추가"}</button>
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
      <span>{icon}</span><span><strong>{title}</strong><small>{meta}</small></span><i aria-hidden="true" />
    </button>
  );
}

function existingContextKeys(blocks: readonly BlockDto[]): Set<string> {
  const keys = new Set<string>();
  for (const block of blocks) {
    const mount = /^\[\[([^\[\]]+)\]\]$/.exec(block.text.trim());
    if (mount) keys.add(`page:${mount[1]}`);
    if (block.block_type === "atom_ref" && typeof block.properties.nodeId === "string") keys.add(`atom:${block.properties.nodeId}`);
    if (block.block_type === "guidance" && block.text.trim()) keys.add(`guidance:${block.text.trim()}`);
  }
  return keys;
}

function isSpecialContextBlock(block: BlockDto): boolean {
  return block.block_type === "atom_ref"
    || block.block_type === "guidance"
    || /^\[\[[^\[\]]+\]\]$/.test(block.text.trim());
}

function isInheritedContextBlock(block: BlockDto): boolean {
  return block.block_type === "atom_ref" || block.block_type === "guidance";
}

function contextBlockLabel(block: BlockDto): string {
  if (block.block_type === "atom_ref") return `🧠 atom · ${stringProperty(block, "title") ?? stringProperty(block, "nodeId") ?? "컨텍스트"}`;
  if (block.block_type === "guidance") return `📝 guidance · ${block.text.trim() || "실행 지침"}`;
  return `📄 ${block.text.trim()}`;
}

function blockEstimateValue(block: BlockDto): string {
  return `${block.block_type}\n${block.text}\n${JSON.stringify(block.properties)}`;
}

function selectionEstimateValue(selection: ContextPickerSelection): string {
  if (selection.kind === "page") return selection.title;
  if (selection.kind === "atom") return `${selection.nodeId}\n${selection.label}`;
  if (selection.kind === "guidance") return selection.text;
  return `${selection.label}\n${selection.summary ?? ""}`;
}

function sessionEstimateValue(session: SessionSummary): string {
  return `${session.displayName ?? session.agentName ?? session.agentSessionId}\n${session.awaySummary ?? ""}`;
}

function stringProperty(block: BlockDto, key: string): string | null {
  const value = block.properties[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sessionTime(session: SessionSummary): number {
  const parsed = Date.parse(session.completedAt ?? session.updatedAt ?? session.createdAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
