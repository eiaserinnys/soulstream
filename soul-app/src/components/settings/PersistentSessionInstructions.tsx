import React, { useEffect, useRef, useState } from 'react';

import type { PersistentSessionInstruction } from '../../api/persistentSessionEndpoints';
import { ApiHttpError } from '../../api/clientCore';
import { PersistentSessionInstructionsFields } from './PersistentSessionSettingsFields';
import {
  addPersistentSessionInstruction,
  loadPersistentSessionInstructions,
  updatePersistentSessionInstruction,
} from './persistentSessionSettingsActions';
import { describePersistentFailure } from './persistentSessionFailure';
import { usePersistentSessionApiFactory } from './persistentSessionApi';

export function PersistentSessionInstructions({ serverUrl, sessionId }: { serverUrl: string; sessionId: string }) {
  const createApi = usePersistentSessionApiFactory();
  const [instructions, setInstructions] = useState<PersistentSessionInstruction[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [addingText, setAddingText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  const locked = loading || busy;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    void loadPersistentSessionInstructions(createApi(serverUrl), sessionId)
      .then((result) => { if (active) setInstructions(result.instructions); })
      .catch(() => { if (active) setLoadError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [createApi, serverUrl, sessionId, reload]);

  const failMutation = (cause: unknown) => {
    if (!mounted.current) return;
    if (cause instanceof ApiHttpError && cause.status === 409) {
      try {
        if ((JSON.parse(cause.body) as { error?: unknown }).error === 'cap_reached') {
          setMutationError('지속 지시 상한에 도달했습니다.');
          return;
        }
      } catch { /* Show the standard settings error below. */ }
    }
    setMutationError(describePersistentFailure(cause, 'instruction').text);
  };

  const add = async () => {
    const text = addingText.trim();
    if (!text || locked) return;
    setBusy(true); setMutationError(null);
    try {
      const result = await addPersistentSessionInstruction(createApi(serverUrl), sessionId, text);
      if (!mounted.current) return;
      setInstructions((current) => [result.instruction, ...current.filter((item) => item.id !== result.instruction.id)]);
      setAddingText('');
    } catch (cause) { failMutation(cause); }
    finally { if (mounted.current) setBusy(false); }
  };

  const save = async () => {
    if (!editingId || locked) return;
    const id = editingId;
    const text = editingText.trim();
    setBusy(true); setMutationError(null);
    try {
      const result = await updatePersistentSessionInstruction(createApi(serverUrl), sessionId, id, text ? { text } : { status: 'removed' });
      if (!mounted.current) return;
      if (!text || (result.instruction as PersistentSessionInstruction & { status?: string }).status === 'removed') {
        setInstructions((current) => current.filter((item) => item.id !== id));
      } else {
        setInstructions((current) => [result.instruction, ...current.filter((item) => item.id !== id)]);
      }
      setEditingId(null); setEditingText('');
    } catch (cause) { failMutation(cause); }
    finally { if (mounted.current) setBusy(false); }
  };

  const remove = async (instruction: PersistentSessionInstruction) => {
    if (locked) return;
    setBusy(true); setMutationError(null);
    try {
      await updatePersistentSessionInstruction(createApi(serverUrl), sessionId, instruction.id, { status: 'removed' });
      if (mounted.current) setInstructions((current) => current.filter((item) => item.id !== instruction.id));
    } catch (cause) { failMutation(cause); }
    finally { if (mounted.current) setBusy(false); }
  };

  return <PersistentSessionInstructionsFields
    instructions={instructions}
    loading={loading}
    loadError={loadError}
    mutationError={mutationError}
    editingId={editingId}
    editingText={editingText}
    addingText={addingText}
    busy={locked}
    onRetry={() => { if (!locked) setReload((value) => value + 1); }}
    onEditStart={(instruction) => {
      if (locked) return;
      setMutationError(null); setEditingId(instruction.id); setEditingText(instruction.text);
    }}
    onEditText={(value) => { if (!locked) setEditingText(value); }}
    onEditSave={() => void save()}
    onEditCancel={() => {
      if (locked) return;
      setEditingId(null); setEditingText(''); setMutationError(null);
    }}
    onDelete={(instruction) => void remove(instruction)}
    onAddText={(value) => {
      if (!locked) { setAddingText(value); setMutationError(null); }
    }}
    onAdd={() => void add()}
  />;
}
