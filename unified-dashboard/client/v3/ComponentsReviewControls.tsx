import { useState } from "react";
import type { AgentInfo } from "@seosoyoung/soul-ui";
import { AgentSelectionField } from "./AgentSelectionField";
import { NodeModelPresetSelect } from "../components/NodeModelPresetSelect";
import { SettingFieldWidget, type SettingField } from "../components/config/SettingFieldWidget";
import type { NodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import "./v3-context-succession.css";

const agents: AgentInfo[] = [{ id: "roselin", name: "로젤린" }, { id: "seosoyoung", name: "서소영" }];
const catalog: NodeModelPresetCatalog = {
  nodeId: "components-local", status: "ready", presets: [
    { id: "sol", label: "Sol", backend: "codex", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false },
    { id: "exhausted-sol", label: "Sol (사용량 소진 예시)", backend: "codex", available: true, reason: "quota_exhausted", reason_label: "7일 사용량 제한", resets_at: null, usage_warning: false },
    { id: "unavailable", label: "사용 불가 샘플", backend: "codex", available: false, reason: "disabled", reason_label: "사용 불가", resets_at: null, usage_warning: false },
  ],
};
const fields: SettingField[] = [
  { key: "sample-text", field_name: "sample-text", label: "입력", description: "설정 화면에서 사용하는 문자열 입력입니다.", value: "샘플 값", value_type: "str", sensitive: false, hot_reloadable: true, read_only: false },
  { key: "sample-toggle", field_name: "sample-toggle", label: "토글", description: "켜짐과 꺼짐을 확인합니다.", value: true, value_type: "bool", sensitive: false, hot_reloadable: true, read_only: false },
  { key: "sample-sensitive", field_name: "sample-sensitive", label: "마스킹", description: "샘플 값의 숨김과 표시를 확인합니다.", value: "샘플 비밀값", value_type: "str", sensitive: true, hot_reloadable: false, read_only: false },
  { key: "sample-readonly", field_name: "sample-readonly", label: "읽기 전용", description: "비활성 입력 상태입니다.", value: "변경 불가", value_type: "str", sensitive: false, hot_reloadable: false, read_only: true },
];

/** Real fields with local catalogs and callbacks; no settings or session mutations. */
export function ComponentsReviewControls() {
  const [agent, setAgent] = useState("roselin");
  const [model, setModel] = useState("sol");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(field => [field.key, String(field.value)])));
  return <div className="v3-components-samples" data-testid="components-review-controls">
    <div className="v3-components-sample">
      <p className="v3-components-label">AgentSelectionField · 지정 / 미지정 / 비활성</p>
      <div className="v3-succession-assignment">
        <AgentSelectionField agents={agents} value={agent} presentation="session" disabled={false} onChange={setAgent}/>
        <AgentSelectionField agents={agents} value="" presentation="execution-defaults" disabled onChange={() => undefined}/>
        <NodeModelPresetSelect nodeId={catalog.nodeId} value={model} label="실행 모델" className="v3-model-preset-field"
          triggerClassName="v3-model-preset-trigger" modelPresetCatalog={catalog} onValueChange={setModel}/>
      </div>
    </div>
    <div className="v3-components-sample">
      <p className="v3-components-label">SettingFieldWidget · 입력 / 토글 / 마스킹 / 읽기 전용</p>
      {fields.map(field => <SettingFieldWidget key={field.key} field={field} value={values[field.key]}
        onChange={value => setValues(current => ({ ...current, [field.key]: value }))}/>)}
    </div>
  </div>;
}
