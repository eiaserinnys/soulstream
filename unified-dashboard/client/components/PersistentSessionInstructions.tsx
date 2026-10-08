import { useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, Input } from "@seosoyoung/soul-ui";
import "./PersistentSessionInstructions.css";

import {
  createPersistentSessionsApi,
  PersistentSessionError,
  type PersistentInstruction,
  type PersistentSessionsApi,
} from "../lib/persistent-sessions";
import { SettingsAlert, SettingsGroupBox } from "./config/SettingsListDetail";

export type PersistentSessionInstructionsViewState = {
  instructions: PersistentInstruction[];
  loading: boolean;
  loadError: string | null;
  error: string | null;
  capReached: boolean;
  pending: boolean;
  editingId: string | null;
  editText: string;
  addText: string;
};

export type PersistentSessionInstructionsActions = {
  retry(): void;
  startEditing(instruction: PersistentInstruction): void;
  cancelEditing(): void;
  changeEditText(value: string): void;
  saveEdit(instructionId: string): void;
  remove(instructionId: string): void;
  changeAddText(value: string): void;
  add(event: FormEvent<HTMLFormElement>): Promise<boolean>;
  editKeyDown(event: KeyboardEvent<HTMLInputElement>, instructionId: string): void;
};

export function usePersistentSessionInstructions({ sessionId, api }: {
  sessionId: string;
  api: PersistentSessionsApi;
}) {
  const [instructions, setInstructions] = useState<PersistentInstruction[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capReached, setCapReached] = useState(false);
  const [pending, setPending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [addText, setAddText] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { instructions: current } = await api.listInstructions(sessionId);
      setInstructions(current);
    } catch (caught) {
      setLoadError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [api, sessionId]);

  useEffect(() => { void load(); }, [load]);

  const clearFeedback = useCallback(() => {
    setError(null);
    setCapReached(false);
  }, []);

  const startEditing = useCallback((instruction: PersistentInstruction) => {
    if (loading || pending) return;
    clearFeedback();
    setEditingId(instruction.id);
    setEditText(instruction.text);
  }, [clearFeedback, loading, pending]);

  const cancelEditing = useCallback(() => {
    setEditingId(null);
    setEditText("");
  }, []);

  const saveEdit = useCallback(async (instructionId: string) => {
    if (loading || pending) return;
    const text = editText.trim();
    setPending(true);
    clearFeedback();
    try {
      if (!text) {
        await api.updateInstruction(sessionId, instructionId, { status: "removed" });
        setInstructions((current) => current.filter((item) => item.id !== instructionId));
      } else {
        const { instruction } = await api.updateInstruction(sessionId, instructionId, { text });
        setInstructions((current) => current
          .map((item) => item.id === instructionId ? instruction : item)
          .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)));
      }
      cancelEditing();
    } catch (caught) {
      setError(`저장 실패: ${errorMessage(caught)}`);
    } finally {
      setPending(false);
    }
  }, [api, cancelEditing, clearFeedback, editText, loading, pending, sessionId]);

  const remove = useCallback(async (instructionId: string) => {
    if (loading || pending) return;
    setPending(true);
    clearFeedback();
    try {
      await api.updateInstruction(sessionId, instructionId, { status: "removed" });
      setInstructions((current) => current.filter((item) => item.id !== instructionId));
      if (editingId === instructionId) cancelEditing();
    } catch (caught) {
      setError(`삭제 실패: ${errorMessage(caught)}`);
    } finally {
      setPending(false);
    }
  }, [api, cancelEditing, clearFeedback, editingId, loading, pending, sessionId]);

  const add = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = addText.trim();
    if (loading || pending || !text) return false;
    setPending(true);
    clearFeedback();
    try {
      const { instruction } = await api.addInstruction(sessionId, text);
      setInstructions((current) => [instruction, ...current]);
      setAddText("");
      return true;
    } catch (caught) {
      if (caught instanceof PersistentSessionError && caught.code === "cap_reached") {
        setCapReached(true);
      } else {
        setError(`추가 실패: ${errorMessage(caught)}`);
      }
      return false;
    } finally {
      setPending(false);
    }
  }, [addText, api, clearFeedback, loading, pending, sessionId]);

  const state = useMemo<PersistentSessionInstructionsViewState>(() => ({
    instructions,
    loading,
    loadError,
    error,
    capReached,
    pending,
    editingId,
    editText,
    addText,
  }), [addText, capReached, editText, editingId, error, instructions, loadError, loading, pending]);

  const actions = useMemo<PersistentSessionInstructionsActions>(() => ({
    retry: () => { void load(); },
    startEditing,
    cancelEditing,
    changeEditText: (value) => { setEditText(value); clearFeedback(); },
    saveEdit: (instructionId) => { void saveEdit(instructionId); },
    remove: (instructionId) => { void remove(instructionId); },
    changeAddText: (value) => { setAddText(value); clearFeedback(); },
    add: (event) => add(event),
    editKeyDown: (event, instructionId) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        void saveEdit(instructionId);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelEditing();
      }
    },
  }), [add, cancelEditing, clearFeedback, load, remove, saveEdit, startEditing]);

  return { state, actions };
}

export function PersistentSessionInstructions({ sessionId, request = fetch }: {
  sessionId: string;
  request?: typeof fetch;
}) {
  const api = useMemo(() => createPersistentSessionsApi(request), [request]);
  const { state, actions } = usePersistentSessionInstructions({ sessionId, api });
  return <PersistentSessionInstructionsView state={state} actions={actions} />;
}

export function PersistentSessionInstructionsView({ state, actions, variant = "default" }: {
  state: PersistentSessionInstructionsViewState;
  actions: PersistentSessionInstructionsActions;
  variant?: "default" | "pas";
}) {
  if (variant === "pas") return <PersistentSessionInstructionsPasView state={state} actions={actions} />;
  const mutationDisabled = state.loading || state.pending;
  return <SettingsGroupBox title="지속 지시">
    <div data-testid="persistent-session-instructions" className="space-y-3">
      {state.loading ? <p className="text-sm text-muted-foreground">불러오는 중…</p> : null}
      {!state.loading && state.loadError ? <div className="space-y-2">
        <SettingsAlert>조회 실패: {state.loadError}</SettingsAlert>
        <Button type="button" size="sm" variant="outline" onClick={actions.retry}>다시 시도</Button>
      </div> : null}
      {!state.loading && !state.loadError && state.instructions.length === 0 ? <p className="text-sm text-muted-foreground">지속 지시 없음</p> : null}
      {state.instructions.length > 0 ? <ol className="space-y-2" aria-label="지속 지시 목록">
        {state.instructions.map((instruction) => {
          const editing = state.editingId === instruction.id;
          return <li key={instruction.id} data-testid="persistent-instruction-row">
            <SettingsGroupBox>
              <div className="min-w-0 space-y-2">
                {editing ? <Input
                  aria-label="지속 지시 수정"
                  autoFocus
                  value={state.editText}
                  disabled={mutationDisabled}
                  nativeInput
                  onChange={(event) => actions.changeEditText(event.target.value)}
                  onKeyDown={(event) => actions.editKeyDown(event, instruction.id)}
                /> : <p className="break-words text-sm text-foreground">{instruction.text}</p>}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {instruction.source_turns.length > 0 ? <span>{instruction.source_turns.join(", ")}</span> : null}
                    <time dateTime={instruction.updated_at}>{formatDate(instruction.updated_at)}</time>
                  </div>
                  <div className="flex items-center gap-2">
                    {editing ? <>
                      <Button type="button" size="sm" disabled={mutationDisabled} onClick={() => actions.saveEdit(instruction.id)}>저장</Button>
                      <Button type="button" size="sm" variant="outline" disabled={mutationDisabled} onClick={actions.cancelEditing}>취소</Button>
                    </> : <>
                      <Button type="button" size="sm" variant="outline" disabled={mutationDisabled} onClick={() => actions.startEditing(instruction)}>수정</Button>
                      <Button type="button" size="sm" variant="outline" disabled={mutationDisabled} onClick={() => actions.remove(instruction.id)}>삭제</Button>
                    </>}
                  </div>
                </div>
              </div>
            </SettingsGroupBox>
          </li>;
        })}
      </ol> : null}
      {state.error ? <SettingsAlert>{state.error}</SettingsAlert> : null}
      <form className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2" onSubmit={(event) => { void actions.add(event); }}>
        <Input
          aria-label="새 지속 지시"
          value={state.addText}
          disabled={mutationDisabled}
          nativeInput
          onChange={(event) => actions.changeAddText(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={mutationDisabled || !state.addText.trim()}>추가</Button>
      </form>
      {state.capReached ? <SettingsAlert>지속 지시 상한에 도달했습니다.</SettingsAlert> : null}
    </div>
  </SettingsGroupBox>;
}

function PersistentSessionInstructionsPasView({ state, actions }: {
  state: PersistentSessionInstructionsViewState;
  actions: PersistentSessionInstructionsActions;
}) {
  const [adding, setAdding] = useState(false);
  const mutationDisabled = state.loading || state.pending;
  const submitAdd = async (event: FormEvent<HTMLFormElement>) => {
    const saved = await actions.add(event);
    if (saved) setAdding(false);
  };
  const cancelAdd = () => {
    actions.changeAddText("");
    setAdding(false);
  };

  return <div data-testid="persistent-session-instructions" className="persistent-instructions-pas">
    <p className="persistent-instructions-description">이 세션에 계속 적용됩니다.</p>
    {state.loading ? <p className="text-sm text-muted-foreground">불러오는 중…</p> : null}
    {!state.loading && state.loadError ? <div className="space-y-2">
      <SettingsAlert>조회 실패: {state.loadError}</SettingsAlert>
      <Button type="button" size="sm" variant="outline" onClick={actions.retry}>다시 시도</Button>
    </div> : null}
    {!state.loading && !state.loadError && state.instructions.length === 0 ? <p className="text-sm text-muted-foreground">지속 지시 없음</p> : null}
    {state.instructions.length > 0 ? <ol className="persistent-instructions-pas-list" aria-label="지속 지시 목록">
      {state.instructions.map((instruction) => {
        const editing = state.editingId === instruction.id;
        const sourceTurns = instruction.source_turns ?? [];
        return <li key={instruction.id} data-testid="persistent-instruction-row">
          <div className="persistent-instructions-pas-row">
            <div className="min-w-0 space-y-2">
              {editing ? <Input
                aria-label="지속 지시 수정"
                autoFocus
                value={state.editText}
                disabled={mutationDisabled}
                nativeInput
                onChange={(event) => actions.changeEditText(event.target.value)}
                onKeyDown={(event) => actions.editKeyDown(event, instruction.id)}
              /> : <p className="persistent-instructions-pas-text">{instruction.text}</p>}
              {editing && state.error ? <SettingsAlert>{state.error}</SettingsAlert> : null}
              <div className="persistent-instructions-pas-source">
                {sourceTurns.length > 0 ? <span>{sourceTurns.join(", ")}</span> : instruction.origin === "user" ? <span>직접 추가</span> : null}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {editing ? <>
                <Button type="button" size="sm" disabled={mutationDisabled} onClick={() => actions.saveEdit(instruction.id)}>저장</Button>
                <Button type="button" size="sm" variant="outline" disabled={mutationDisabled} onClick={actions.cancelEditing}>취소</Button>
              </> : <>
                <Button type="button" size="sm" variant="outline" disabled={mutationDisabled || adding} onClick={() => actions.startEditing(instruction)}>수정</Button>
                <Button type="button" size="sm" variant="outline" disabled={mutationDisabled || adding} onClick={() => actions.remove(instruction.id)}>삭제</Button>
              </>}
            </div>
          </div>
        </li>;
      })}
    </ol> : null}
    {state.error && state.editingId === null ? <SettingsAlert>{state.error}</SettingsAlert> : null}
    {state.capReached ? <SettingsAlert>지속 지시 상한에 도달했습니다.</SettingsAlert> : null}
    {!adding ? <Button type="button" size="sm" variant="outline" className="self-start" disabled={mutationDisabled || state.editingId !== null} onClick={() => { actions.changeAddText(state.addText); setAdding(true); }}>지시 추가</Button> : <form className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2" onSubmit={(event) => { void submitAdd(event); }}>
      <Input
        aria-label="새 지속 지시"
        autoFocus
        value={state.addText}
        disabled={mutationDisabled}
        nativeInput
        onChange={(event) => actions.changeAddText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          cancelAdd();
        }}
      />
      <Button type="submit" size="sm" disabled={mutationDisabled || !state.addText.trim()}>추가</Button>
      <Button type="button" size="sm" variant="outline" disabled={mutationDisabled} onClick={cancelAdd}>취소</Button>
    </form>}
  </div>;
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString("ko-KR");
}
