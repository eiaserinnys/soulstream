import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, FrameLoading, Input } from "@seosoyoung/soul-ui";
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
  const { t } = useTranslation();
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
      setError(t("jobs.instructions.saveError", { detail: errorMessage(caught) }));
    } finally {
      setPending(false);
    }
  }, [api, cancelEditing, clearFeedback, editText, loading, pending, sessionId, t]);

  const remove = useCallback(async (instructionId: string) => {
    if (loading || pending) return;
    setPending(true);
    clearFeedback();
    try {
      await api.updateInstruction(sessionId, instructionId, { status: "removed" });
      setInstructions((current) => current.filter((item) => item.id !== instructionId));
      if (editingId === instructionId) cancelEditing();
    } catch (caught) {
      setError(t("jobs.instructions.deleteError", { detail: errorMessage(caught) }));
    } finally {
      setPending(false);
    }
  }, [api, cancelEditing, clearFeedback, editingId, loading, pending, sessionId, t]);

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
        setError(t("jobs.instructions.addError", { detail: errorMessage(caught) }));
      }
      return false;
    } finally {
      setPending(false);
    }
  }, [addText, api, clearFeedback, loading, pending, sessionId, t]);

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
  const { i18n } = useTranslation();
  const api = useMemo(() => createPersistentSessionsApi(request, i18n.t), [i18n, request]);
  const { state, actions } = usePersistentSessionInstructions({ sessionId, api });
  return <PersistentSessionInstructionsView state={state} actions={actions} />;
}

export function PersistentSessionInstructionsView({ state, actions, variant = "default" }: {
  state: PersistentSessionInstructionsViewState;
  actions: PersistentSessionInstructionsActions;
  variant?: "default" | "pas";
}) {
  const { t, i18n } = useTranslation();
  if (variant === "pas") return <PersistentSessionInstructionsPasView state={state} actions={actions} />;
  const mutationDisabled = state.loading || state.pending;
  return <SettingsGroupBox title={t("jobs.instructions.title")}>
    <div data-testid="persistent-session-instructions" className="space-y-3">
      {state.loading ? <FrameLoading inline label={t("jobs.common.loading")} /> : null}
      {!state.loading && state.loadError ? <div className="space-y-2">
        <SettingsAlert><span data-v3-selectable-content="true">{t("jobs.common.fetchError", { detail: state.loadError })}</span></SettingsAlert>
        <Button type="button" size="sm" variant="outline" onClick={actions.retry}>{t("jobs.common.retry")}</Button>
      </div> : null}
      {!state.loading && !state.loadError && state.instructions.length === 0 ? <p className="text-sm text-muted-foreground">{t("jobs.instructions.empty")}</p> : null}
      {state.instructions.length > 0 ? <ol className="space-y-2" aria-label={t("jobs.instructions.list")}>
        {state.instructions.map((instruction) => {
          const editing = state.editingId === instruction.id;
          return <li key={instruction.id} data-testid="persistent-instruction-row">
            <SettingsGroupBox>
              <div className="min-w-0 space-y-2">
                {editing ? <Input
                  aria-label={t("jobs.instructions.edit")}
                  autoFocus
                  value={state.editText}
                  disabled={mutationDisabled}
                  nativeInput
                  onChange={(event) => actions.changeEditText(event.target.value)}
                  onKeyDown={(event) => actions.editKeyDown(event, instruction.id)}
                /> : <p className="break-words text-sm text-foreground" data-v3-selectable-content="true">{instruction.text}</p>}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {instruction.source_turns.length > 0 ? <span data-v3-selectable-content="true">{instruction.source_turns.join(", ")}</span> : null}
                    <time data-v3-selectable-content="true" dateTime={instruction.updated_at}>{formatDate(instruction.updated_at, i18n.resolvedLanguage)}</time>
                  </div>
                  <div className="flex items-center gap-2">
                    {editing ? <>
                      <Button type="button" size="sm" disabled={mutationDisabled} onClick={() => actions.saveEdit(instruction.id)}>{t("jobs.common.save")}</Button>
                      <Button type="button" size="sm" variant="outline" disabled={mutationDisabled} onClick={actions.cancelEditing}>{t("jobs.common.cancel")}</Button>
                    </> : <>
                      <Button type="button" size="sm" variant="outline" disabled={mutationDisabled} onClick={() => actions.startEditing(instruction)}>{t("jobs.common.edit")}</Button>
                      <Button type="button" size="sm" variant="outline" disabled={mutationDisabled} onClick={() => actions.remove(instruction.id)}>{t("jobs.common.delete")}</Button>
                    </>}
                  </div>
                </div>
              </div>
            </SettingsGroupBox>
          </li>;
        })}
      </ol> : null}
      {state.error ? <SettingsAlert><span data-v3-selectable-content="true">{state.error}</span></SettingsAlert> : null}
      <form className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2" onSubmit={(event) => { void actions.add(event); }}>
        <Input
          aria-label={t("jobs.instructions.new")}
          value={state.addText}
          disabled={mutationDisabled}
          nativeInput
          onChange={(event) => actions.changeAddText(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={mutationDisabled || !state.addText.trim()}>{t("jobs.common.add")}</Button>
      </form>
      {state.capReached ? <SettingsAlert><span data-v3-selectable-content="true">{t("jobs.instructions.limit")}</span></SettingsAlert> : null}
    </div>
  </SettingsGroupBox>;
}

function PersistentSessionInstructionsPasView({ state, actions }: {
  state: PersistentSessionInstructionsViewState;
  actions: PersistentSessionInstructionsActions;
}) {
  const { t } = useTranslation();
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
    <p className="persistent-instructions-description">{t("jobs.instructions.help")}</p>
    {state.loading ? <FrameLoading inline label={t("jobs.common.loading")} /> : null}
    {!state.loading && state.loadError ? <div className="space-y-2">
      <SettingsAlert><span data-v3-selectable-content="true">{t("jobs.common.fetchError", { detail: state.loadError })}</span></SettingsAlert>
      <Button type="button" size="sm" variant="outline" onClick={actions.retry}>{t("jobs.common.retry")}</Button>
    </div> : null}
    {!state.loading && !state.loadError && state.instructions.length === 0 ? <p className="text-sm text-muted-foreground">{t("jobs.instructions.empty")}</p> : null}
    {state.instructions.length > 0 ? <ol className="persistent-instructions-pas-list" aria-label={t("jobs.instructions.list")}>
      {state.instructions.map((instruction) => {
        const editing = state.editingId === instruction.id;
        const sourceTurns = instruction.source_turns ?? [];
        return <li key={instruction.id} data-testid="persistent-instruction-row">
          <div className="persistent-instructions-pas-row">
            <div className="min-w-0 space-y-2">
              {editing ? <Input
                aria-label={t("jobs.instructions.edit")}
                autoFocus
                value={state.editText}
                disabled={mutationDisabled}
                nativeInput
                onChange={(event) => actions.changeEditText(event.target.value)}
                onKeyDown={(event) => actions.editKeyDown(event, instruction.id)}
              /> : <p className="persistent-instructions-pas-text" data-v3-selectable-content="true">{instruction.text}</p>}
              {editing && state.error ? <SettingsAlert><span data-v3-selectable-content="true">{state.error}</span></SettingsAlert> : null}
              <div className="persistent-instructions-pas-source">
                {sourceTurns.length > 0 ? <span>{sourceTurns.join(", ")}</span> : instruction.origin === "user" ? <span>{t("jobs.instructions.addedManually")}</span> : null}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {editing ? <>
                <Button type="button" size="sm" disabled={mutationDisabled} onClick={() => actions.saveEdit(instruction.id)}>{t("jobs.common.save")}</Button>
                <Button type="button" size="sm" variant="outline" disabled={mutationDisabled} onClick={actions.cancelEditing}>{t("jobs.common.cancel")}</Button>
              </> : <>
                <Button type="button" size="sm" variant="outline" disabled={mutationDisabled || adding} onClick={() => actions.startEditing(instruction)}>{t("jobs.common.edit")}</Button>
                <Button type="button" size="sm" variant="outline" disabled={mutationDisabled || adding} onClick={() => actions.remove(instruction.id)}>{t("jobs.common.delete")}</Button>
              </>}
            </div>
          </div>
        </li>;
      })}
    </ol> : null}
    {state.error && state.editingId === null ? <SettingsAlert><span data-v3-selectable-content="true">{state.error}</span></SettingsAlert> : null}
    {state.capReached ? <SettingsAlert><span data-v3-selectable-content="true">{t("jobs.instructions.limit")}</span></SettingsAlert> : null}
    {!adding ? <Button type="button" size="sm" variant="outline" className="self-start" disabled={mutationDisabled || state.editingId !== null} onClick={() => { actions.changeAddText(state.addText); setAdding(true); }}>{t("jobs.instructions.addInstruction")}</Button> : <form className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2" onSubmit={(event) => { void submitAdd(event); }}>
      <Input
        aria-label={t("jobs.instructions.new")}
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
      <Button type="submit" size="sm" disabled={mutationDisabled || !state.addText.trim()}>{t("jobs.common.add")}</Button>
      <Button type="button" size="sm" variant="outline" disabled={mutationDisabled} onClick={cancelAdd}>{t("jobs.common.cancel")}</Button>
    </form>}
  </div>;
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}

function formatDate(value: string, locale: string | undefined) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString(locale);
}
