// 「스킬과 카탈로그」 탭의 상세: 스킬은 본문 / 연결 / 쓰이는 곳 / 검증, 카탈로그는 축, 구성, 쓰는 스킬, 진단.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Badge, Button, ContextContentRenderer, DashboardIconCap, FrameLoading, FrameNotice, useAtomPublicUrl } from "@seosoyoung/soul-ui";

import { DetailTabs } from "../../v3/DetailTabs";
import { SettingsDetailHeader, SettingsGroupBox } from "../config/SettingsListDetail";
import {
  conditionText, fetchSkillBody, listText, worstFinding,
  type CatalogGuide, type GuideFinding, type LinkKind, type OverviewState, type SkillGuide, type SkillGuides, type SkillUsage,
} from "../../lib/skill-guides";
import { FindingCodeBadge, ProfileInitial, howLabel } from "./GuideParts";

type Pane = "body" | "links" | "usage" | "verify";

function Retry({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <FrameNotice>
      <div className="flex flex-col items-center gap-3">
        <p role="alert" className="text-sm text-destructive-foreground">{message}</p>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>다시 시도</Button>
      </div>
    </FrameNotice>
  );
}

export function SkillDetail({ skill, guides, request, usage, overview, nodeId, onSelect, onSelectCatalog }: {
  skill: SkillGuide;
  guides: SkillGuides;
  request: typeof fetch;
  usage: readonly SkillUsage[];
  overview: { state: OverviewState; reload(): void };
  nodeId: string;
  onSelect(name: string): void;
  onSelectCatalog(name: string): void;
}) {
  const [pane, setPane] = useState<Pane>("body");
  const atomBaseUrl = useAtomPublicUrl();
  const worst = skill.lint ? worstFinding(skill.lint.findings) : null;
  const tabs: Array<readonly [Pane, ReactNode]> = [
    ["body", "본문"], ["links", "연결"], ["usage", "쓰이는 곳"],
    ["verify", worst && worst.level !== "info" ? <>검증<Badge variant={worst.level === "error" ? "error" : "warning"} size="sm">{worst.count}</Badge></> : "검증"],
  ];
  return (
    <>
      <SettingsDetailHeader
        title={skill.name}
        selectableTitle
        inlineActions
        subtitle={skill.description}
        actions={atomBaseUrl ? <DashboardIconCap size="small" label="atom에서 열기" onClick={() => window.open(`${atomBaseUrl}/#${skill.body_node_id}`, "_blank", "noopener")}><ExternalLink className="size-4" aria-hidden="true" /></DashboardIconCap> : null}
      />
      <div className="guides-detail-tabs">
        <DetailTabs<Pane> id="guide-detail" label="스킬 보기" panelId="guide-detail-panel" tabs={tabs} value={pane} onChange={setPane} />
      </div>
      <div id="guide-detail-panel" role="tabpanel" aria-labelledby={`guide-detail-${pane}`} className={pane === "body" ? "flex min-h-0 flex-1 flex-col gap-3" : "min-h-0 flex-1 space-y-3 overflow-y-auto"}>
        {pane === "body" ? <BodyPane name={skill.name} request={request} />
          : pane === "links" ? <LinksPane skill={skill} guides={guides} onSelect={onSelect} onSelectCatalog={onSelectCatalog} />
            : pane === "usage" ? <UsagePane usage={usage} overview={overview} nodeId={nodeId} />
              : <VerifyPane skill={skill} reportExists={guides.report !== null} />}
      </div>
    </>
  );
}

function BodyPane({ name, request }: { name: string; request: typeof fetch }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; markdown: string } | { status: "error" }>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        setState({ status: "ready", markdown: await fetchSkillBody(request, name, controller.signal) });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    })();
    return () => controller.abort();
  }, [request, name, attempt]);
  if (state.status === "loading") return <FrameLoading label="본문을 불러오는 중..." />;
  if (state.status === "error") return <Retry message="본문을 읽지 못했습니다." onRetry={() => setAttempt(value => value + 1)} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-v3-selectable-content="true">
      <ContextContentRenderer content={state.markdown} fill />
    </div>
  );
}

interface LinkRow { kind: LinkKind | null; name: string; targetKind: "skill" | "catalog" | null }

function LinksPane({ skill, guides, onSelect, onSelectCatalog }: { skill: SkillGuide; guides: SkillGuides; onSelect(name: string): void; onSelectCatalog(name: string): void }) {
  const descriptions = useMemo(() => new Map<string, string>([
    ...guides.skills.map(item => [item.name, item.description] as const),
    ...guides.catalogs.map(item => [item.name, item.description] as const),
  ]), [guides]);
  const incoming = useMemo<LinkRow[]>(() => {
    const rows: LinkRow[] = guides.skills.flatMap(other => (other.lint?.links ?? [])
      .filter(link => link.target === skill.name)
      .map(link => ({ kind: link.kind, name: other.name, targetKind: "skill" as const })));
    // 종류를 모르는 옛 보고는 called_by 이름만 있다.
    for (const name of skill.lint?.called_by ?? []) if (!rows.some(row => row.name === name)) rows.push({ kind: null, name, targetKind: "skill" });
    return rows;
  }, [guides, skill]);
  if (!skill.lint) return <FrameNotice>보고에 없음</FrameNotice>;
  const row = (link: LinkRow, key: string) => (
    <li key={key}>
      <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-floor px-2 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => link.targetKind === "catalog" ? onSelectCatalog(link.name) : onSelect(link.name)}>
        {link.kind && <Badge variant="outline" size="sm">{link.kind}</Badge>}
        <span className="min-w-0 max-w-[60%] shrink-0 truncate font-medium">{link.name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{descriptions.get(link.name) ?? ""}</span>
      </button>
    </li>
  );
  return (
    <>
      <SettingsGroupBox title="나가는 연결">
        {skill.lint.links.length === 0 ? <p className="text-xs text-muted-foreground">없음</p>
          : <ul>{skill.lint.links.map(link => row({ kind: link.kind, name: link.target, targetKind: link.target_kind }, `${link.kind}:${link.target}`))}</ul>}
      </SettingsGroupBox>
      <SettingsGroupBox title="들어오는 연결">
        {incoming.length === 0 ? <p className="text-xs text-muted-foreground">없음</p>
          : <ul>{incoming.map(link => row(link, `${link.kind}:${link.name}`))}</ul>}
      </SettingsGroupBox>
    </>
  );
}

function UsagePane({ usage, overview, nodeId }: { usage: readonly SkillUsage[]; overview: { state: OverviewState; reload(): void }; nodeId: string }) {
  if (!nodeId) return <FrameNotice>연결된 노드가 없습니다.</FrameNotice>;
  if (overview.state.status === "loading") return <FrameLoading label="프로필을 모으는 중..." />;
  if (overview.state.status === "error") return <Retry message="프로필을 모으지 못했습니다." onRetry={overview.reload} />;
  if (usage.length === 0) return <FrameNotice>상시 목록에 넣은 프로필이 없습니다.</FrameNotice>;
  return (
    <ul className="space-y-2" data-testid="skill-guide-usage">
      {usage.map(item => {
        const condition = conditionText(item.appliesWhen);
        return (
          <li key={`${item.profileId}:${item.origin}:${item.sourceTitle}:${item.how}`} className="flex min-w-0 items-center gap-3 rounded-floor border border-border bg-muted/10 px-3 py-2">
            <ProfileInitial name={item.profileName} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium" data-v3-selectable-content="true">{item.profileName}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {[item.origin, [item.sourceParent, item.sourceTitle].filter(Boolean).join(" / "), condition || "항상"].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className={`shrink-0 whitespace-nowrap text-xs ${item.how === "body" ? "" : "text-muted-foreground"}`}>{howLabel(item.how)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function FindingList({ findings }: { findings: readonly GuideFinding[] }) {
  if (findings.length === 0) return <FrameNotice>진단이 없습니다.</FrameNotice>;
  return (
    <ul className="space-y-2" data-testid="skill-guide-findings">
      {findings.map((finding, index) => (
        <li key={index} className="flex min-w-0 items-start gap-2 rounded-floor border border-border px-3 py-2 text-sm">
          <FindingCodeBadge finding={finding} />
          <p className="min-w-0" data-v3-selectable-content="true" style={{ wordBreak: "keep-all", overflowWrap: "anywhere" }}>{finding.message}</p>
        </li>
      ))}
    </ul>
  );
}

function VerifyPane({ skill, reportExists }: { skill: SkillGuide; reportExists: boolean }) {
  if (!reportExists) return <FrameNotice>검증 보고 없음</FrameNotice>;
  if (!skill.lint) return <FrameNotice>보고에 없음</FrameNotice>;
  return <FindingList findings={skill.lint.findings} />;
}

export function CatalogDetail({ catalog, reportExists, onSelect }: { catalog: CatalogGuide; reportExists: boolean; onSelect(name: string): void }) {
  const lint = catalog.lint;
  const atomBaseUrl = useAtomPublicUrl();
  const axis = listText(lint?.axis);
  const composition = listText(lint?.composition);
  const group = (title: string, lines: string[]) => (
    <SettingsGroupBox title={title}>
      {lines.length === 0 ? <p className="text-xs text-muted-foreground">없음</p> : (
        <ul className="space-y-1">{lines.map(line => <li key={line} className="text-sm" data-v3-selectable-content="true" style={{ wordBreak: "keep-all", overflowWrap: "anywhere" }}>{line}</li>)}</ul>
      )}
    </SettingsGroupBox>
  );
  return (
    <>
      <SettingsDetailHeader
        title={catalog.name}
        selectableTitle
        inlineActions
        subtitle={catalog.description}
        actions={atomBaseUrl && catalog.node_id ? <DashboardIconCap size="small" label="atom에서 열기" onClick={() => window.open(`${atomBaseUrl}/#${catalog.node_id}`, "_blank", "noopener")}><ExternalLink className="size-4" aria-hidden="true" /></DashboardIconCap> : null}
      />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {!lint ? <FrameNotice>{reportExists ? "보고에 없음" : "검증 보고 없음"}</FrameNotice> : (
          <>
            {group("축", axis)}
            {group("구성", composition)}
            <SettingsGroupBox title="쓰는 스킬">
              {lint.used_by.length === 0 ? <p className="text-xs text-muted-foreground">없음</p> : (
                <ul>
                  {lint.used_by.map(name => (
                    <li key={name}>
                      <button type="button" className="w-full min-w-0 truncate rounded-floor px-2 py-1 text-left text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(name)}>{name}</button>
                    </li>
                  ))}
                </ul>
              )}
            </SettingsGroupBox>
            <SettingsGroupBox title="진단"><FindingList findings={lint.findings} /></SettingsGroupBox>
          </>
        )}
      </div>
    </>
  );
}
