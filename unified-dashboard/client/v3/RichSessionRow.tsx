import { useTranslation } from "react-i18next";
import type { MouseEvent } from "react";
import {
  getSessionActivityTimestamp,
  ProfileAvatar,
  getSessionStatusLabel,
  useAgentPortraitUrlResolver,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { RunRowFrame, type RunRowAction } from "./RunRowFrame";

import { singleLinePreview, visibleSessionPreview } from "./session-preview";
import { sessionPanelTitle } from "./v3-session-panel-model";
import "./v3-run-history.css";

type Translate = ReturnType<typeof useTranslation>["t"];

export function RichSessionRow({
  session,
  runNumber = null,
  failed = false,
  nodeOffline = false,
  active = false,
  affiliation,
  preview,
  actions,
  onOpen,
  size = "default",
  onContextMenu,
}: {
  session: SessionSummary;
  size?: "default" | "small";
  runNumber?: number | null;
  failed?: boolean;
  nodeOffline?: boolean;
  active?: boolean;
  affiliation?: string | null;
  preview?: string;
  actions?: readonly RunRowAction[];
  onOpen(session: SessionSummary): void;
  onContextMenu?(session: SessionSummary, event: MouseEvent<HTMLDivElement>): void;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const formatNumber = new Intl.NumberFormat(language).format;
  const title = failed ? runNumberLabel(runNumber, t, formatNumber) : sessionPanelTitle(session, t);
  const status = failed
    ? t("sessions.lookupFailed")
    : nodeOffline
      ? t("sessions.nodeOffline")
      : getSessionStatusLabel(session.status, session.sessionType, t);
  const presentationStatus = failed ? "failed" : nodeOffline ? "offline" : session.status;
  const modelLabel = failed ? null : sessionModelLabel(session);
  const resolvePortrait = useAgentPortraitUrlResolver();
  const portraitUrl = failed ? null : sessionPortraitUrl(session, resolvePortrait);
  const visiblePreview = failed
    ? t("sessions.sessionLoadFailed")
    : preview ?? singleLinePreview(
      visibleSessionPreview(session),
      120,
    ) ?? t("sessions.noMessages");

  return <RunRowFrame
    size={size}
    active={active} failed={failed} offline={nodeOffline}
    sessionId={failed ? undefined : session.agentSessionId}
    onContextMenu={failed || !onContextMenu ? undefined : event=>onContextMenu(session,event)}
    disabled={failed} onOpen={()=>onOpen(session)}
    avatar={<ProfileAvatar role="assistant" hasPortrait={Boolean(portraitUrl)} portraitUrl={portraitUrl} fallbackEmoji="🤖"/>}
    title={<><strong>{title}</strong>{!failed && runNumber!==null ? <span className="v3-run-number">{runNumberLabel(runNumber, t, formatNumber)}</span>:null}</>}
    agentLine={<><span>{failed ? t("sessions.noSessionDetails"):session.agentName??session.agentId??t("sessions.unknownAgent")}</span>{size==="small"&&!failed?<span>{session.nodeId??t("sessions.unknownNode")}</span>:null}{modelLabel?<span title={modelLabel}>{modelLabel}</span>:null}{size!=="small"&&!failed?<span>{session.nodeId??t("sessions.unknownNode")}</span>:null}</>}
    affiliation={affiliation?<span className="v3-run-affiliation" title={affiliation}>{affiliation}</span>:null}
    preview={visiblePreview}
    status={{label:t("sessions.sessionStatus", { status }),tone:presentationStatus}}
    timestamp={failed?undefined:{display:formatRelativeSessionTime(session, t, language),raw:getSessionActivityTimestamp(session)??undefined}}
    actions={actions}
  />;
}

export function sessionModelLabel(
  session: Pick<SessionSummary, "modelLabel" | "backend">,
): string | null {
  const explicitLabel = session.modelLabel?.trim();
  if (explicitLabel) return explicitLabel;
  const backend = session.backend?.trim();
  if (!backend) return null;
  return backend
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sessionPortraitUrl(
  session: SessionSummary,
  resolvePortrait: (agentId: string | null | undefined) => string,
): string | null {
  if (session.agentPortraitUrl) return session.agentPortraitUrl;
  return resolvePortrait(session.agentId) || null;
}

function runNumberLabel(runNumber: number | null, t: Translate, formatNumber: (value: number) => string): string {
  return runNumber === null ? t("sessions.session") : t("sessions.sessionNumber", { number: formatNumber(runNumber) });
}

function formatRelativeSessionTime(session: SessionSummary, t: Translate, language: string): string {
  const value = getSessionActivityTimestamp(session);
  if (!value) return t("sessions.unknownTime");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return t("sessions.unknownTime");
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return t("sessions.justNow");
  const minutes = Math.round(elapsed / 60_000);
  const relativeTime = new Intl.RelativeTimeFormat(language);
  if (minutes < 60) return relativeTime.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relativeTime.format(-hours, "hour");
  return relativeTime.format(-Math.round(hours / 24), "day");
}
