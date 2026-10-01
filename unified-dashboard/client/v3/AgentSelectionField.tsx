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
  return <CatalogSelectionField className="v3-assignment-field" value={value} disabled={disabled}
    label={presentation === "session" ? "에이전트" : "실행 에이전트"}
    ariaLabel={presentation === "session" ? "에이전트 선택" : "기본 실행 에이전트"}
    selectedLabel={agents.find(agent => agent.id === value)?.name ?? (value || "미지정")}
    options={[{ value: "", label: "미지정" }, ...agents.map(agent => ({ value: agent.id, label: agent.name ?? agent.id }))]}
    onValueChange={onChange}/>;
}
