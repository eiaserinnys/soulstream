import { useTranslation } from "react-i18next";
import type {
  ProjectAtomReference,
  ProjectSessionDefault,
} from "./project-page-details";

export function ProjectAtomChip({
  reference,
  onClick,
}: {
  reference: Pick<ProjectAtomReference, "nodeTitle" | "depth" | "titlesOnly" | "limit" | "mode">;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const content = <>⚛ {reference.nodeTitle} · depth {reference.depth ?? 3} · titlesOnly {(reference.titlesOnly ?? false) ? "on" : "off"}{reference.mode ? <> · {reference.mode}</> : null}{reference.limit == null ? null : t("folders.context.recentChildren", { limit: reference.limit })}</>;
  return onClick ? (
    <button type="button" className="v3-project-context-chip" onClick={onClick}>{content}</button>
  ) : (
    <span className="v3-project-context-chip">{content}</span>
  );
}

export function ProjectSessionDefaultChip({
  defaults,
  onClick,
}: {
  defaults: Pick<ProjectSessionDefault, "agentId" | "nodeId" | "modelPreset">;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const content = (
    <>
      👤 {defaults.agentId ?? t("folders.context.noAgent")}@{defaults.nodeId ?? t("folders.context.noNode")}
      {defaults.modelPreset ? t("folders.context.modelSelected") : ""}
    </>
  );
  return onClick ? (
    <button type="button" className="v3-project-context-chip" onClick={onClick}>{content}</button>
  ) : (
    <span className="v3-project-context-chip">{content}</span>
  );
}
