import { useTranslation } from "react-i18next";
import type { AgentInfo } from "@seosoyoung/soul-ui";
import { CatalogSelectionField } from "../components/CatalogSelectionField";

/** The operational agent field, with its catalog supplied by the owner. */
export function AgentSelectionField({ agents, value, disabled, presentation, onChange }: {
  agents: readonly AgentInfo[];
  value: string;
  disabled: boolean;
  presentation: "session" | "execution-defaults";
  onChange(value: string): void;
}) {
  const { t } = useTranslation();
  return <CatalogSelectionField className="v3-assignment-field" value={value} disabled={disabled}
    label={presentation === "session" ? t("agents.agent") : t("agents.assignment.executionAgent")}
    ariaLabel={presentation === "session" ? t("agents.assignment.chooseAgent") : t("agents.assignment.defaultAgent")}
    selectedLabel={agents.find(agent => agent.id === value)?.name ?? (value || t("agents.unassigned"))}
    options={[{ value: "", label: t("agents.unassigned") }, ...agents.map(agent => ({ value: agent.id, label: agent.name ?? agent.id }))]}
    onValueChange={onChange}/>;
}
