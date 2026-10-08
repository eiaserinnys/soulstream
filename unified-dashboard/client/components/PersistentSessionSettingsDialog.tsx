import "./config/config-layout.css";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  SessionStoryDisclosure,
  useDashboardStore,
} from "@seosoyoung/soul-ui";

import { createPersistentSessionsApi, type PersistentSession } from "../lib/persistent-sessions";
import type { NodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import { ConfigCategoryNav, type ConfigCategoryNavItem } from "./config/ConfigCategoryNav";
import { SettingsAlert } from "./config/SettingsListDetail";
import {
  PersistentSessionDetails,
  usePersistentSessionDetailsController,
  type PersistentSessionDetailsSection,
} from "./PersistentSessionDetails";
import { usePersistentSessionMonitoring, PersistentSessionMonitoringView } from "./PersistentSessionMonitoring";
import { PersistentSessionInstructionsView, usePersistentSessionInstructions } from "./PersistentSessionInstructions";
import { V3_CARD_GAP_PX } from "../v3/v3-layout-metrics";

const categories: ConfigCategoryNavItem[] = [
  { name: "instructions", label: "지속 지시" },
  { name: "account", label: "계정과 모델" },
  { name: "display", label: "표시와 모션" },
  { name: "record", label: "기록" },
  { name: "story", label: "세션 스토리" },
];
type PersistentSessionSettingsSection = PersistentSessionDetailsSection | "story";

export function PersistentSessionSettingsDialog({
  sessionId,
  nodeId,
  onClose,
  onSaved: onSessionSaved,
  request = fetch,
  modelPresetCatalog,
}: {
  sessionId: string;
  nodeId: string;
  onClose(): void;
  onSaved?(session: PersistentSession): void;
  request?: typeof fetch;
  modelPresetCatalog?: NodeModelPresetCatalog;
}) {
  const api = useMemo(() => createPersistentSessionsApi(request), [request]);
  const [resource, setResource] = useState<PersistentSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [selectedSection, setSelectedSection] = useState<PersistentSessionSettingsSection>("instructions");
  const setPersistentSessionDisplaySettings = useDashboardStore((state) => state.setPersistentSessionDisplaySettings);
  const monitoring = usePersistentSessionMonitoring({ sessionId, nodeId, request });
  const instructions = usePersistentSessionInstructions({ sessionId, api });

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { session } = await api.get(sessionId);
      setResource(session);
    } catch (caught) {
      setLoadError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [api, sessionId]);

  useEffect(() => { void load(); }, [load]);

  const onSaved = useCallback((session: PersistentSession) => {
    setResource(session);
    setPersistentSessionDisplaySettings(session.session_id, session.settings);
    onSessionSaved?.(session);
  }, [onSessionSaved, setPersistentSessionDisplaySettings]);
  const details = usePersistentSessionDetailsController({
    resource,
    api,
    onSaved,
    onNotPersistent: () => { void load(); },
  });
  const activeLabel = categories.find((category) => category.name === selectedSection)?.label ?? categories[0]!.label;

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPopup className="approved-dialog config-dialog persistent-session-settings-popup max-w-5xl" closeProps={{ "aria-label": "설정 닫기" }} data-testid="persistent-session-settings-dialog" style={{ "--v3-card-gap": `${V3_CARD_GAP_PX}px` } as CSSProperties}>
      <DialogHeader>
        <DialogTitle>설정</DialogTitle>
        <DialogDescription className="sr-only">
          {resource ? `설정 대상: ${resource.display_name}, ${resource.agent_name ?? resource.agent_id ?? "에이전트 정보 없음"}` : null}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="config-dialog-panel" scrollable={false} scrollFade={false}>
        {resource ? <div className="config-layout" data-layout="pas">
          <ConfigCategoryNav
            categories={categories}
            activeCategory={selectedSection}
            variant="pas"
            onSelect={(name) => setSelectedSection(name as PersistentSessionSettingsSection)}
          />
          <section className="config-detail" aria-label={activeLabel}>
            <header className="config-detail-heading"><h2>{activeLabel}</h2></header>
            <div className="config-detail-scroll v3-session-panel-scroll">
              <div hidden={selectedSection === "instructions" || selectedSection === "story"}>
                <PersistentSessionDetails
                  resource={resource}
                  draft={details.draft}
                  pending={details.pending}
                  savingDisplayField={details.savingDisplayField}
                  error={details.error}
                  errorScope={details.errorScope}
                  section={selectedSection === "display" || selectedSection === "record" ? selectedSection : "account"}
                  immediateDisplaySave
                  modelPresetCatalog={modelPresetCatalog}
                  weeklyAvailability={monitoring.modelPresets}
                  monitoring={<PersistentSessionMonitoringView state={monitoring} />}
                  onFieldChange={details.onFieldChange}
                  onSave={() => { void details.save(); }}
                  onModelError={setModelError}
                />
                {modelError && selectedSection === "account" ? <SettingsAlert>{modelError}</SettingsAlert> : null}
              </div>
              <div hidden={selectedSection !== "instructions"}>
                <PersistentSessionInstructionsView variant="pas" state={instructions.state} actions={instructions.actions} />
              </div>
              {selectedSection === "story" ? <SessionStoryDisclosure sessionId={sessionId} mode="settings" request={request} /> : null}
            </div>
          </section>
        </div> : <div className="config-detail">
          {loading ? <p className="text-sm text-muted-foreground">불러오는 중…</p> : null}
          {loadError ? <div className="space-y-2"><SettingsAlert>{loadError}</SettingsAlert><Button type="button" size="sm" variant="outline" onClick={() => void load()}>다시 시도</Button></div> : null}
        </div>}
      </DialogPanel>
    </DialogPopup>
  </Dialog>;
}

function errorMessage(value: unknown) { return value instanceof Error ? value.message : String(value); }
