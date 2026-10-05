import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
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
import { NodeModelPresetSelect } from "./NodeModelPresetSelect";
import { SettingFieldWidget, type SettingField } from "./config/SettingFieldWidget";
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

const editorFromSession = (session: PersistentSession): Editor => ({
  name: session.display_name ?? "",
  agentId: session.agent_id,
  modelPreset: session.settings.default_model.model_preset ?? "",
  folderId: session.folder_id ?? "",
  firstMessage: "",
});

const editorFromDefaults = (defaults: PersistentCreateDefaults | null): Editor => ({
  name: "",
  agentId: defaults?.preferred_agent_id ?? "",
  modelPreset: defaults?.settings.default_model.model_preset ?? "",
  folderId: "",
  firstMessage: "",
});

/** 입력 검증에서 막힌 경우. 서버에 도달하지 않았으므로 일부 저장 안내를 붙이지 않는다. */
class FormError extends Error {}

const PARTIAL_SAVE_NOTE = "일부 변경이 저장됐을 수 있습니다. 다시 읽거나 저장해 주세요.";
const LOST_CREATE_NOTE = "세션이 일반 세션으로 만들어졌을 수 있습니다. 목록을 다시 읽거나 세션 목록에서 확인하세요.";

export function PersistentSessionsTab({ request, assignment }: { request?: typeof fetch; assignment?: AssignmentData }) {
  const api = useMemo(() => createPersistentSessionsApi(request), [request]);
  const catalog = useDashboardStore((state) => state.catalog);
  const [sessions, setSessions] = useState<PersistentSession[]>([]);
  const [defaults, setDefaults] = useState<PersistentCreateDefaults | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PersistentSession | null>(null);
  const [editor, setEditor] = useState<Editor>(() => editorFromDefaults(null));
  const [agentCatalog, setAgentCatalog] = useState<{ nodeId: string; agents: AgentInfo[] } | null>(null);
  const [registration, setRegistration] = useState<{ sessionId: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (!keepEditor || (select && !next)) setEditor(next ? editorFromSession(next) : editorFromDefaults(result.create_defaults));
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const nodeId = defaults?.node_id ?? "";
  useEffect(() => {
    if (!nodeId || selected !== null || agentCatalog?.nodeId === nodeId) return;
    let active = true;
    void api.listAgents(nodeId)
      .then((agents) => { if (active) setAgentCatalog({ nodeId, agents }); })
      .catch((caught: unknown) => { if (active) setError(message(caught)); });
    return () => { active = false; };
  }, [api, nodeId, selected, agentCatalog?.nodeId]);

  const startCreate = () => {
    setSelected(null);
    setEditor(editorFromDefaults(defaults));
    setRegistration(null);
    setError(null);
  };

  const choose = (session: PersistentSession) => {
    setSelected(session);
    setEditor(editorFromSession(session));
    setRegistration(null);
    setError(null);
  };

  /** 서버가 돌려준 저장값으로 목록과 입력을 갱신한다. */
  const applySaved = (session: PersistentSession) => {
    setSessions((current) => current.some((item) => item.session_id === session.session_id)
      ? current.map((item) => item.session_id === session.session_id ? session : item)
      : [...current, session]);
    setSelected(session);
    setEditor(editorFromSession(session));
    setRegistration(null);
  };

  const mutate = async (action: () => Promise<void>, uncertainNote: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      const rejected = caught instanceof FormError || (caught instanceof HttpResponseError && caught.status < 500);
      setError(rejected ? message(caught) : `${message(caught)} ${uncertainNote}`);
      if (caught instanceof PersistentSessionError && caught.code === "NOT_PERSISTENT") {
        void refresh({ select: selected?.session_id ?? null, keepEditor: true });
      }
    } finally {
      setBusy(false);
    }
  };

  const validName = () => {
    const name = editor.name.trim();
    if (!name) throw new FormError("세션 이름을 입력하세요.");
    return name;
  };
  const defaultModelWrite = () => {
    if (!editor.modelPreset) throw new FormError("기본 모델을 선택하세요.");
    const saved = selected?.settings.default_model;
    // 선택을 그대로 두면 기록된 추론 수준을 보존하고, 새 선택은 서버가 카탈로그 기본값을 정한다.
    const reasoning = saved && saved.model_preset === editor.modelPreset ? saved.reasoning_effort : null;
    return { default_model: { model_preset: editor.modelPreset, reasoning_effort: reasoning } };
  };

  const save = () => mutate(async () => {
    if (!selected) return;
    const { session } = await api.update(selected.session_id, { display_name: validName(), settings: defaultModelWrite() });
    applySaved(session);
  }, PARTIAL_SAVE_NOTE);

  const create = () => mutate(async () => {
    if (!editor.agentId) throw new FormError("에이전트를 선택하세요.");
    if (!editor.folderId) throw new FormError("생성 폴더를 선택하세요.");
    const display_name = validName();
    try {
      const { session } = await api.create({
        display_name,
        agent_id: editor.agentId,
        folder_id: editor.folderId,
        initial_instruction: editor.firstMessage.trim(),
        settings: defaultModelWrite(),
      });
      applySaved(session);
    } catch (caught) {
      if (caught instanceof PersistentSessionError && caught.createdSession) {
        setRegistration({ sessionId: caught.createdSession.session_id, name: caught.createdSession.display_name ?? display_name });
        return;
      }
      throw caught;
    }
  }, LOST_CREATE_NOTE);

  const retryRegistration = () => mutate(async () => {
    if (!registration) return;
    const { session } = await api.update(registration.sessionId, { display_name: validName(), enabled: true, settings: defaultModelWrite() });
    applySaved(session);
  }, PARTIAL_SAVE_NOTE);

  const release = async () => {
    if (!selected || !confirmPersistentSessionRelease(selected.display_name ?? "이름 없음")) return;
    await mutate(async () => {
      await api.update(selected.session_id, { enabled: false });
      await refresh();
    }, PARTIAL_SAVE_NOTE);
  };

  const agents = agentCatalog?.nodeId === nodeId ? agentCatalog.agents : [];
  const modelPresetCatalog = assignment?.modelPresetCatalog;
  const modelNodeId = selected?.node_id ?? nodeId;
  const savedModel = selected?.settings.default_model.model_preset ?? null;
  const resaveNeeded = Boolean(
    selected && savedModel
    && savedModel !== selected.runtime.current_model.model_preset
    && selected.runtime.pending?.target_model_preset !== savedModel,
  );

  const modelSelect = <NodeModelPresetSelect
    className="v3-model-preset-field"
    triggerClassName="v3-model-preset-trigger"
    nodeId={modelNodeId}
    value={editor.modelPreset}
    label="기본 모델"
    disabled={busy}
    modelPresetCatalog={modelPresetCatalog}
    onValueChange={(modelPreset) => setEditor((current) => ({ ...current, modelPreset }))}
    onError={(next) => setError(next)}
  />;
  const nameField = <SettingFieldWidget
    field={textField("display_name", "세션 이름", editor.name, false)}
    value={editor.name}
    onChange={(name) => setEditor((current) => ({ ...current, name }))}
  />;

  return (
    <SettingsListDetailFrame testId="persistent-sessions-tab" list={<>
      <SettingsListHeader
        title="영구 세션"
        description="등록된 세션 목록"
        actions={<>
          <Button type="button" size="sm" variant="outline" data-testid="persistent-sessions-refresh" onClick={() => void refresh({ select: selected?.session_id ?? null, keepEditor: true })}>새로고침</Button>
          <Button type="button" size="sm" variant="outline" onClick={startCreate}>새 세션</Button>
        </>}
      />
      {loadError ? <div className="mb-4 space-y-2">
        <SettingsAlert>{loadError}</SettingsAlert>
        <Button type="button" size="sm" variant="outline" onClick={() => void refresh({ select: selected?.session_id ?? null, keepEditor: true })}>다시 시도</Button>
      </div> : null}
      {loaded ? <SettingsListSection isEmpty={sessions.length === 0} emptyText="등록된 영구 에이전트 세션이 없습니다.">
        {sessions.map((session) => <SettingsListRow
          key={session.session_id}
          title={session.display_name ?? "이름 없음"}
          meta={`${session.agent_name ?? session.agent_id} · ${currentModelText(session)}`}
          selected={selected?.session_id === session.session_id}
          onSelect={() => choose(session)}
        />)}
      </SettingsListSection> : loadError ? null : <p className="px-2 py-1 text-xs text-muted-foreground">불러오는 중…</p>}
    </>}>
      <SettingsDetailHeader
        title={selected ? selected.display_name ?? "이름 없음" : "새 영구 에이전트 세션"}
        actions={selected ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void release()}>영구 세션 해제</Button> : null}
      />

      {error ? <SettingsAlert>{error}</SettingsAlert> : null}

      {selected ? <>
        <div>
          {nameField}
          <SettingFieldWidget field={textField("agent", "에이전트", selected.agent_name ?? selected.agent_id, true, "만든 뒤에는 바꿀 수 없습니다.")} value={selected.agent_name ?? selected.agent_id} onChange={() => undefined} />
          <SettingFieldWidget field={textField("current_model", "현재 실행 모델", currentModelText(selected), true)} value={currentModelText(selected)} onChange={() => undefined} />
          <SettingFieldWidget
            field={textField("pending", "대기 중인 변경", pendingText(selected), true, resaveNeeded ? "기본 모델 변경 요청이 없습니다. 다시 저장해 주세요." : "")}
            value={pendingText(selected)}
            onChange={() => undefined}
          />
        </div>
        <SettingsGroupBox title="실행 대상"><div className="v3-succession-assignment">{modelSelect}</div></SettingsGroupBox>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>{busy ? "저장 중..." : "변경 저장"}</Button>
        </div>
      </> : defaults ? <>
        {defaults.unavailable_reason ? <SettingsAlert>{defaults.unavailable_reason}</SettingsAlert> : null}
        {registration ? <SettingsAlert>세션은 만들어졌으나 등록하지 못했습니다. “{registration.name}” 세션이 일반 세션으로 남아 있습니다.</SettingsAlert> : null}
        <div>
          {nameField}
          <SettingFieldWidget field={textField("node", "노드", nodeId, true)} value={nodeId} onChange={() => undefined} />
        </div>
        <SettingsGroupBox title="실행 대상">
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
            label="생성 폴더"
            placeholder="폴더를 선택하세요"
          />
        </SettingsGroupBox>
        <SettingsMultilineField
          label="첫 메시지 (선택)"
          value={editor.firstMessage}
          placeholder={defaults.initial_instruction}
          onChange={(firstMessage) => setEditor((current) => ({ ...current, firstMessage }))}
        />
        <div className="flex flex-wrap gap-2">
          {registration
            ? <Button type="button" size="sm" disabled={busy} onClick={() => void retryRegistration()}>{busy ? "등록 중..." : "등록 다시 시도"}</Button>
            : <Button type="button" size="sm" disabled={busy || !editor.modelPreset} onClick={() => void create()}>{busy ? "추가 중..." : "세션 추가"}</Button>}
        </div>
      </> : null}
    </SettingsListDetailFrame>
  );
}

function textField(key: string, label: string, value: string, readOnly: boolean, description = ""): SettingField {
  return { key, field_name: key, label, description, value, value_type: "str", sensitive: false, hot_reloadable: true, read_only: readOnly };
}

function currentModelText(session: PersistentSession): string {
  const { model_preset, model, reasoning_effort } = session.runtime.current_model;
  const parts = [model ?? model_preset, reasoning_effort].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "모델 정보 없음";
}

function pendingText(session: PersistentSession): string {
  const pending = session.runtime.pending;
  if (!pending) return "대기 변경 없음";
  return `다음 실행부터 ${pending.target_model_preset}${pending.target_reasoning_effort ? ` · ${pending.target_reasoning_effort}` : ""}`;
}

function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }

export function confirmPersistentSessionRelease(name: string) {
  return window.confirm(`“${name}” 영구 세션을 해제할까요? 세션과 대화 기록은 남습니다.`);
}
