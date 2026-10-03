import { AtomNodeSelector } from "@seosoyoung/soul-ui";

import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";

export interface ProjectAtomFieldValue {
  instance: "atom" | "atom-nl";
  nodeId: string;
  nodeTitle: string;
  depth: number;
  titlesOnly: boolean;
  limit?: number | null;
  mode?: "full" | "index" | "titles";
}

export function ProjectAtomFields({
  request,
  value,
  disabled,
  onChange,
  selectorOpen, onSelectorOpenChange, onSelectorStatusChange, supportsLimit = true,
}: {
  request?: typeof fetch;
  supportsLimit?: boolean;
  selectorOpen?: boolean;
  onSelectorOpenChange?(open: boolean): void;
  onSelectorStatusChange?(status: "loading" | "ready" | "error"): void;
  value: ProjectAtomFieldValue;
  disabled: boolean;
  onChange(value: ProjectAtomFieldValue): void;
}) {
  return (
    <div className="v3-project-context-fields">
      <label>
        atom 인스턴스
        <span>{value.instance}</span>
        <small>현재 노드 탐색은 atom만 지원합니다. 기존 atom-nl 자료의 연결은 유지합니다.</small>
      </label>
      <label>
        atom 노드
        <AtomNodeSelector request={request}
          value={value.nodeId}
          selectedTitle={value.nodeTitle}
          disabled={disabled || value.instance !== "atom"}
          open={selectorOpen}
          onOpenChange={onSelectorOpenChange}
          onStatusChange={onSelectorStatusChange}
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
      {supportsLimit ? <label>
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
      </label> : null}
      <label>
        렌더 방식
        <select
          aria-label="atom 렌더 방식"
          value={value.mode ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const mode = event.target.value as "" | "full" | "index" | "titles";
            const next = { ...value, mode: mode || undefined };
            if (!next.mode) delete next.mode;
            onChange(next);
          }}
        >
          <option value="">기존 방식</option>
          <option value="full">전체 본문</option>
          <option value="index">색인</option>
          <option value="titles">제목 트리</option>
        </select>
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
  assignment,
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
  assignment?: import("./AgentNodeAssignmentFields").AssignmentData;
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
      <AgentNodeAssignmentFields data={assignment}
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

export function isProjectAtomValid(value: ProjectAtomFieldValue): boolean {
  return !!value.nodeId.trim() && Number.isInteger(value.depth) && value.depth >= 1 && value.depth <= 5
    && (value.limit == null || (Number.isInteger(value.limit) && value.limit > 0))
    && (value.mode === undefined || ["full", "index", "titles"].includes(value.mode));
}
