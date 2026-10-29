import { useRef, type ReactNode } from "react";
import { DashboardIconCap, ThemeToggle, cn, useGlassSurface, useLiquidLens } from "@seosoyoung/soul-ui";
import { Search, UserRound } from "lucide-react";
import { ConfigButton } from "../components/ConfigButton";
import { DetailTabs } from "./DetailTabs";
import {
  LIMIT_REMAINING_WARNING, NODE_USAGE_WARNING, type FrontPageLimit, type FrontPageNode,
} from "./front-page-model";
import "./persistent-session-screen.css";
import "./v3-front-page.css";

/** 1면과 카드 상세가 함께 쓰는 부품. 상단 메뉴, 유리 상자, 기계 막대. */
export type FrontTab = "front" | "cards" | "record" | "projects";
export const FRONT_TABS = [["front", "1면"], ["cards", "카드"], ["record", "기록"], ["projects", "프로젝트"]] as const;

/** 사진 배경에서는 유리, 종이 배경에서는 바탕 없는 같은 상자. */
export function GlassBox({ glass, capsule = false, className, children, ...props }: {
  glass: boolean; capsule?: boolean; className: string; children: ReactNode; id?: string; role?: string; "aria-labelledby"?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const webglActive = useGlassSurface(ref, { enabled: glass });
  useLiquidLens(ref, { scale: 18, enabled: glass && capsule && !webglActive });
  return <div {...props} ref={ref}
    className={cn(className, glass && "border border-glass-border glass-strong glass-chrome lg-rim", glass && capsule && "dashboard-toolbar-cap")}
    data-liquid-glass-webgl={webglActive ? "true" : undefined}>
    {children}
  </div>;
}

/** 상시 GNB. 이름, 위쪽 탭, 검색, 설정, 테마, 계정. */
export function FrontPageGnb({ glass, idPrefix, panelId, tab, onTab, onOpenSearch, onOpenConfig }: {
  glass: boolean; idPrefix: string; panelId: string; tab: FrontTab; onTab(tab: FrontTab): void;
  onOpenSearch?(): void; onOpenConfig?(): void;
}) {
  return <header className="v3-front-gnb">
    <GlassBox glass={glass} className="v3-front-brand" capsule>
      <span>소울스트림</span>
    </GlassBox>
    <GlassBox glass={glass} className="v3-front-tabs" capsule>
      <DetailTabs<FrontTab> id={idPrefix} label="화면" panelId={panelId} variant="card" tabs={FRONT_TABS} value={tab} onChange={onTab} />
    </GlassBox>
    <GlassBox glass={glass} className="v3-front-actions" capsule>
      <DashboardIconCap appearance="bare" label="검색" onClick={onOpenSearch}>
        <Search className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      </DashboardIconCap>
      <ConfigButton variant="chrome" appearance="bare" onClick={() => onOpenConfig?.()} />
      <ThemeToggle variant="chrome" appearance="bare" />
      <DashboardIconCap appearance="bare" label="계정">
        <UserRound className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      </DashboardIconCap>
    </GlassBox>
  </header>;
}

function Meter({ label, value, warning }: { label: string; value: number; warning: boolean }) {
  const clamped = Math.max(0, Math.min(100, value));
  return <span className={cn("persistent-session-weekly-usage-track v3-front-meter", warning && "is-warning")}
    role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)}>
    <i style={{ width: `${clamped}%` }} />
  </span>;
}

/** 노드 사용률과 모델 한도. 숫자 없이 막대 길이로만 보인다. */
export function Machines({ nodes, limits }: { nodes: readonly FrontPageNode[]; limits: readonly FrontPageLimit[] }) {
  return <div className="v3-front-machines">
    <div className="v3-front-machine v3-front-machine-legend" aria-hidden="true">
      <span />
      <span>CPU</span><span>메모리</span><span>디스크</span>
    </div>
    {nodes.map(node => <div key={node.id} className="v3-front-machine" title={node.id}>
      <span className="v3-front-machine-name">{node.label}</span>
      <Meter label={`${node.label} CPU`} value={node.cpu} warning={node.cpu >= NODE_USAGE_WARNING} />
      <Meter label={`${node.label} 메모리`} value={node.mem} warning={node.mem >= NODE_USAGE_WARNING} />
      <Meter label={`${node.label} 디스크`} value={node.disk} warning={node.disk >= NODE_USAGE_WARNING} />
    </div>)}
    <div className="v3-front-limits">
      {limits.map(limit => <div key={limit.name} className="v3-front-machine v3-front-limit">
        <span className="v3-front-machine-name">{limit.name}</span>
        {limit.rejected
          ? <span className="v3-front-limit-rejected">한도 거부</span>
          : <Meter label={`${limit.name} 남은 한도`} value={limit.remaining} warning={limit.remaining < LIMIT_REMAINING_WARNING} />}
      </div>)}
    </div>
  </div>;
}
