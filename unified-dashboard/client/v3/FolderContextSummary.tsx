import { useTranslation } from "react-i18next";
import { SlidersHorizontal } from "lucide-react";
import { DashboardIconCap } from "@seosoyoung/soul-ui";

import type { AssignmentData } from "./AgentNodeAssignmentFields";
import { ContextSourceMark, useExecutionEnvironmentLabel } from "./FolderContextParts";
import type { ProjectContextInheritance } from "./project-context-inheritance";
import type { ProjectPageDetails } from "./project-page-details";

/** Read-only digest of a folder's context. Editing happens in the folder settings dialog. */
export function FolderContextSummary({ details, inherited, assignment, onOpenSettings }: {
  details: ProjectPageDetails;
  inherited: ProjectContextInheritance | null;
  assignment?: AssignmentData;
  onOpenSettings(): void;
}) {
  const { t } = useTranslation();
  const ownGuidance = details.guidance.map((item) => item.text).join("\n\n");
  const inheritedGuidance = inherited?.guidance ?? [];
  const guidance = ownGuidance || inheritedGuidance.map((item) => item.text).join("\n\n");
  const guidanceSource = ownGuidance ? null : inheritedGuidance.at(-1)?.source.folderName ?? null;
  const references = [
    ...(inherited?.atomReferences ?? [])
      .filter((reference) => !details.atomReferences.some((own) => own.instance === reference.instance && own.nodeId === reference.nodeId))
      .map((reference) => ({ key: `${reference.source.pageId}:${reference.blockId}`, title: reference.nodeTitle })),
    ...details.atomReferences.map((reference) => ({ key: reference.blockId, title: reference.nodeTitle })),
  ];
  const ownDefaults = details.sessionDefaults[0] ?? null;
  const inheritedDefaults = ownDefaults ? null : inherited?.sessionDefaults.at(-1) ?? null;
  const defaultsLabel = useExecutionEnvironmentLabel(ownDefaults ?? inheritedDefaults, assignment);
  const none = <span className="v3-context-summary-empty">{t("folders.settings.none")}</span>;
  return (
    <section className="v3-project-context" data-testid="v3-project-context">
      <div className="v3-detail-section-head">
        <h3>{t("folders.settings.context")}</h3><span className="v3-spacer" />
        <DashboardIconCap size="small" label={t("folders.settings.settings")} onClick={onOpenSettings}>
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
      <dl className="v3-context-summary">
        <div>
          <dt>{t("folders.settings.guidance")}</dt>
          <dd>{guidance ? <><span className="v3-context-summary-clamp" data-v3-selectable-content="true">{guidance}</span>{guidanceSource ? <ContextSourceMark name={guidanceSource} /> : null}</> : none}</dd>
        </div>
        <div>
          <dt>{t("folders.settings.references")}</dt>
          <dd>{references.length ? references.map((reference) => <span key={reference.key}>{reference.title}</span>) : none}</dd>
        </div>
        <div>
          <dt>{t("folders.settings.sessionDefaults")}</dt>
          <dd>{defaultsLabel ? <><span>{defaultsLabel}</span>{inheritedDefaults ? <ContextSourceMark name={inheritedDefaults.source.folderName} /> : null}</> : none}</dd>
        </div>
      </dl>
    </section>
  );
}
