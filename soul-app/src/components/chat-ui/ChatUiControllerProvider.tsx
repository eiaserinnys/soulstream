import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { composeText, initialState, reduce, renderText, type Action, type ChatUiState, type FieldValue } from '@soulstream/chat-ui';
import { useOpenContentLink } from '../../hooks/useOpenContentLink';
import type { ChatUiRichPublication } from './chatUiPublication';
import { readChatUiPublication } from './chatUiPublication';

export type AppendGeneratedText = (sessionId: string, text: string) =>
  | { ok: true }
  | { ok: false; reason: 'wrong_session' | 'not_ready' | 'sending' | 'disabled' | 'too_long' };
type Entry = { state: ChatUiState; expanded: Record<string, boolean>; resetEpoch: number };
type NumberEditor = { publicationKey: string; field: string; commit(): void; sync(value: number): void };
type Props = { sessionId: string; appendGeneratedText: AppendGeneratedText; children: React.ReactNode };
type ContextValue = {
  sessionId: string;
  entries: Map<string, Entry>;
  read(publication: ChatUiRichPublication): Entry;
  update(publication: ChatUiRichPublication, change: (entry: Entry) => Entry): Entry;
  numberEditors: Map<string, NumberEditor>;
  appendGeneratedText: AppendGeneratedText;
  openLink: ReturnType<typeof useOpenContentLink>;
  notice: string;
  noticeLineOpen: boolean;
  setNotice(value: string): void;
  closeNoticeLine(): void;
};
const Context = createContext<ContextValue | null>(null);
export function ChatUiControllerProvider(props: Props) {
  return <SessionController {...props} />;
}
function createSessionState(sessionId: string) {
  return { sessionId, entries: new Map<string, Entry>(), numberEditors: new Map<string, NumberEditor>(),
    notice: '', noticeLineOpen: false };
}
function SessionController({ sessionId, appendGeneratedText, children }: Props) {
  const [state, setState] = useState(() => createSessionState(sessionId));
  // Reset only our state before children commit; keep their existing lifetimes.
  if (state.sessionId !== sessionId) setState(createSessionState(sessionId));
  const { entries, numberEditors, notice, noticeLineOpen } = state;
  const setNotice = useCallback((notice: string) => {
    setState(current => current.entries === entries
      ? { ...current, notice, noticeLineOpen: current.noticeLineOpen || !!notice } : current);
  }, [entries]);
  const closeNoticeLine = useCallback(() => {
    setState(current => current.entries === entries
      ? { ...current, notice: '', noticeLineOpen: false } : current);
  }, [entries]);
  const openLink = useOpenContentLink();
  const value = useMemo<ContextValue>(() => {
    const read = (publication: ChatUiRichPublication): Entry => entries.get(publicationKey(sessionId, publication))
      ?? { state: initialState(publication.document), expanded: {}, resetEpoch: 0 };
    return {
      sessionId, entries, read, numberEditors, appendGeneratedText, openLink,
      notice, noticeLineOpen, setNotice, closeNoticeLine,
      update: (publication, change) => {
        const next = change(read(publication));
        entries.set(publicationKey(sessionId, publication), next);
        setState(current => current.entries === entries ? { ...current } : current);
        return next;
      },
    };
  }, [sessionId, state, appendGeneratedText, openLink, setNotice, closeNoticeLine]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
function useControllerContext() {
  const context = useContext(Context);
  if (!context) throw Error('ChatUiControllerProvider가 필요합니다.');
  return context;
}
function publicationKey(sessionId: string, publication: ChatUiRichPublication) {
  return JSON.stringify([sessionId, publication.uiId, publication.hash]);
}
export function useChatUiNotice() { return useControllerContext().notice; }
export function useChatUiNoticeLine() {
  const { noticeLineOpen, closeNoticeLine } = useControllerContext();
  return { noticeLineOpen, closeNoticeLine };
}
/** Explicit menu bridge: read the publication's current state when invoked. */
export function useChatUiMessageText(data: unknown): (() => string) | undefined {
  const context = useContext(Context);
  const publication = useMemo(() => readChatUiPublication(data), [data]);
  if (publication.kind === 'rich') return () => renderText(publication.document, context?.read(publication).state);
  if (publication.kind === 'unsupported') return () => renderText(publication.document);
  return undefined;
}
export function useChatUiController(publication: ChatUiRichPublication) {
  const context = useControllerContext();
  const doc = publication.document;
  const key = publicationKey(context.sessionId, publication);
  const entry = context.read(publication);
  const set = (field: string, value: FieldValue, typingEditorId?: string) => {
    const previous = context.read(publication).state.values[field];
    const next = context.update(publication,
      current => ({ ...current, state: reduce(doc, current.state, { type: 'set', field, value }) })).state;
    if (JSON.stringify(previous) !== JSON.stringify(next.values[field])) context.setNotice('');
    for (const [id, editor] of context.numberEditors) {
      if (editor.publicationKey === key && editor.field === field && id !== typingEditorId) editor.sync(next.values[field] as number);
    }
    return next;
  };
  return {
    ...entry,
    sessionId: context.sessionId,
    set,
    toggleEntity(id: string) {
      context.update(publication, current => ({ ...current, expanded: { ...current.expanded, [id]: !current.expanded[id] } }));
    },
    registerNumberEditor(id: string, field: string, sync: (value: number) => void) {
      context.numberEditors.set(id, { publicationKey: key, field, sync,
        commit: () => sync(context.read(publication).state.values[field] as number) });
      return () => { context.numberEditors.delete(id); };
    },
    async action(nodeId: string, action: Action) {
      if (action.type === 'set') { set(action.field, action.value); return; }
      if (action.type === 'reset') {
        context.update(publication, current => ({ ...current, state: reduce(doc, current.state, action), resetEpoch: current.resetEpoch + 1 }));
        context.setNotice('기본값으로 돌아갔어'); return;
      }
      if (action.type === 'open_source') {
        const source = doc.sources[action.source];
        if (source.type === 'external_link') await context.openLink(source.url);
        return;
      }
      if (action.type === 'copy') {
        try {
          await Clipboard.setStringAsync(renderText(doc, context.read(publication).state));
          context.setNotice('현재 값 복사됨');
        } catch { context.setNotice('복사하지 못했어.'); }
        return;
      }
      for (const editor of context.numberEditors.values()) {
        if (editor.publicationKey === key) editor.commit();
      }
      const result = context.appendGeneratedText(context.sessionId, composeText(doc, context.read(publication).state, nodeId));
      context.setNotice(result.ok ? '' : result.reason === 'too_long'
        ? '입력창이 가득 차서 더하지 못했어.' : '지금은 입력창에 더할 수 없어.');
    },
  };
}
export type ChatUiController = ReturnType<typeof useChatUiController>;
