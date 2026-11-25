// 설정의 「스킬과 카탈로그」 탭. 목록에서 고른 스킬의 본문, 연결, 쓰이는 곳, 검증 결과를 본다.
// 정본은 atom이라 여기서 고치지 않는다. 고치기는 문서마다 「atom에서 열기」로 나간다.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, RotateCw } from "lucide-react";
import { Button, DashboardIconCap, FrameNotice } from "@seosoyoung/soul-ui";

import { DetailTabs } from "../../v3/DetailTabs";
import { useOrchestratorStore } from "../../store/orchestrator-store";
import {
  SettingsListDetailFrame, SettingsListHeader, SettingsListRow, SettingsListSection,
} from "../config/SettingsListDetail";
import {
  catalogFindings, computeSkillUsage, profileCount, reportTime, requestVerify, severityRank, skillFindings, useContextOverview,
  useExecNode, useSkillGuides, worstFinding,
  type CatalogGuide, type GuideFinding, type GuideReport, type SkillGuide, type SkillGuides,
} from "../../lib/skill-guides";
import { CatalogDetail, SkillDetail } from "./SkillDetail";
import { FindingBadge, SkillLintBadge } from "./GuideParts";
import "../../v3/v3-run-history.css";
import "./guides.css";

type Kind = "skill" | "catalog";

/** 다시 검증을 누른 뒤 보고가 바뀌었는지 15초마다 목록을 다시 읽고, 10분이 지나면 멈춘다. */
const VERIFY_POLL_MS = 15_000;
const VERIFY_WAIT_MS = 600_000;

type VerifyPhase = "idle" | "waiting" | "conflict" | "failed";

function useVerify(request: typeof fetch, report: GuideReport | null, refresh: () => Promise<SkillGuides | null>) {
  const [phase, setPhase] = useState<VerifyPhase>("idle");
  const timers = useRef<{ poll?: ReturnType<typeof setInterval>; stop?: ReturnType<typeof setTimeout> }>({});
  const latest = useRef({ report, refresh });
  latest.current = { report, refresh };
  const clear = () => { clearInterval(timers.current.poll); clearTimeout(timers.current.stop); timers.current = {}; };
  useEffect(() => clear, []);
  const start = async () => {
    const result = await requestVerify(request);
    if (result.kind === "none") { setPhase("conflict"); return; }
    if (result.kind === "failed") { setPhase("failed"); return; }
    const baseline = latest.current.report?.uploaded_at ?? null;
    setPhase("waiting");
    clear();
    timers.current.poll = setInterval(() => {
      void latest.current.refresh().then(data => {
        if (data && (data.report?.uploaded_at ?? null) !== baseline) { clear(); setPhase("idle"); }
      });
    }, VERIFY_POLL_MS);
    timers.current.stop = setTimeout(() => { clear(); setPhase("idle"); }, VERIFY_WAIT_MS);
  };
  return { phase, start };
}

function useExecNodeId(): string {
  const nodes = useOrchestratorStore(state => state.nodes);
  const [picked] = useExecNode();
  return useMemo(() => {
    const connected = Array.from(nodes.values()).filter(node => node.status === "connected").map(node => node.nodeId);
    return picked && connected.includes(picked) ? picked : connected[0] ?? "";
  }, [nodes, picked]);
}

/**
 * 머리: 보고 시각은 늘 적고, 「다시 검증」은 보고에 검증 작업이 있을 때만 보인다.
 * 누르면 같은 단추가 검증 중 표시로 바뀌어(초점이 그대로 남는다) 끝나면 되돌아온다.
 */
function ReportHead({ report, verify }: { report: GuideReport | null; verify: ReturnType<typeof useVerify> }) {
  const time = reportTime(report);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { noticeRef.current?.focus(); }, [verify.phase]);
  const waiting = verify.phase === "waiting";
  return (
    <div className="flex min-h-[var(--v3-action-size)] flex-wrap items-center gap-x-3 gap-y-1" data-testid="skill-catalog-report">
      <p className="min-w-0 flex-1 text-sm" data-v3-selectable-content="true">{time ? <><strong className="font-semibold">{time}</strong> 검증</> : "검증 보고 없음"}</p>
      {verify.phase === "conflict" ? (
        <p ref={noticeRef} tabIndex={-1} role="status" className="shrink-0 text-xs text-muted-foreground">검증 작업이 없습니다</p>
      ) : report?.verify_job_id ? (
        <>
          {verify.phase === "failed" && <p role="alert" className="shrink-0 text-xs text-destructive-foreground">요청하지 못했습니다</p>}
          <Button type="button" size="sm" variant="outline" className="shrink-0" aria-disabled={waiting || undefined} aria-busy={waiting || undefined} onClick={() => { if (!waiting) void verify.start(); }}>
            {waiting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RotateCw aria-hidden="true" />}{waiting ? "검증 중" : "다시 검증"}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/**
 * 목록 칸(aside)이 창 크기를 바꾸는 동안 가려졌다 돌아와도(display: none은 스크롤 위치를 버린다) 보던 자리를 지킨다.
 */
function useKeepScroll(listRef: { current: HTMLElement | null }) {
  const saved = useRef(0);
  useLayoutEffect(() => {
    const aside = listRef.current?.closest("aside");
    if (!aside) return;
    let visible = aside.clientHeight > 0;
    const onScroll = () => { if (aside.clientHeight > 0) saved.current = aside.scrollTop; };
    const observer = new ResizeObserver(() => {
      const now = aside.clientHeight > 0;
      if (now && !visible) aside.scrollTop = saved.current;
      visible = now;
    });
    aside.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(aside);
    return () => { aside.removeEventListener("scroll", onScroll); observer.disconnect(); };
  });
}

const SKELETON_ROWS = 7;

function ListSkeleton() {
  return (
    <div className="space-y-1" role="status" aria-label="목록을 불러오는 중" data-testid="skill-catalog-skeleton">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="space-y-2 px-2 py-2">
          <span className="flex items-center gap-2"><span className="v3-run-skeleton v3-run-skeleton--title" /><span className="v3-run-skeleton v3-run-skeleton--badge" /></span>
          <span className="v3-run-skeleton v3-run-skeleton--preview" />
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-label="상세를 불러오는 중">
      <span className="v3-run-skeleton v3-run-skeleton--title" />
      <span className="v3-run-skeleton v3-run-skeleton--preview" />
    </div>
  );
}

type Item = { kind: "skill"; item: SkillGuide } | { kind: "catalog"; item: CatalogGuide };

export function SkillCatalogTab({ request = fetch }: { request?: typeof fetch }) {
  const { state, reload, refresh } = useSkillGuides(request);
  const data = state.status === "ready" ? state.data : null;
  const verify = useVerify(request, data?.report ?? null, refresh);
  const nodeId = useExecNodeId();
  const overview = useContextOverview(nodeId, request);
  const [kind, setKind] = useState<Kind>("skill");
  const [selected, setSelected] = useState<string | null>(null);
  const [warningsOnly, setWarningsOnly] = useState(false);
  // 좁은 폭에서 목록과 상세가 번갈아 보인다. 넓은 폭에서는 쓰이지 않는다.
  const [detailOpen, setDetailOpen] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLElement>(null);

  const usage = useMemo(
    () => computeSkillUsage(overview.state.status === "ready" ? overview.state.data : null, data?.skills ?? []),
    [overview.state, data],
  );

  const items = useMemo<Item[]>(() => {
    if (!data) return [];
    const all: Item[] = kind === "skill"
      ? data.skills.map(item => ({ kind: "skill" as const, item }))
      : data.catalogs.map(item => ({ kind: "catalog" as const, item }));
    const findings = (entry: Item): readonly GuideFinding[] => entry.kind === "skill" ? skillFindings(entry.item) : catalogFindings(entry.item);
    // 진단이 무거운 것부터, 같은 무게 안에서는 많이 쓰이는 것부터, 그다음 이름순.
    const reach = (entry: Item) => entry.kind === "skill" ? profileCount(usage.get(entry.item.name)) : entry.item.lint?.used_by.length ?? 0;
    return all
      .filter(entry => !warningsOnly || ["error", "warning"].includes(worstFinding(findings(entry))?.level ?? ""))
      .sort((left, right) => severityRank(findings(left)) - severityRank(findings(right)) || reach(right) - reach(left) || left.item.name.localeCompare(right.item.name));
  }, [data, kind, warningsOnly, usage]);

  const current = items.find(entry => entry.item.name === selected) ?? items[0] ?? null;
  const reportExists = data?.report != null;

  useEffect(() => { if (detailOpen) backRef.current?.focus(); }, [detailOpen]);
  useKeepScroll(listRef);
  const openDetail = (name: string) => { setSelected(name); setDetailOpen(true); };
  // 상세를 닫으면 목록이 다시 보인 뒤(효과는 그린 뒤에 돈다) 고른 줄로 초점이 돌아간다.
  const restoreFocus = useRef(false);
  const closeDetail = () => { restoreFocus.current = true; setDetailOpen(false); };
  useEffect(() => {
    if (detailOpen || !restoreFocus.current) return;
    restoreFocus.current = false;
    listRef.current?.querySelector<HTMLElement>('[data-settings-list-row][class*="bg-accent-blue/15"]')?.focus();
  }, [detailOpen]);

  if (state.status === "error") {
    return (
      <div data-testid="skill-catalog-settings" className="space-y-4">
        <FrameNotice>
          <div className="flex flex-col items-center gap-3">
            <p role="alert" className="text-sm text-destructive-foreground">스킬을 불러오지 못했습니다.</p>
            <Button type="button" size="sm" variant="outline" onClick={reload}>다시 시도</Button>
          </div>
        </FrameNotice>
      </div>
    );
  }

  const usageFooter = (skill: SkillGuide) => overview.state.status === "ready"
    ? <span className="text-xs text-muted-foreground">프로필 {profileCount(usage.get(skill.name))}</span>
    : overview.state.status === "loading" ? <span className="v3-run-skeleton v3-run-skeleton--badge" /> : undefined;

  const list = (
    <section ref={listRef} aria-label={kind === "skill" ? "스킬 목록" : "카탈로그 목록"}>
      <SettingsListHeader
        title={kind === "skill" ? "스킬" : "카탈로그"}
        description=""
        actions={<Button type="button" size="sm" variant={warningsOnly ? "secondary" : "outline"} aria-pressed={warningsOnly} disabled={!data} onClick={() => setWarningsOnly(!warningsOnly)}>경고 있는 것만</Button>}
      />
      {!data ? <ListSkeleton /> : (
        <SettingsListSection isEmpty={items.length === 0} emptyText={warningsOnly ? "경고가 없습니다." : "항목이 없습니다."}>
          {items.map(entry => (
            <SettingsListRow
              key={entry.item.name}
              title={entry.item.name}
              meta={entry.item.description}
              selected={current?.item.name === entry.item.name}
              onSelect={() => openDetail(entry.item.name)}
              titleBadge={entry.kind === "skill" ? <SkillLintBadge skill={entry.item} reportExists={reportExists} /> : <FindingBadge findings={catalogFindings(entry.item)} />}
              footer={entry.kind === "skill" ? usageFooter(entry.item) : undefined}
            />
          ))}
        </SettingsListSection>
      )}
    </section>
  );

  return (
    <div data-testid="skill-catalog-settings" className="space-y-4">
      <div className={detailOpen ? "max-lg:hidden" : undefined}>
        {data ? <ReportHead report={data.report} verify={verify} /> : <div className="flex min-h-[var(--v3-action-size)] items-center" role="status" aria-label="보고를 불러오는 중"><span className="v3-run-skeleton v3-run-skeleton--title" /></div>}
      </div>
      <div className={`guides-kind-tabs${detailOpen ? " max-lg:hidden" : ""}`}>
        <DetailTabs<Kind> id="guide-kind" label="종류" panelId="guide-kind-panel" tabs={[["skill", "스킬"], ["catalog", "카탈로그"]]} value={kind} onChange={(next) => { setKind(next); setSelected(null); setDetailOpen(false); }} />
      </div>
      <div id="guide-kind-panel" role="tabpanel" aria-labelledby={`guide-kind-${kind}`} className="skill-catalog-panel">
        <SettingsListDetailFrame testId="skill-catalog-frame" list={list} fill detailOpen={detailOpen}>
          <div className="lg:hidden">
            <DashboardIconCap ref={backRef} size="small" label="목록으로" onClick={closeDetail}><ArrowLeft className="size-4" aria-hidden="true" /></DashboardIconCap>
          </div>
          {!data ? <DetailSkeleton />
            : !current ? <FrameNotice>{warningsOnly ? "경고가 없습니다." : "항목이 없습니다."}</FrameNotice>
              : current.kind === "skill"
                ? <SkillDetail key={current.item.name} skill={current.item} guides={data} request={request} usage={usage.get(current.item.name) ?? []} overview={overview} nodeId={nodeId} onSelect={openDetail} onSelectCatalog={(name) => { setKind("catalog"); openDetail(name); }} />
                : <CatalogDetail key={current.item.name} catalog={current.item} reportExists={reportExists} onSelect={(name) => { setKind("skill"); openDetail(name); }} />}
        </SettingsListDetailFrame>
      </div>
    </div>
  );
}
