import { useTranslation } from "react-i18next";
// 고른 조건으로 노드 미리보기를 불러, 주입 순서대로 소스 목록을 보인다. 소스를 펼치면 실린 문서가 나오고,
// 상시 목록의 스킬은 아래에 따로 모아 연결과 진단을 함께 보인다. 본문은 같은 자리에서 연다.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, RotateCw } from "lucide-react";
import { Button, ContextContentRenderer, DashboardIconCap, FrameLoading, FrameNotice, useAtomPublicUrl } from "@seosoyoung/soul-ui";

import { conditionSummary, inputClassName, type AgentAtomContext } from "./AgentAtomContextFields";
import { formatChars, reportTime as formatReport, skillsByEntryCard as indexSkills, useSkillGuides, type SkillGuide } from "../lib/skill-guides";
import { buildRows, collectListedSkills, contextShape, formatTokens, rowTitle, skillChoices, type PreviewResponse, type Row } from "./agent-context-assembly-model";
import { AssemblyRow, SourceItem, useCompact } from "./AssemblyRows";
import { LinkChips, SkillLintBadge, howLabel } from "./guides/GuideParts";
import "../v3/v3-run-history.css";

export type AssemblyTarget =
  | { kind: "central"; agentId: string; specs: Array<{ context: AgentAtomContext; source: string }> }
  | { kind: "node"; agentId: string };

type View =
  | { kind: "list" }
  | { kind: "all" }
  | { kind: "source"; key: string }
  | { kind: "skill"; key: string; nodeId: string; name: string };

const CALLER_SOURCES = ["browser", "agent", "api", "channel_observer", "execute-proxy", "llm", "slack", "soul-app", "system", "trello_watcher"];
const CARD_ROLES: ReadonlyArray<readonly [string, string]> = [["", "agents.assembly.noCard"], ["assignee", "agents.assembly.assignee"], ["member", "agents.assembly.member"]];

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
  const { t, i18n } = useTranslation();
  const [callerSource, setCallerSource] = useState("browser");
  const [backend, setBackend] = useState(initialBackend);
  const [cardRole, setCardRole] = useState("");
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; data: PreviewResponse } | { status: "error"; message: string | null }>({ status: "loading" });
  const [view, setView] = useState<View>({ kind: "list" });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const guides = useSkillGuides(request);
  const lastData = useRef<PreviewResponse | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [listRef, compact] = useCompact();
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
        if (!response.ok) throw new Error(typeof json.detail === "string" ? json.detail : undefined);
        // 미리보기가 아닌 응답(소스 목록이 없는 꼴)은 화면을 깨뜨리지 않고 실패로 다룬다.
        if (!json.manifest || !Array.isArray(json.sections)) throw new Error();
        lastData.current = json as PreviewResponse;
        setState({ status: "ready", data: json as PreviewResponse });
      } catch (caught) {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: caught instanceof Error && caught.message ? caught.message : null });
      }
    })();
    return () => controller.abort();
  }, [body, nodeId, request, attempt]);

  const data = state.status === "ready" ? state.data : null;
  const displayedData = data ?? lastData.current;
  // 브라우저가 열 수 있는 주소(오케스트레이터)를 먼저 쓰고, 없으면 워커가 준 주소를 쓴다.
  const publicAtomUrl = useAtomPublicUrl();
  const atomBaseUrl = publicAtomUrl ?? displayedData?.atom_base_url ?? null;
  const nodeSettings = t("agents.profile.nodeSettings");
  const rows = useMemo(() => buildRows(specs, displayedData, nodeSettings), [specs, displayedData, nodeSettings]);
  const skillsByEntryCard = useMemo(
    () => indexSkills(guides.state.status === "ready" ? guides.state.data.skills : []),
    [guides.state],
  );
  const listedSkills = useMemo(() => collectListedSkills(rows, skillsByEntryCard), [rows, skillsByEntryCard]);
  // 스킬이 모두 같은 방식으로 실리면 구역 머리에 한 번만 적고, 다른 것만 줄에 적는다.
  const commonHow = listedSkills.length > 0 && listedSkills.every(item => item.how === listedSkills[0]!.how) ? listedSkills[0]!.how : null;
  const reportTime = guides.state.status === "ready" ? formatReport(guides.state.data.report, i18n.resolvedLanguage) : null;
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
          {t("agents.context.callerSource")}
          <select aria-label={t("agents.assembly.callerSource")} className={inputClassName} value={callerSource} onChange={(event) => setCallerSource(event.target.value)}>
            {CALLER_SOURCES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-xs font-medium">
          {t("agents.context.backend")}
          <select aria-label={t("agents.assembly.backend")} className={inputClassName} value={backend} onChange={(event) => setBackend(event.target.value)}>
            {["claude", "codex"].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-xs font-medium">
          {t("agents.context.cardRole")}
          <select aria-label={t("agents.assembly.cardRole")} className={inputClassName} value={cardRole} onChange={(event) => setCardRole(event.target.value)}>
            {CARD_ROLES.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
          </select>
        </label>
      </div>
      {target.kind === "central" && (
        <DashboardIconCap size="small" label={t("agents.assembly.rebuild")} onClick={() => setAttempt((value) => value + 1)}>
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
        <p className="text-xs text-muted-foreground">{t("agents.assembly.profileMissing", { nodeId })}</p>
      )}
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {state.status === "error" && rows.length === 0 ? (
          <FrameNotice>
            <div className="flex flex-col items-center gap-3">
              <p role="alert" className="text-sm text-destructive-foreground" data-v3-selectable-content="true">{state.message ?? t("agents.assembly.error")}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>{t("agents.retry")}</Button>
            </div>
          </FrameNotice>
        ) : state.status === "loading" && rows.length === 0 ? (
          <FrameLoading label={t("agents.assembly.loading")} />
        ) : (
          <div className="space-y-2" role={state.status === "loading" ? "status" : undefined} aria-label={state.status === "loading" ? t("agents.assembly.loadingLabel") : undefined}>
            {state.status === "error" ? (
              // 중앙 프로필은 조립이 실패해도 화면의 값으로 순서와 출처를 보인다.
              <div className="flex items-center gap-2 rounded-floor bg-accent-red/10 px-3 py-2">
                <p role="alert" className="min-w-0 flex-1 text-sm text-destructive-foreground" data-v3-selectable-content="true">{state.message ?? t("agents.assembly.error")}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>{t("agents.retry")}</Button>
              </div>
            ) : (
              <AssemblyRow
                rowKey="all"
                refs={rowRefs}
                title={t("agents.assembly.all")}
                strong
                meta={null}
                size={data ? t("agents.assembly.tokens", { countLabel: formatTokens(data.manifest.total_token_estimate ?? 0) }) : null}
                compact={compact}
                loading={state.status === "loading"}
                onClick={() => open({ kind: "all" })}
              />
            )}
            {rows.map((row) => (
              <SourceItem
                key={row.key}
                row={row}
                title={data || state.status === "error" ? rowTitle(row) : null}
                compact={compact}
                loading={state.status === "loading"}
                inactive={state.status === "error"}
                ready={data !== null}
                expanded={expanded.has(row.key)}
                atomBaseUrl={atomBaseUrl}
                skillsByEntryCard={skillsByEntryCard}
                refs={rowRefs}
                onToggle={() => row.documents !== null ? toggle(row.key) : open({ kind: "source", key: row.key })}
                onOpenBody={() => open({ kind: "source", key: row.key })}
              />
            ))}
            {data && listedSkills.length > 0 && (
              <section className="space-y-2 pt-3" aria-label={t("agents.skill.label")} data-testid="agent-context-skills">
                <div className="flex items-baseline gap-2">
                  <h4 className="text-sm font-semibold">{t("agents.skill.label")}</h4>
                  {commonHow && <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{howLabel(commonHow, t)}</p>}
                  {reportTime && <p className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">{t("agents.skill.verifiedAt", { time: reportTime })}</p>}
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
                      {!commonHow && <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">{howLabel(how, t)}</span>}
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
      <p className="pt-1 text-xs text-muted-foreground">{t("agents.assembly.profileOnly")}</p>
      </>)}
    </div>
  );
}

function DetailHeader({ title, meta, copyText, copyLabel, atomUrl, onBack, backLabel }: {
  title: string; meta: ReactNode; copyText: string | null; copyLabel?: string; atomUrl: string | null; onBack(): void; backLabel: string;
}) {
  const { t } = useTranslation();
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
        <DashboardIconCap size="small" label={copied ? t("agents.copied") : copyLabel ?? t("agents.copyBody")} onClick={() => { void navigator.clipboard?.writeText(copyText).then(() => setCopied(true), () => setCopied(false)); }}>
          {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        </DashboardIconCap>
      )}
      {atomUrl && (
        <DashboardIconCap size="small" label={t("agents.openInAtom")} onClick={() => window.open(atomUrl, "_blank", "noopener")}>
          <ExternalLink className="size-4" aria-hidden="true" />
        </DashboardIconCap>
      )}
    </div>
  );
}

function SourceDetail({ row, data, skillsByEntryCard, atomBaseUrl, requestState, focusSkill, onBack, onOpenSkill, onRetry }: {
  row: Row | null; data: PreviewResponse; skillsByEntryCard: ReadonlyMap<string, SkillGuide>; atomBaseUrl: string | null; requestState: { status: "loading" } | { status: "ready" } | { status: "error"; message: string | null }; focusSkill?: boolean; onBack(): void; onOpenSkill(skill: { nodeId: string; name: string }): void; onRetry(): void;
}) {
  const { t, i18n } = useTranslation();
  const all = row === null;
  const skillSelectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => { if (focusSkill) skillSelectRef.current?.focus(); }, [focusSkill]);
  const text = all ? data.assembled : row.markdown;
  const skills = all ? [] : skillChoices(row, skillsByEntryCard);
  const atomUrl = !all && atomBaseUrl && row.nodeId ? `${atomBaseUrl}/#${row.nodeId}` : null;
  const origin = all ? null : [row.origin, contextShape(row.context, t)].filter(Boolean).join(" · ");
  const chars = all ? data.manifest.total_chars ?? 0 : row.chars;
  const tokens = all ? data.manifest.total_token_estimate ?? 0 : row.status === "ok" ? row.tokens : null;
  const meta = <>{origin && <span className="max-w-full min-w-0 truncate">{origin} · </span>}{chars !== null && <span className="shrink-0 whitespace-nowrap">{formatChars(chars, t, i18n.resolvedLanguage)}{tokens !== null ? " · " : ""}</span>}{tokens !== null && <span className="shrink-0 whitespace-nowrap">{t("agents.assembly.estimatedTokens", { tokens: tokens.toLocaleString(i18n.resolvedLanguage) })}</span>}</>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="agent-context-assembly-detail">
      <DetailHeader title={all ? t("agents.assembly.all") : rowTitle(row)} meta={meta} copyText={text ?? null} copyLabel={all ? t("agents.assembly.copyAll") : t("agents.copyBody")} atomUrl={atomUrl} onBack={onBack} backLabel={t("agents.assembly.backToSources")} />
      {requestState.status === "ready" && skills.length > 0 && (
        <label className="text-xs font-medium">
          {t("agents.assembly.skillOriginal")}
          <select ref={skillSelectRef} aria-label={t("agents.assembly.skillOriginal")} className={inputClassName} value="" onChange={(event) => {
            const skill = skills.find((item) => item.nodeId === event.target.value);
            if (skill) onOpenSkill(skill);
          }}>
            <option value="">{t("agents.assembly.chooseSkill", { count: skills.length })}</option>
            {skills.map((skill) => <option key={skill.nodeId} value={skill.nodeId}>{skill.name}</option>)}
          </select>
        </label>
      )}
      {requestState.status === "loading" ? <FrameLoading label={t("agents.assembly.loading")} /> : requestState.status === "error" ? (
        <FrameNotice><div className="flex flex-col items-center gap-3"><p role="alert" className="text-sm text-destructive-foreground">{requestState.message ?? t("agents.assembly.error")}</p><Button type="button" size="sm" variant="outline" onClick={onRetry}>{t("agents.retry")}</Button></div></FrameNotice>
      ) : text ? (
        <div className="flex min-h-0 flex-1 flex-col" data-v3-selectable-content="true">
          <ContextContentRenderer content={text} fill />
        </div>
      ) : (
        <FrameNotice>
          {row?.status === "error" ? (
            <div className="flex flex-col items-center gap-3">
              <p role="alert" className="text-sm text-destructive-foreground">{t("agents.assembly.atomError")}</p>
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t("agents.assembly.rebuild")}</Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {row?.status === "filtered" ? t("agents.assembly.filteredDetail", { condition: conditionSummary(row.context.applies_when) })
                : row?.status === "duplicate" ? t("agents.assembly.duplicateDetail")
                  : t("agents.assembly.noBody")}
            </p>
          )}
        </FrameNotice>
      )}
    </div>
  );
}

function SkillOriginal({ nodeId, request, atomBaseUrl, skillNodeId, name, parentTitle, parentRow, parentState, onRetryParent, onBack }: {
  nodeId: string; request: typeof fetch; atomBaseUrl: string | null; skillNodeId: string; name: string; parentTitle: string; parentRow: Row; parentState: { status: "loading" } | { status: "ready" } | { status: "error"; message: string | null }; onRetryParent(): void; onBack(): void;
}) {
  const { t, i18n } = useTranslation();
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
      <DetailHeader title={name} meta={<><span className="max-w-full min-w-0 truncate">{parentTitle} · {t("agents.assembly.skillOriginal")}{markdown && parentRow.status !== "filtered" ? " · " : ""}</span>{markdown && parentRow.status !== "filtered" && <span className="shrink-0 whitespace-nowrap">{formatChars(markdown.length, t, i18n.resolvedLanguage)}</span>}</>} copyText={parentRow.status === "filtered" ? null : markdown} atomUrl={atomBaseUrl ? `${atomBaseUrl}/#${skillNodeId}` : null} onBack={onBack} backLabel={t("agents.assembly.backToSource")} />
      {parentState.status === "loading" ? <FrameLoading label={t("agents.assembly.loading")} /> : parentState.status === "error" ? <FrameNotice><div className="flex flex-col items-center gap-3"><p role="alert" className="text-sm text-destructive-foreground">{parentState.message ?? t("agents.assembly.error")}</p><Button type="button" size="sm" variant="outline" onClick={onRetryParent}>{t("agents.retry")}</Button></div></FrameNotice>
        : parentRow.status === "filtered" ? <FrameNotice><p className="text-sm text-muted-foreground">{t("agents.assembly.filteredDetail", { condition: conditionSummary(parentRow.context.applies_when) })}</p></FrameNotice>
        : state.status === "loading" ? <FrameLoading label={t("agents.assembly.loadingOriginal")} />
        : state.status === "error" ? (
          <FrameNotice>
            <div className="flex flex-col items-center gap-3">
              <p role="alert" className="text-sm text-destructive-foreground">{t("agents.assembly.originalError")}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>{t("agents.retry")}</Button>
            </div>
          </FrameNotice>
        ) : markdown ? (
          <div className="flex min-h-0 flex-1 flex-col" data-v3-selectable-content="true">
            <ContextContentRenderer content={markdown} fill />
          </div>
        ) : <FrameNotice><p className="text-sm text-muted-foreground">{t("agents.assembly.noBody")}</p></FrameNotice>}
    </div>
  );
}
