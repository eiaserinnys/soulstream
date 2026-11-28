import { adminTranslation } from "./config/admin-translation";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  FrameLoading,
  NewSessionFolderSelector,
  useDashboardStore,
  type AgentInfo,
} from "@seosoyoung/soul-ui";

import { AgentSelectionField } from "../v3/AgentSelectionField";
import type { AssignmentData } from "../v3/AgentNodeAssignmentFields";
import { HttpResponseError } from "../lib/http-response-error";
import {
  createPersistentSessionsApi,
  PersistentSessionError,
  type PersistentCreateDefaults,
  type PersistentSession,
} from "../lib/persistent-sessions";
import { usePersistentSessionDetailsController } from "./PersistentSessionDetails";
import { PersistentSessionSettingsSections } from "./PersistentSessionSettingsSections";
import { NodeModelPresetSelect } from "./NodeModelPresetSelect";
import { SettingFieldWidget } from "./config/SettingFieldWidget";
import { agentLabel, currentModelText, textField } from "./persistent-session-fields";
import {
  SettingsAlert,
  SettingsDetailHeader,
  SettingsGroupBox,
  SettingsListDetailFrame,
  SettingsListHeader,
  SettingsListRow,
  SettingsListSection,
  SettingsMultilineField,
} from "./config/SettingsListDetail";

type Editor = {
  name: string;
  agentId: string;
  modelPreset: string;
  folderId: string;
  firstMessage: string;
};

const editorFromDefaults = (defaults: PersistentCreateDefaults | null): Editor => ({
  name: "",
  agentId: defaults?.preferred_agent_id ?? "",
  modelPreset: defaults?.settings.default_model.model_preset ?? "",
  folderId: "",
  firstMessage: "",
});

/** 입력 검증에서 막힌 경우. 서버에 도달하지 않았으므로 일부 저장 안내를 붙이지 않는다. */
class FormError extends Error {}

type Translate = ReturnType<typeof useTranslation>["t"];

/** 서버가 분명히 거절한 응답(4xx)이 아니면 요청이 처리됐는지 알 수 없다. */
const isClearRejection = (caught: unknown) => caught instanceof HttpResponseError && caught.status < 500;

export function PersistentSessionsTab({ request, assignment, initialPersistentSessionId, onSessionSaved }: {
  request?: typeof fetch;
  assignment?: AssignmentData;
  /** 처음 읽은 목록에서 이 세션을 골라 연다. 없는 id면 고르지 않는다. */
  initialPersistentSessionId?: string | null;
  /** 저장이 끝난 뒤 저장값을 바깥 화면(PAS 창)에 알린다. 목록 갱신과 표시 설정 반영은 이 탭이 이미 한다. */
  onSessionSaved?(session: PersistentSession): void;
}) {
  const { t, i18n } = useTranslation();
  const api = useMemo(() => createPersistentSessionsApi(request, i18n.t), [i18n, request]);
  const catalog = useDashboardStore((state) => state.catalog);
  const setPersistentSessionDisplaySettings = useDashboardStore((state) => state.setPersistentSessionDisplaySettings);
  const [sessions, setSessions] = useState<PersistentSession[]>([]);
  const [defaults, setDefaults] = useState<PersistentCreateDefaults | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PersistentSession | null>(null);
  const [editor, setEditor] = useState<Editor>(() => editorFromDefaults(null));
  const [agentCatalog, setAgentCatalog] = useState<{ nodeId: string; agents: AgentInfo[] } | null>(null);
  const [registration, setRegistration] = useState<{ sessionId: string; name: string } | null>(null);
  // 생성 응답을 잃어 만들어졌는지 알 수 없다. 같은 입력으로 다시 만들지 않도록 이 탭이 열려 있는 동안 막는다.
  const [createUnknown, setCreateUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; key: number } | null>(null);
  const errorKey = useRef(0);
  // 같은 문구가 다시 나와도 새 오류 상자로 그려 화면 안으로 스크롤되게 한다.
  const fail = useCallback((text: string) => { errorKey.current += 1; setError({ message: text, key: errorKey.current }); }, []);

  const initialSelection = useRef(initialPersistentSessionId ?? null);
  const refresh = useCallback(async ({ select = null, keepEditor = false }: { select?: string | null; keepEditor?: boolean } = {}) => {
    let result;
    try {
      result = await api.list();
    } catch (caught) {
      setLoadError(message(caught));
      return;
    }
    const next = select ? result.sessions.find((session) => session.session_id === select) ?? null : null;
    setLoadError(null);
    setLoaded(true);
    setSessions(result.sessions);
    setDefaults(result.create_defaults);
    setSelected(next);
    if (!keepEditor || (select && !next)) setEditor(editorFromDefaults(result.create_defaults));
  }, [api]);

  useEffect(() => {
    const select = initialSelection.current;
    initialSelection.current = null;
    void refresh({ select });
  }, [refresh]);

  const nodeId = defaults?.node_id ?? "";
  useEffect(() => {
    if (!nodeId || selected !== null || agentCatalog?.nodeId === nodeId) return;
    let active = true;
    void api.listAgents(nodeId)
      .then((agents) => { if (active) setAgentCatalog({ nodeId, agents }); })
      .catch((caught: unknown) => { if (active) fail(message(caught)); });
    return () => { active = false; };
  }, [api, fail, nodeId, selected, agentCatalog?.nodeId]);

  const startCreate = () => {
    setSelected(null);
    setEditor(editorFromDefaults(defaults));
    setRegistration(null);
    setError(null);
  };

  /** 서버가 돌려준 저장값으로 목록과 입력을 갱신한다. */
  const applySaved = useCallback((session: PersistentSession) => {
    setSessions((current) => current.some((item) => item.session_id === session.session_id)
      ? current.map((item) => item.session_id === session.session_id ? session : item)
      : [...current, session]);
    setSelected(session);
    setRegistration(null);
    setError(null);
    setPersistentSessionDisplaySettings(session.session_id, session.settings);
    onSessionSaved?.(session);
  }, [onSessionSaved, setPersistentSessionDisplaySettings]);

  const mutate = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      fail(caught instanceof FormError || isClearRejection(caught) ? message(caught) : `${message(caught)} ${t("jobs.persistent.partialSave")}`);
      if (caught instanceof PersistentSessionError && caught.code === "NOT_PERSISTENT") {
        void refresh({ select: selected?.session_id ?? null, keepEditor: true });
      }
    } finally {
      setBusy(false);
    }
  };

  const validName = () => {
    const name = editor.name.trim();
    if (!name) throw new FormError(t("jobs.persistent.missingName"));
    return name;
  };
  const defaultModelWrite = () => {
    if (!editor.modelPreset) throw new FormError(t("jobs.persistent.missingDefaultModel"));
    return { default_model: { model_preset: editor.modelPreset, reasoning_effort: null } };
  };

  const details = usePersistentSessionDetailsController({
    resource: selected,
    api,
    onSaved: applySaved,
    onNotPersistent: () => { void refresh({ select: selected?.session_id ?? null, keepEditor: true }); },
  });

  const choose = (session: PersistentSession) => {
    if (selected?.session_id === session.session_id) details.resetDraft();
    setSelected(session);
    setRegistration(null);
    setError(null);
  };

  const create = () => mutate(async () => {
    if (!editor.agentId) throw new FormError(t("jobs.persistent.missingAgent"));
    if (!editor.folderId) throw new FormError(t("jobs.persistent.missingCreationFolder"));
    const display_name = validName();
    const input = {
      display_name,
      agent_id: editor.agentId,
      folder_id: editor.folderId,
      initial_instruction: editor.firstMessage.trim(),
      settings: defaultModelWrite(),
    };
    try {
      const { session } = await api.create(input);
      applySaved(session);
    } catch (caught) {
      if (caught instanceof PersistentSessionError && caught.createdSession) {
        setRegistration({ sessionId: caught.createdSession.session_id, name: caught.createdSession.display_name ?? display_name });
      } else if (isClearRejection(caught)) {
        throw caught;
      } else {
        setCreateUnknown(true);
      }
    }
  });

  const retryRegistration = () => mutate(async () => {
    if (!registration) return;
    const { session } = await api.update(registration.sessionId, { display_name: validName(), enabled: true, settings: defaultModelWrite() });
    applySaved(session);
  });

  const release = async () => {
    if (!selected || !confirmPersistentSessionRelease(selected.display_name ?? t("jobs.persistent.unnamed"), t)) return;
    await mutate(async () => {
      await api.update(selected.session_id, { enabled: false });
      await refresh();
    });
  };

  const agents = agentCatalog?.nodeId === nodeId ? agentCatalog.agents : [];
  const modelPresetCatalog = assignment?.modelPresetCatalog;
  // 소유 노드를 모르는 세션은 서버가 아무것도 저장하지 못한다. 생성 기본 노드로 대신하지 않고 편집을 막는다.
  const nodeUnknown = Boolean(selected && !selected.node_id);
  const modelNodeId = selected ? selected.node_id ?? "" : nodeId;
  const modelSelect = <NodeModelPresetSelect
    className="v3-model-preset-field"
    triggerClassName="v3-model-preset-trigger"
    nodeId={modelNodeId}
    value={editor.modelPreset}
    label={t("jobs.common.defaultModel")}
    disabled={busy || nodeUnknown}
    modelPresetCatalog={modelPresetCatalog}
    onValueChange={(modelPreset) => setEditor((current) => ({ ...current, modelPreset }))}
    onError={fail}
  />;
  const nameField = <SettingFieldWidget
    field={textField("display_name", t("jobs.persistent.name"), editor.name, nodeUnknown)}
    value={editor.name}
    onChange={(name) => setEditor((current) => ({ ...current, name }))}
  />;

  return (
    <SettingsListDetailFrame testId="persistent-sessions-tab" list={<>
      <SettingsListHeader
        title={t("jobs.persistent.title")}
        description={t("jobs.persistent.list")}
        actions={<>
          <Button type="button" size="sm" variant="outline" data-testid="persistent-sessions-refresh" onClick={() => void refresh({ select: selected?.session_id ?? null, keepEditor: true })}>{t("jobs.common.refresh")}</Button>
          <Button type="button" size="sm" variant="outline" onClick={startCreate}>{t("jobs.persistent.newSession")}</Button>
        </>}
      />
      {loadError ? <div className="mb-4 space-y-2">
        <SettingsAlert><span data-v3-selectable-content="true">{loadError}</span></SettingsAlert>
        <Button type="button" size="sm" variant="outline" onClick={() => void refresh({ select: selected?.session_id ?? null, keepEditor: true })}>{t("jobs.common.retry")}</Button>
      </div> : null}
      {loaded ? <SettingsListSection isEmpty={sessions.length === 0} emptyText={t("jobs.persistent.empty")}>
        {sessions.map((session) => <SettingsListRow
          key={session.session_id}
          title={session.display_name ?? t("jobs.persistent.unnamed")}
          meta={`${agentLabel(session, t)} · ${currentModelText(session, t)}`}
          selected={selected?.session_id === session.session_id}
          onSelect={() => choose(session)}
        />)}
      </SettingsListSection> : loadError ? null : <FrameLoading inline label={t("jobs.common.loading")} />}
    </>}>
      {selected || defaults ? <SettingsDetailHeader selectableTitle={Boolean(selected)}
        title={selected ? selected.display_name ?? t("jobs.persistent.unnamed") : t("jobs.persistent.newPersistentSession")}
        actions={selected ? <Button type="button" size="sm" variant="outline" disabled={busy || details.pending || nodeUnknown} onClick={() => void release()}>{t("jobs.persistent.release")}</Button> : null}
      /> : null}

      {error && !selected ? <SettingsAlert key={error.key} scrollIntoView><span data-v3-selectable-content="true">{error.message}</span></SettingsAlert> : null}

      {selected ? <PersistentSessionSettingsSections
        key={selected.session_id}
        resource={selected}
        api={api}
        request={request}
        details={details}
        localError={error?.message ?? null}
        busy={busy}
        modelPresetCatalog={modelPresetCatalog}
      /> : defaults ? <>
        {defaults.unavailable_reason ? <SettingsAlert><span data-v3-selectable-content="true">{defaults.unavailable_reason}</span></SettingsAlert> : null}
        {registration ? <SettingsAlert scrollIntoView><span data-v3-selectable-content="true">{t("jobs.persistent.registrationFailed", { name: registration.name })}</span></SettingsAlert> : null}
        {createUnknown ? <SettingsAlert scrollIntoView><span data-v3-selectable-content="true">{t("jobs.persistent.creationUnknown")}</span></SettingsAlert> : null}
        <div>
          {nameField}
          <SettingFieldWidget field={textField("node", t("jobs.persistent.node"), nodeId, true)} value={nodeId} onChange={() => undefined} />
        </div>
        <SettingsGroupBox title={t("jobs.common.executionTarget")}>
          <div className="v3-succession-assignment">
            <AgentSelectionField
              agents={agents}
              value={editor.agentId}
              presentation="session"
              disabled={busy || Boolean(registration)}
              onChange={(agentId) => setEditor((current) => ({ ...current, agentId }))}
            />
            {modelSelect}
          </div>
        </SettingsGroupBox>
        <SettingsGroupBox>
          <NewSessionFolderSelector
            folders={catalog?.folders ?? []}
            selectedFolderId={editor.folderId || null}
            onFolderChange={(folderId) => setEditor((current) => ({ ...current, folderId: folderId ?? "" }))}
            label={t("jobs.persistent.creationFolder")}
            placeholder={t("jobs.common.selectFolder")}
          />
        </SettingsGroupBox>
        <SettingsMultilineField
          label={t("jobs.persistent.firstMessage")}
          value={editor.firstMessage}
          placeholder={defaults.initial_instruction}
          onChange={(firstMessage) => setEditor((current) => ({ ...current, firstMessage }))}
        />
        <div className="flex flex-wrap gap-2">
          {createUnknown
            ? <Button type="button" size="sm" variant="outline" onClick={() => void refresh({ keepEditor: true })}>{t("jobs.persistent.reloadList")}</Button>
            : registration
              ? <Button type="button" size="sm" disabled={busy} onClick={() => void retryRegistration()}>{busy ? t("jobs.persistent.registering") : t("jobs.persistent.retryRegistration")}</Button>
              : <Button type="button" size="sm" disabled={busy || !editor.modelPreset} onClick={() => void create()}>{busy ? t("jobs.persistent.adding") : t("jobs.persistent.addSession")}</Button>}
        </div>
      </> : null}
    </SettingsListDetailFrame>
  );
}

function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }

export function confirmPersistentSessionRelease(name: string, t: Translate = adminTranslation()) {
  return window.confirm(t("jobs.persistent.confirmRelease", { name }));
}
