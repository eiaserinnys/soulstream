import { AtomNodeSelector } from "@seosoyoung/soul-ui";

import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";

export interface ProjectAtomFieldValue {
  instance: "atom" | "atom-nl";
  nodeId: string;
  nodeTitle: string;
  depth: number;
  titlesOnly: boolean;
  limit?: number | null;
}

export function ProjectAtomFields({
  value,
  disabled,
  onChange,
}: {
  value: ProjectAtomFieldValue;
  disabled: boolean;
  onChange(value: ProjectAtomFieldValue): void;
}) {
  return (
    <div className="v3-project-context-fields">
      <label>
        atom 인스턴스
        <select
          value={value.instance}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, instance: event.target.value as "atom" | "atom-nl" })}
        >
          <option value="atom">atom</option>
          <option value="atom-nl">atom-nl</option>
        </select>
      </label>
      <label>
        atom 노드
        <AtomNodeSelector
          value={value.nodeId}
          selectedTitle={value.nodeTitle}
          disabled={disabled}
          onChange={(nodeId, nodeTitle) => onChange({ ...value, nodeId, nodeTitle })}
        />
      </label>
      <label>
        깊이
        <input
          type="number"
          min={1}
          max={5}
          value={value.depth}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, depth: Number(event.target.value) })}
        />
      </label>
      <label>
        최근 자식 수
        <input
          type="number"
          min={1}
          value={value.limit ?? ""}
          placeholder="전체"
          aria-label="atom 최근 자식 수"
          disabled={disabled}
          onChange={(event) => onChange({
            ...value,
            limit: event.target.value === "" ? null : Number(event.target.value),
          })}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={value.titlesOnly}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, titlesOnly: event.target.checked })}
        />
        제목만 포함
      </label>
    </div>
  );
}

export function ProjectSessionDefaultsFields({
  agentId,
  nodeId,
  modelPreset,
  disabled,
  onAgentIdChange,
  onNodeIdChange,
  onModelPresetChange,
  onModelPresetValidityChange,
  onError,
}: {
  agentId: string;
  nodeId: string;
  modelPreset: string;
  disabled: boolean;
  onAgentIdChange(agentId: string): void;
  onNodeIdChange(nodeId: string): void;
  onModelPresetChange(modelPreset: string): void;
  onModelPresetValidityChange?(valid: boolean): void;
  onError(message: string): void;
}) {
  return (
    <div className="v3-project-context-fields">
      <AgentNodeAssignmentFields
        agentId={agentId}
        nodeId={nodeId}
        modelPreset={modelPreset}
        disabled={disabled}
        onAgentIdChange={onAgentIdChange}
        onNodeIdChange={onNodeIdChange}
        onModelPresetChange={onModelPresetChange}
        onModelPresetValidityChange={onModelPresetValidityChange}
        onError={onError}
      />
    </div>
  );
}
