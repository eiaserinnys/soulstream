import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  return (
    <FrameNotice>
      <div className="flex flex-col items-center gap-3">
        <p role="alert" className="text-sm text-destructive-foreground">{message}</p>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t("agents.retry")}</Button>
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
  const { t, i18n } = useTranslation();
  const [pane, setPane] = useState<Pane>("body");
  const atomBaseUrl = useAtomPublicUrl();
  const worst = skill.lint ? worstFinding(skill.lint.findings) : null;
  const tabs: Array<readonly [Pane, ReactNode]> = [
    ["body", t("agents.skill.body")], ["links", t("agents.skill.links")], ["usage", t("agents.skill.usage")],
    ["verify", worst && worst.level !== "info" ? <>{t("agents.skill.verify")}<Badge variant={worst.level === "error" ? "error" : "warning"} size="sm">{worst.count.toLocaleString(i18n.resolvedLanguage)}</Badge></> : t("agents.skill.verify")],
  ];
  return (
    <>
      <SettingsDetailHeader
        title={skill.name}
        selectableTitle
        inlineActions
        clampSubtitle
        subtitle={skill.description}
        actions={atomBaseUrl ? <DashboardIconCap size="small" label={t("agents.openInAtom")} onClick={() => window.open(`${atomBaseUrl}/#${skill.body_node_id}`, "_blank", "noopener")}><ExternalLink className="size-4" aria-hidden="true" /></DashboardIconCap> : null}
      />
      <div className="guides-detail-tabs">
        <DetailTabs<Pane> id="guide-detail" label={t("agents.skill.views")} panelId="guide-detail-panel" tabs={tabs} value={pane} onChange={setPane} />
      </div>
      <div id="guide-detail-panel" role="tabpanel" aria-labelledby={`guide-detail-${pane}`} data-pane={pane} className={pane === "body" ? "flex min-h-0 flex-1 flex-col gap-3" : "min-h-0 flex-1 space-y-3 overflow-y-auto"}>
        {pane === "body" ? <BodyPane name={skill.name} request={request} />
          : pane === "links" ? <LinksPane skill={skill} guides={guides} onSelect={onSelect} onSelectCatalog={onSelectCatalog} />
            : pane === "usage" ? <UsagePane usage={usage} overview={overview} nodeId={nodeId} />
              : <VerifyPane skill={skill} reportExists={guides.report !== null} />}
      </div>
    </>
  );
}

function BodyPane({ name, request }: { name: string; request: typeof fetch }) {
  const { t } = useTranslation();
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
  if (state.status === "loading") return <FrameLoading label={t("agents.skill.loadingBody")} />;
  if (state.status === "error") return <Retry message={t("agents.skill.readError")} onRetry={() => setAttempt(value => value + 1)} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-v3-selectable-content="true">
      <ContextContentRenderer content={state.markdown} fill />
    </div>
  );
}

interface LinkRow { kind: LinkKind | null; name: string; targetKind: "skill" | "catalog" | null }

function LinksPane({ skill, guides, onSelect, onSelectCatalog }: { skill: SkillGuide; guides: SkillGuides; onSelect(name: string): void; onSelectCatalog(name: string): void }) {
  const { t } = useTranslation();
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
  if (!skill.lint) return <FrameNotice>{t("agents.report.notListed")}</FrameNotice>;
  const row = (link: LinkRow, key: string) => (
    // 눌림 바탕만 상자 안쪽 여백으로 내고(-mx-2 px-2) 글은 묶음 제목 시작선에 맞춘다. 종류 배지는 같은 폭 칸에 둔다.
    <li key={key} className="-mx-2">
      <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-floor px-2 py-0.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => link.targetKind === "catalog" ? onSelectCatalog(link.name) : onSelect(link.name)}>
        <span className="flex w-16 shrink-0">{link.kind && <Badge variant="outline" size="sm">{link.kind}</Badge>}</span>
        <span className="min-w-0 max-w-[60%] shrink-0 truncate font-medium">{link.name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{descriptions.get(link.name) ?? ""}</span>
      </button>
    </li>
  );
  return (
    <>
      <SettingsGroupBox title={t("agents.skill.outgoingLinks")}>
        {skill.lint.links.length === 0 ? <p className="text-xs text-muted-foreground">{t("agents.none")}</p>
          : <ul>{skill.lint.links.map(link => row({ kind: link.kind, name: link.target, targetKind: link.target_kind }, `${link.kind}:${link.target}`))}</ul>}
      </SettingsGroupBox>
      <SettingsGroupBox title={t("agents.skill.incomingLinks")}>
        {incoming.length === 0 ? <p className="text-xs text-muted-foreground">{t("agents.none")}</p>
          : <ul>{incoming.map(link => row(link, `${link.kind}:${link.name}`))}</ul>}
      </SettingsGroupBox>
    </>
  );
}

function UsagePane({ usage, overview, nodeId }: { usage: readonly SkillUsage[]; overview: { state: OverviewState; reload(): void }; nodeId: string }) {
  const { t } = useTranslation();
  if (!nodeId) return <FrameNotice>{t("agents.assignment.noNodes")}</FrameNotice>;
  if (overview.state.status === "loading") return <FrameLoading label={t("agents.overview.loading")} />;
  if (overview.state.status === "error") return <Retry message={t("agents.overview.error")} onRetry={overview.reload} />;
  if (usage.length === 0) return <FrameNotice>{t("agents.skill.noUsage")}</FrameNotice>;
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
                {[item.origin, [item.sourceParent, item.sourceTitle].filter(Boolean).join(" / "), condition || t("agents.always")].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className={`shrink-0 whitespace-nowrap text-xs ${item.how === "body" ? "" : "text-muted-foreground"}`}>{howLabel(item.how, t)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function FindingList({ findings }: { findings: readonly GuideFinding[] }) {
  const { t } = useTranslation();
  if (findings.length === 0) return <FrameNotice>{t("agents.finding.empty")}</FrameNotice>;
  return (
    <ul className="space-y-2" data-testid="skill-guide-findings">
      {findings.map((finding, index) => (
        <li key={index} className="flex min-w-0 items-start gap-2 rounded-floor border border-border px-3 py-2 text-sm">
          <FindingCodeBadge finding={finding} />
          <p className="min-w-0" data-v3-selectable-content="true" style={{ wordBreak: "var(--locale-word-break, keep-all)", overflowWrap: "anywhere" }}>{finding.message}</p>
        </li>
      ))}
    </ul>
  );
}

function VerifyPane({ skill, reportExists }: { skill: SkillGuide; reportExists: boolean }) {
  const { t } = useTranslation();
  if (!reportExists) return <FrameNotice>{t("agents.report.empty")}</FrameNotice>;
  if (!skill.lint) return <FrameNotice>{t("agents.report.notListed")}</FrameNotice>;
  return <FindingList findings={skill.lint.findings} />;
}

export function CatalogDetail({ catalog, reportExists, onSelect }: { catalog: CatalogGuide; reportExists: boolean; onSelect(name: string): void }) {
  const { t } = useTranslation();
  const lint = catalog.lint;
  const atomBaseUrl = useAtomPublicUrl();
  const axis = listText(lint?.axis);
  const composition = listText(lint?.composition);
  const group = (title: string, lines: string[]) => (
    <SettingsGroupBox title={title}>
      {lines.length === 0 ? <p className="text-xs text-muted-foreground">{t("agents.none")}</p> : (
        <ul className="space-y-1">{lines.map(line => <li key={line} className="text-sm" data-v3-selectable-content="true" style={{ wordBreak: "var(--locale-word-break, keep-all)", overflowWrap: "anywhere" }}>{line}</li>)}</ul>
      )}
    </SettingsGroupBox>
  );
  return (
    <>
      <SettingsDetailHeader
        title={catalog.name}
        selectableTitle
        inlineActions
        clampSubtitle
        subtitle={catalog.description}
        actions={atomBaseUrl && catalog.node_id ? <DashboardIconCap size="small" label={t("agents.openInAtom")} onClick={() => window.open(`${atomBaseUrl}/#${catalog.node_id}`, "_blank", "noopener")}><ExternalLink className="size-4" aria-hidden="true" /></DashboardIconCap> : null}
      />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {!lint ? <FrameNotice>{reportExists ? t("agents.report.notListed") : t("agents.report.empty")}</FrameNotice> : (
          <>
            {group(t("agents.catalog.axes"), axis)}
            {group(t("agents.catalog.composition"), composition)}
            <SettingsGroupBox title={t("agents.catalog.usedBy")}>
              {lint.used_by.length === 0 ? <p className="text-xs text-muted-foreground">{t("agents.none")}</p> : (
                <ul>
                  {lint.used_by.map(name => (
                    <li key={name} className="-mx-2">
                      <button type="button" className="block w-full min-w-0 truncate rounded-floor px-2 py-0.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(name)}>{name}</button>
                    </li>
                  ))}
                </ul>
              )}
            </SettingsGroupBox>
            <SettingsGroupBox title={t("agents.finding.label")}><FindingList findings={lint.findings} /></SettingsGroupBox>
          </>
        )}
      </div>
    </>
  );
}
