// 고른 조건으로 노드 미리보기를 불러, 주입 순서대로 소스 목록을 보인다. 소스를 펼치면 실린 문서가 나오고,
// 상시 목록의 스킬은 아래에 따로 모아 연결과 진단을 함께 보인다. 본문은 같은 자리에서 연다.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronRight, Copy, ExternalLink, FileText, RotateCw } from "lucide-react";
import { Badge, Button, ContextContentRenderer, DashboardIconCap, FrameLoading, FrameNotice, useAtomPublicUrl } from "@seosoyoung/soul-ui";

import { conditionSummary, inputClassName, type AgentAtomContext } from "./AgentAtomContextFields";
import { formatChars, loadedHow, reportTime as formatReport, skillsByEntryCard as indexSkills, useSkillGuides, type LoadedHow, type SkillGuide } from "../lib/skill-guides";
import { LinkChips, SkillLintBadge, howLabel } from "./guides/GuideParts";
import "../v3/v3-run-history.css";

export type AssemblyTarget =
  | { kind: "central"; agentId: string; specs: Array<{ context: AgentAtomContext; source: string }> }
  | { kind: "node"; agentId: string };

interface ManifestSource {
  node_id: string;
  mode?: string;
  depth?: number;
  applies_when?: Record<string, unknown>;
  status: "ok" | "empty" | "error" | "filtered";
  chars: number;
  token_estimate: number;
}

/** 소스에 실린 문서 하나. depth는 소스 뿌리에서의 깊이다. */
export interface PreviewDocument { node_id: string; card_id: string; title: string; depth: number; chars: number }

interface PreviewSection { spec_index: number; title: string | null; parent_title?: string | null; markdown: string | null; documents?: PreviewDocument[] }

interface PreviewResponse {
  manifest: { sources: ManifestSource[]; total_chars?: number; total_token_estimate?: number };
  assembled: string | null;
  sections: PreviewSection[];
  atom_base_url: string | null;
}

type RowStatus = ManifestSource["status"] | "duplicate";

interface Row {
  key: string;
  nodeId: string;
  context: AgentAtomContext;
  origin: string | null;
  title: string | null;
  parentTitle: string | null;
  /** 서버가 실린 문서를 주지 않은 옛 응답이면 null. 줄을 펼치지 않고 본문으로 바로 들어간다. */
  documents: PreviewDocument[] | null;
  status: RowStatus | null;
  tokens: number | null;
  chars: number | null;
  markdown: string | null;
}

type View =
  | { kind: "list" }
  | { kind: "all" }
  | { kind: "source"; key: string }
  | { kind: "skill"; key: string; nodeId: string; name: string };

const CALLER_SOURCES = ["browser", "agent", "api", "channel_observer", "execute-proxy", "llm", "slack", "soul-app", "system", "trello_watcher"];
const CARD_ROLES: ReadonlyArray<readonly [string, string]> = [["", "카드 없음"], ["assignee", "담당"], ["member", "소속"]];

export interface AgentContextAssemblyViewProps {
  target: AssemblyTarget;
  nodeId: string;
  /** 노드 에이전트 목록의 백엔드. 목록에 없는 프로필은 claude. */
  initialBackend: string;
  /** 고른 노드의 에이전트 목록에 이 프로필이 있는가. */
  presentOnNode: boolean;
  request?: typeof fetch;
}

export function AgentContextAssemblyView({ target, nodeId, initialBackend, presentOnNode, request = fetch }: AgentContextAssemblyViewProps) {
  const [callerSource, setCallerSource] = useState("browser");
  const [backend, setBackend] = useState(initialBackend);
  const [cardRole, setCardRole] = useState("");
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; data: PreviewResponse } | { status: "error"; message: string }>({ status: "loading" });
  const [view, setView] = useState<View>({ kind: "list" });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const guides = useSkillGuides(request);
  const lastData = useRef<PreviewResponse | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<string | null>(null);

  useEffect(() => setBackend(initialBackend), [initialBackend, target.agentId]);
  useEffect(() => setView({ kind: "list" }), [target.agentId, target.kind]);

  const specs = target.kind === "central" ? target.specs : null;
  const body = useMemo(() => JSON.stringify(target.kind === "central"
    ? { atom_contexts: target.specs.map(({ context }) => context), session: { source: callerSource, backend, ...(cardRole ? { card_role: cardRole } : {}), agent: target.agentId } }
    : { agent_id: target.agentId, session: { source: callerSource, backend, ...(cardRole ? { card_role: cardRole } : {}), agent: target.agentId } }),
  // 중앙 프로필의 편집 중인 값은 「다시 조립」으로만 반영한다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [target.kind, target.agentId, nodeId, callerSource, backend, cardRole, attempt]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const response = await request(`/api/nodes/${encodeURIComponent(nodeId)}/agents/context-preview`, {
          method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body, signal: controller.signal,
        });
        const json = await response.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(typeof json.detail === "string" ? json.detail : "조립하지 못했습니다.");
        // 미리보기가 아닌 응답(소스 목록이 없는 꼴)은 화면을 깨뜨리지 않고 실패로 다룬다.
        if (!json.manifest || !Array.isArray(json.sections)) throw new Error("조립하지 못했습니다.");
        lastData.current = json as PreviewResponse;
        setState({ status: "ready", data: json as PreviewResponse });
      } catch (caught) {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: caught instanceof Error ? caught.message : "조립하지 못했습니다." });
      }
    })();
    return () => controller.abort();
  }, [body, nodeId, request, attempt]);

  const data = state.status === "ready" ? state.data : null;
  const displayedData = data ?? lastData.current;
  // 브라우저가 열 수 있는 주소(오케스트레이터)를 먼저 쓰고, 없으면 워커가 준 주소를 쓴다.
  const publicAtomUrl = useAtomPublicUrl();
  const atomBaseUrl = publicAtomUrl ?? displayedData?.atom_base_url ?? null;
  const rows = useMemo(() => buildRows(specs, displayedData), [specs, displayedData]);
  const skillsByEntryCard = useMemo(
    () => indexSkills(guides.state.status === "ready" ? guides.state.data.skills : []),
    [guides.state],
  );
  // 상시 목록의 스킬: 실린 문서 가운데 스킬 엔트리 카드인 것. 주입 순서대로, 이름마다 한 번만.
  const listedSkills = useMemo(() => {
    const seen = new Map<string, { skill: SkillGuide; rowKey: string; how: LoadedHow }>();
    for (const row of rows) {
      const documents = row.documents ?? [];
      const nodeIds = new Set(documents.map(document => document.node_id));
      for (const document of documents) {
        const skill = skillsByEntryCard.get(document.card_id);
        const how = skill ? loadedHow(row.context, document, skillsByEntryCard, nodeIds) : null;
        if (skill && how && !seen.has(skill.name)) seen.set(skill.name, { skill, rowKey: row.key, how });
      }
    }
    return Array.from(seen.values());
  }, [rows, skillsByEntryCard]);
  // 스킬이 모두 같은 방식으로 실리면 구역 머리에 한 번만 적고, 다른 것만 줄에 적는다.
  const commonHow = listedSkills.length > 0 && listedSkills.every(item => item.how === listedSkills[0]!.how) ? listedSkills[0]!.how : null;
  const reportTime = guides.state.status === "ready" ? formatReport(guides.state.data.report) : null;
  const reportExists = guides.state.status === "ready" && guides.state.data.report !== null;
  const toggle = (key: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  useEffect(() => {
    if (view.kind !== "list" || !returnFocus.current) return;
    rowRefs.current.get(returnFocus.current)?.focus();
    returnFocus.current = null;
  }, [view]);

  const open = (next: View) => { setView(next); };
  const back = (from: string | null) => { returnFocus.current = from; setView({ kind: "list" }); };

  const conditions = (
    <div className="@container flex items-end gap-2">
      {/* 칸 폭이 좁으면(설정 창 태블릿, 휴대폰) 값이 잘리지 않게 두 줄로 내린다. */}
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 @md:grid-cols-3">
        <label className="min-w-0 text-xs font-medium">
          호출 소스
          <select aria-label="조립 호출 소스" className={inputClassName} value={callerSource} onChange={(event) => setCallerSource(event.target.value)}>
            {CALLER_SOURCES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-xs font-medium">
          백엔드
          <select aria-label="조립 백엔드" className={inputClassName} value={backend} onChange={(event) => setBackend(event.target.value)}>
            {["claude", "codex"].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-xs font-medium">
          카드 역할
          <select aria-label="조립 카드 역할" className={inputClassName} value={cardRole} onChange={(event) => setCardRole(event.target.value)}>
            {CARD_ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      {target.kind === "central" && (
        <DashboardIconCap size="small" label="다시 조립" onClick={() => setAttempt((value) => value + 1)}>
          <RotateCw className="size-4" aria-hidden="true" />
        </DashboardIconCap>
      )}
    </div>
  );

  const selectedRow = view.kind === "source" || view.kind === "skill" ? rows.find(row => row.key === view.key) ?? null : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="agent-context-assembly">
      {conditions}
      {view.kind !== "list" && displayedData ? (
        view.kind === "skill" && selectedRow ? (
          <SkillOriginal nodeId={nodeId} request={request} atomBaseUrl={atomBaseUrl} skillNodeId={view.nodeId} name={view.name} parentTitle={rowTitle(selectedRow)} parentRow={selectedRow} parentState={state} onRetryParent={() => setAttempt(value => value + 1)} onBack={() => { returnFocus.current = "skill"; setView({ kind: "source", key: selectedRow.key }); }} />
        ) : (
          <SourceDetail row={selectedRow} data={displayedData} skillsByEntryCard={skillsByEntryCard} atomBaseUrl={atomBaseUrl} requestState={state} focusSkill={returnFocus.current === "skill"}
            onBack={() => back(view.kind === "all" ? "all" : selectedRow?.key ?? null)}
            onOpenSkill={skill => selectedRow && open({ kind: "skill", key: selectedRow.key, nodeId: skill.nodeId, name: skill.name })}
            onRetry={() => setAttempt(value => value + 1)} />
        )
      ) : (<>
      {!presentOnNode && (
        <p className="text-xs text-muted-foreground">{nodeId}에는 이 프로필이 없습니다.</p>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {state.status === "error" && rows.length === 0 ? (
          <FrameNotice>
            <div className="flex flex-col items-center gap-3">
              <p role="alert" className="text-sm text-destructive-foreground" data-v3-selectable-content="true">{state.message}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>다시 시도</Button>
            </div>
          </FrameNotice>
        ) : state.status === "loading" && rows.length === 0 ? (
          <FrameLoading label="조립하는 중..." />
        ) : (
          <div className="space-y-2" role={state.status === "loading" ? "status" : undefined} aria-label={state.status === "loading" ? "조립하는 중" : undefined}>
            {state.status === "error" ? (
              // 중앙 프로필은 조립이 실패해도 화면의 값으로 순서와 출처를 보인다.
              <div className="flex items-center gap-2 rounded-floor bg-accent-red/10 px-3 py-2">
                <p role="alert" className="min-w-0 flex-1 text-sm text-destructive-foreground" data-v3-selectable-content="true">{state.message}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>다시 시도</Button>
              </div>
            ) : (
              <AssemblyRow
                rowKey="all"
                refs={rowRefs}
                title="전체"
                strong
                meta={null}
                size={data ? `${formatTokens(data.manifest.total_token_estimate ?? 0)} 토큰` : null}
                loading={state.status === "loading"}
                onClick={() => open({ kind: "all" })}
              />
            )}
            {rows.map((row) => {
              const expandable = row.documents !== null;
              return (
                <div key={row.key} className="space-y-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <AssemblyRow
                      rowKey={row.key}
                      refs={rowRefs}
                      title={data ? rowTitle(row) : state.status === "error" ? rowTitle(row) : null}
                      titlePrefix={data ? row.parentTitle : null}
                      meta={rowMeta(row)}
                      status={row.status}
                      size={row.status === "ok" && row.chars !== null ? formatChars(row.chars) : null}
                      loading={state.status === "loading"}
                      inactive={state.status === "error"}
                      expanded={expandable ? expanded.has(row.key) : undefined}
                      onClick={() => expandable ? toggle(row.key) : open({ kind: "source", key: row.key })}
                    />
                    {data && expandable && <DashboardIconCap size="small" label={`${rowTitle(row)} 본문 보기`} onClick={() => open({ kind: "source", key: row.key })}><FileText className="size-4" aria-hidden="true" /></DashboardIconCap>}
                    {atomBaseUrl && data && <DashboardIconCap size="small" label={`${rowTitle(row)} atom에서 열기`} onClick={() => window.open(`${atomBaseUrl}/#${row.nodeId}`, "_blank", "noopener")}><ExternalLink className="size-4" aria-hidden="true" /></DashboardIconCap>}
                  </div>
                  {data && expandable && expanded.has(row.key) && <DocumentTree row={row} skillsByEntryCard={skillsByEntryCard} />}
                </div>
              );
            })}
            {data && listedSkills.length > 0 && (
              <section className="space-y-2 pt-3" aria-label="스킬" data-testid="agent-context-skills">
                <div className="flex items-baseline gap-2">
                  <h4 className="text-sm font-semibold">스킬</h4>
                  {commonHow && <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{howLabel(commonHow)}</p>}
                  {reportTime && <p className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">{reportTime} 검증</p>}
                </div>
                {listedSkills.map(({ skill, rowKey, how }) => (
                  <button
                    key={skill.name}
                    type="button"
                    className="block w-full min-w-0 rounded-floor border border-border bg-muted/10 px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background hover:bg-muted"
                    onClick={() => open({ kind: "skill", key: rowKey, nodeId: skill.body_node_id, name: skill.name })}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate font-medium">{skill.name}</span>
                      <SkillLintBadge skill={skill} reportExists={reportExists} />
                      {!commonHow && <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">{howLabel(how)}</span>}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{skill.description}</span>
                    {skill.lint && skill.lint.links.length > 0 && <span className="mt-1 block"><LinkChips links={skill.lint.links} /></span>}
                  </button>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
      <p className="pt-1 text-xs text-muted-foreground">프로필 몫만 보입니다. 폴더, 페이지, 세션이 붙이는 글은 빠집니다.</p>
      </>)}
    </div>
  );
}

function AssemblyRow({ rowKey, refs, title, titlePrefix = null, meta, status = null, size, loading, inactive = false, strong = false, expanded, onClick }: {
  rowKey: string;
  refs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  title: string | null;
  /** 같은 이름의 소스를 가르는 부모 문서 제목. */
  titlePrefix?: string | null;
  meta: string | null;
  status?: RowStatus | null;
  /** 줄 오른쪽에 적는 수. 글자 수 하나로 적는다. */
  size: string | null;
  loading: boolean;
  inactive?: boolean;
  strong?: boolean;
  /** 주면 누를 때 실린 문서를 펼치는 줄이다. 안 주면 본문으로 들어가는 줄이다. */
  expanded?: boolean;
  onClick(): void;
}) {
  const left = status === "filtered" || status === "duplicate";
  return (
    <button
      type="button"
      ref={(element) => { if (element) refs.current.set(rowKey, element); else refs.current.delete(rowKey); }}
      className="flex min-w-0 w-full items-center gap-3 rounded-floor border border-border bg-muted/10 px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background enabled:hover:bg-muted disabled:cursor-default"
      data-status={status ?? undefined}
      aria-expanded={expanded}
      disabled={loading || inactive}
      onClick={onClick}
    >
      {expanded !== undefined && !inactive && <ChevronRight className={`size-4 shrink-0 text-muted-foreground ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />}
      <span className={`min-w-0 flex-1 ${left ? "opacity-60" : ""}`}>
        <span className="flex min-w-0 items-center gap-2">
          {loading && !title ? <span className="flex h-5 flex-1 items-center"><span className="v3-run-skeleton v3-run-skeleton--title" /></span> : <span className={`min-w-0 truncate ${strong ? "font-semibold" : "font-medium"}`}>{titlePrefix && <span className="font-normal text-muted-foreground">{titlePrefix} / </span>}{title}</span>}
          {!loading && status && <StatusBadge status={status} />}
        </span>
        {/* 좁은 폭에서는 오른쪽 칸이 제목 자리를 먹으니 글자 수를 메타 줄 앞으로 옮긴다. */}
        {(meta || size) && <span className="block truncate text-xs text-muted-foreground">{size && <span className="tabular-nums sm:hidden">{size}{meta ? " · " : ""}</span>}{meta}</span>}
      </span>
      {loading ? <span className="v3-run-skeleton v3-run-skeleton--badge" /> : size && <span className="shrink-0 text-xs tabular-nums text-muted-foreground max-sm:hidden">{size}</span>}
      {!inactive && expanded === undefined && <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
    </button>
  );
}

function DocumentTree({ row, skillsByEntryCard }: { row: Row; skillsByEntryCard: ReadonlyMap<string, SkillGuide> }) {
  const documents = row.documents ?? [];
  if (documents.length === 0) {
    return (
      <p className="rounded-floor border border-border px-3 py-2 text-xs text-muted-foreground">
        {row.status === "filtered" ? `이 조건에서는 빠집니다. ${conditionSummary(row.context.applies_when)}`
          : row.status === "duplicate" ? "앞에서 같은 소스가 이미 들어갑니다."
            : row.status === "error" ? "atom에서 읽지 못했습니다." : "실린 문서가 없습니다."}
      </p>
    );
  }
  const nodeIds = new Set(documents.map(document => document.node_id));
  return (
    <ul className="rounded-floor border border-border px-3 py-2" aria-label={`${rowTitle(row)}에 실린 문서`} data-testid="agent-context-documents">
      {documents.map((document) => {
        const how = loadedHow(row.context, document, skillsByEntryCard, nodeIds);
        return (
          <li key={document.node_id} className="flex min-w-0 items-center gap-3 py-0.5 text-sm" style={{ paddingInlineStart: `calc(var(--v3-space-4) * ${document.depth})` }}>
            <span className={`min-w-0 flex-1 truncate ${how ? "" : "text-muted-foreground"}`} data-v3-selectable-content="true">{document.title}</span>
            {how && <span className={`shrink-0 whitespace-nowrap text-xs ${how === "body" ? "text-muted-foreground" : ""}`}>{howLabel(how)}</span>}
            <span className="min-w-14 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">{how && how !== "title" ? formatChars(document.chars) : ""}</span>
          </li>
        );
      })}
    </ul>
  );
}

function StatusBadge({ status }: { status: RowStatus }) {
  if (status === "ok") return <Badge variant="secondary">들어감</Badge>;
  if (status === "error") return <Badge variant="error">실패</Badge>;
  if (status === "filtered") return <Badge variant="secondary">빠짐</Badge>;
  if (status === "empty") return <Badge variant="outline">비어 있음</Badge>;
  if (status === "duplicate") return <Badge variant="outline">중복</Badge>;
  return null;
}

function DetailHeader({ title, meta, copyText, copyLabel = "본문 복사", atomUrl, onBack, backLabel }: {
  title: string; meta: ReactNode; copyText: string | null; copyLabel?: string; atomUrl: string | null; onBack(): void; backLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { backRef.current?.focus(); }, []);
  return (
    <div className="flex items-center gap-2">
      <DashboardIconCap ref={backRef} size="small" label={backLabel} onClick={onBack}>
        <ArrowLeft className="size-4" aria-hidden="true" />
      </DashboardIconCap>
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-sm font-semibold" data-v3-selectable-content="true">{title}</h4>
        {meta && <p className="flex min-w-0 flex-wrap gap-x-1 text-xs text-muted-foreground" data-v3-selectable-content="true">{meta}</p>}
      </div>
      {copyText !== null && (
        <DashboardIconCap size="small" label={copied ? "복사됨" : copyLabel} onClick={() => { void navigator.clipboard?.writeText(copyText).then(() => setCopied(true), () => setCopied(false)); }}>
          {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        </DashboardIconCap>
      )}
      {atomUrl && (
        <DashboardIconCap size="small" label="atom에서 열기" onClick={() => window.open(atomUrl, "_blank", "noopener")}>
          <ExternalLink className="size-4" aria-hidden="true" />
        </DashboardIconCap>
      )}
    </div>
  );
}

function SourceDetail({ row, data, skillsByEntryCard, atomBaseUrl, requestState, focusSkill, onBack, onOpenSkill, onRetry }: {
  row: Row | null; data: PreviewResponse; skillsByEntryCard: ReadonlyMap<string, SkillGuide>; atomBaseUrl: string | null; requestState: { status: "loading" } | { status: "ready" } | { status: "error"; message: string }; focusSkill?: boolean; onBack(): void; onOpenSkill(skill: { nodeId: string; name: string }): void; onRetry(): void;
}) {
  const all = row === null;
  const skillSelectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => { if (focusSkill) skillSelectRef.current?.focus(); }, [focusSkill]);
  const text = all ? data.assembled : row.markdown;
  const skills = all ? [] : (row.documents ?? []).flatMap((document) => { const skill = skillsByEntryCard.get(document.card_id); return skill ? [{ name: skill.name, nodeId: skill.body_node_id }] : []; });
  const atomUrl = !all && atomBaseUrl ? `${atomBaseUrl}/#${row.nodeId}` : null;
  const origin = all ? null : [row.origin, contextShape(row.context)].filter(Boolean).join(" · ");
  const chars = all ? data.manifest.total_chars ?? 0 : row.chars;
  const tokens = all ? data.manifest.total_token_estimate ?? 0 : row.status === "ok" ? row.tokens : null;
  const meta = <>{origin && <span className="max-w-full min-w-0 truncate">{origin} · </span>}{chars !== null && <span className="shrink-0 whitespace-nowrap">{formatChars(chars)}{tokens !== null ? " · " : ""}</span>}{tokens !== null && <span className="shrink-0 whitespace-nowrap">예상 {tokens.toLocaleString()} 토큰</span>}</>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="agent-context-assembly-detail">
      <DetailHeader title={all ? "전체" : rowTitle(row)} meta={meta} copyText={text ?? null} copyLabel={all ? "전체 복사" : "본문 복사"} atomUrl={atomUrl} onBack={onBack} backLabel="소스 목록으로" />
      {requestState.status === "ready" && skills.length > 0 && (
        <label className="text-xs font-medium">
          스킬 정의 원문
          <select ref={skillSelectRef} aria-label="스킬 정의 원문" className={inputClassName} value="" onChange={(event) => {
            const skill = skills.find((item) => item.nodeId === event.target.value);
            if (skill) onOpenSkill(skill);
          }}>
            <option value="">스킬 {skills.length}개 가운데 고르기</option>
            {skills.map((skill) => <option key={skill.nodeId} value={skill.nodeId}>{skill.name}</option>)}
          </select>
        </label>
      )}
      {requestState.status === "loading" ? <FrameLoading label="조립하는 중..." /> : requestState.status === "error" ? (
        <FrameNotice><div className="flex flex-col items-center gap-3"><p role="alert" className="text-sm text-destructive-foreground">{requestState.message}</p><Button type="button" size="sm" variant="outline" onClick={onRetry}>다시 시도</Button></div></FrameNotice>
      ) : text ? (
        <div className="flex min-h-0 flex-1 flex-col" data-v3-selectable-content="true">
          <ContextContentRenderer content={text} fill />
        </div>
      ) : (
        <FrameNotice>
          {row?.status === "error" ? (
            <div className="flex flex-col items-center gap-3">
              <p role="alert" className="text-sm text-destructive-foreground">atom에서 읽지 못했습니다.</p>
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>다시 조립</Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {row?.status === "filtered" ? `이 조건에서는 빠집니다. ${conditionSummary(row.context.applies_when)}`
                : row?.status === "duplicate" ? "앞에서 같은 소스가 이미 들어갑니다."
                  : "atom에 본문이 없습니다."}
            </p>
          )}
        </FrameNotice>
      )}
    </div>
  );
}

function SkillOriginal({ nodeId, request, atomBaseUrl, skillNodeId, name, parentTitle, parentRow, parentState, onRetryParent, onBack }: {
  nodeId: string; request: typeof fetch; atomBaseUrl: string | null; skillNodeId: string; name: string; parentTitle: string; parentRow: Row; parentState: { status: "loading" } | { status: "ready" } | { status: "error"; message: string }; onRetryParent(): void; onBack(): void;
}) {
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; markdown: string | null } | { status: "error" }>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const response = await request(`/api/nodes/${encodeURIComponent(nodeId)}/agents/context-preview`, {
          method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ atom_contexts: [{ node_id: skillNodeId, depth: 0 }], session: { source: "browser" } }),
        });
        if (!response.ok) throw new Error();
        const json = await response.json() as PreviewResponse;
        setState({ status: "ready", markdown: json.sections[0]?.markdown ?? null });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    })();
    return () => controller.abort();
  }, [nodeId, request, skillNodeId, attempt]);
  const markdown = state.status === "ready" ? state.markdown : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="agent-context-skill-original">
      <DetailHeader title={name} meta={<><span className="max-w-full min-w-0 truncate">{parentTitle} · 스킬 정의 원문{markdown && parentRow.status !== "filtered" ? " · " : ""}</span>{markdown && parentRow.status !== "filtered" && <span className="shrink-0 whitespace-nowrap">{formatChars(markdown.length)}</span>}</>} copyText={parentRow.status === "filtered" ? null : markdown} atomUrl={atomBaseUrl ? `${atomBaseUrl}/#${skillNodeId}` : null} onBack={onBack} backLabel="소스 본문으로" />
      {parentState.status === "loading" ? <FrameLoading label="조립하는 중..." /> : parentState.status === "error" ? <FrameNotice><div className="flex flex-col items-center gap-3"><p role="alert" className="text-sm text-destructive-foreground">{parentState.message}</p><Button type="button" size="sm" variant="outline" onClick={onRetryParent}>다시 시도</Button></div></FrameNotice>
        : parentRow.status === "filtered" ? <FrameNotice><p className="text-sm text-muted-foreground">이 조건에서는 빠집니다. {conditionSummary(parentRow.context.applies_when)}</p></FrameNotice>
        : state.status === "loading" ? <FrameLoading label="원문을 불러오는 중..." />
        : state.status === "error" ? (
          <FrameNotice>
            <div className="flex flex-col items-center gap-3">
              <p role="alert" className="text-sm text-destructive-foreground">원문을 읽지 못했습니다.</p>
              <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>다시 시도</Button>
            </div>
          </FrameNotice>
        ) : markdown ? (
          <div className="flex min-h-0 flex-1 flex-col" data-v3-selectable-content="true">
            <ContextContentRenderer content={markdown} fill />
          </div>
        ) : <FrameNotice><p className="text-sm text-muted-foreground">atom에 본문이 없습니다.</p></FrameNotice>}
    </div>
  );
}

function buildRows(specs: Array<{ context: AgentAtomContext; source: string }> | null, data: PreviewResponse | null): Row[] {
  const sections = data?.sections ?? [];
  const sources = data?.manifest.sources ?? [];
  if (specs) {
    return specs.map(({ context, source }, index) => {
      const at = sections.findIndex((section) => section.spec_index === index);
      const manifest = at >= 0 ? sources[at] : null;
      return {
        key: `${index}`,
        nodeId: context.node_id,
        context,
        origin: source,
        title: at >= 0 ? sections[at]!.title : null,
        parentTitle: at >= 0 ? sections[at]!.parent_title ?? null : null,
        documents: at >= 0 ? sections[at]!.documents ?? null : null,
        status: data ? (manifest?.status ?? "duplicate") : null,
        tokens: manifest?.token_estimate ?? null,
        chars: manifest?.chars ?? null,
        markdown: at >= 0 ? sections[at]!.markdown : null,
      };
    });
  }
  return sections.map((section, index) => {
    const manifest = sources[index]!;
    return {
      key: `${section.spec_index}`,
      nodeId: manifest.node_id,
      context: { node_id: manifest.node_id, depth: manifest.depth, mode: manifest.mode as AgentAtomContext["mode"], applies_when: manifest.applies_when },
      origin: "노드 설정",
      title: section.title,
      parentTitle: section.parent_title ?? null,
      documents: section.documents ?? null,
      status: manifest.status,
      tokens: manifest.token_estimate,
      chars: manifest.chars,
      markdown: section.markdown,
    };
  });
}

function rowTitle(row: Row): string {
  return row.title ?? row.nodeId.slice(0, 8);
}

function rowMeta(row: Row): string {
  return [row.origin, contextShape(row.context), conditionSummary(row.context.applies_when) || null].filter(Boolean).join(" · ");
}

function contextShape(context: AgentAtomContext): string {
  const mode = context.mode === "index" ? "색인 · " : context.mode === "titles" ? "제목만 · " : "전체 · ";
  return `${mode}깊이 ${context.depth ?? 3}`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

