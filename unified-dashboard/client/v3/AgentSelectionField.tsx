import { useId } from "react";
import type { AgentInfo } from "@seosoyoung/soul-ui";

/** The operational agent field, with its catalog supplied by the owner. */
export function AgentSelectionField({ agents, value, disabled, presentation, onChange }: {
  agents: readonly AgentInfo[];
  value: string;
  disabled: boolean;
  presentation: "session" | "execution-defaults";
  onChange(value: string): void;
}) {
  const id = useId();
  return <div className="v3-assignment-field">
    <label htmlFor={id}>{presentation === "session" ? "에이전트" : "실행 에이전트"}</label>
    <select id={id} value={value} disabled={disabled}
      aria-label={presentation === "session" ? "에이전트 선택" : "기본 실행 에이전트"}
      onChange={event => onChange(event.target.value)}>
      <option value="">미지정</option>
      {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name ?? agent.id}</option>)}
    </select>
  </div>;
}
