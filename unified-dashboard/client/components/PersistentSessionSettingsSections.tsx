import { useState, type ReactNode } from "react";
import { SessionStoryDisclosure } from "@seosoyoung/soul-ui";

import type { PersistentSession, PersistentSessionsApi } from "../lib/persistent-sessions";
import type { NodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import { PersistentSessionDetails, type usePersistentSessionDetailsController } from "./PersistentSessionDetails";
import { PersistentSessionInstructionsView, usePersistentSessionInstructions } from "./PersistentSessionInstructions";
import { PersistentSessionMonitoringView, usePersistentSessionMonitoring } from "./PersistentSessionMonitoring";
import { SettingsAlert } from "./config/SettingsListDetail";

function Section({ name, label, children }: { name: string; label: string; children: ReactNode }) {
  return <section aria-label={label} data-section={name} className="space-y-2 border-t border-border pt-4">
    <h4 className="text-sm font-semibold">{label}</h4>
    {children}
  </section>;
}

/**
 * 선택한 영구 세션의 설정 상세. 예전 설정 대화창이 다섯 절로 보이던 것을 한 칸에 차례로 쌓는다.
 * 저장은 두 곳이 같은 컨트롤러를 쓴다: 이름과 모델은 변경 저장, 표시 항목은 누르는 즉시 저장.
 */
export function PersistentSessionSettingsSections({ resource, api, request, details, localError, busy, modelPresetCatalog }: {
  resource: PersistentSession;
  api: PersistentSessionsApi;
  request?: typeof fetch;
  details: ReturnType<typeof usePersistentSessionDetailsController>;
  /** 이 상세 밖(해제 등)에서 난 오류. 계정 절에만 보인다. */
  localError?: string | null;
  busy: boolean;
  modelPresetCatalog?: NodeModelPresetCatalog;
}) {
  const monitoring = usePersistentSessionMonitoring({ sessionId: resource.session_id, nodeId: resource.node_id ?? "", request });
  const instructions = usePersistentSessionInstructions({ sessionId: resource.session_id, api });
  const [modelError, setModelError] = useState<string | null>(null);
  const pending = busy || details.pending;
  const common = {
    resource,
    draft: details.draft,
    pending,
    savingDisplayField: details.savingDisplayField,
    errorScope: details.errorScope,
    modelPresetCatalog,
    onFieldChange: details.onFieldChange,
    onSave: () => { void details.save(); },
  };
  return <div className="space-y-4" data-testid="persistent-session-settings-sections">
    <Section name="instructions" label="지속 지시">
      <PersistentSessionInstructionsView variant="pas" state={instructions.state} actions={instructions.actions} />
    </Section>
    <Section name="account" label="계정과 모델">
      <PersistentSessionDetails
        {...common}
        section="account"
        error={details.error ?? localError ?? null}
        weeklyAvailability={monitoring.modelPresets}
        onModelError={setModelError}
      />
      {modelError ? <SettingsAlert><span data-v3-selectable-content="true">{modelError}</span></SettingsAlert> : null}
    </Section>
    <Section name="display" label="표시와 모션">
      <PersistentSessionDetails {...common} section="display" error={details.errorScope === "display" ? details.error : null} immediateDisplaySave />
    </Section>
    <Section name="record" label="기록">
      <PersistentSessionDetails {...common} section="record" error={null} monitoring={<PersistentSessionMonitoringView state={monitoring} />} />
    </Section>
    <Section name="story" label="세션 스토리">
      <SessionStoryDisclosure sessionId={resource.session_id} mode="settings" request={request} />
    </Section>
  </div>;
}
