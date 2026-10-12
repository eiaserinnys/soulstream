import React, { createContext, useContext, useMemo, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { composeText, initialState, reduce, renderText, type Action, type ChatUiState, type FieldValue } from '@soulstream/chat-ui';
import { useOpenContentLink } from '../../hooks/useOpenContentLink';
import type { ChatUiRichPublication } from './chatUiPublication';

export type AppendGeneratedText = (sessionId: string, text: string) =>
  | { ok: true }
  | { ok: false; reason: 'wrong_session' | 'not_ready' | 'sending' | 'disabled' | 'too_long' };
type Entry = { state: ChatUiState; expanded: Record<string, boolean>; resetEpoch: number };
type NumberEditor = { publicationKey: string; commit(): boolean };
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
  setNotice(value: string): void;
};
const Context = createContext<ContextValue | null>(null);
export function ChatUiControllerProvider(props: Props) {
  // Session navigation discards this screen's memory, including old notices.
  return <SessionController key={props.sessionId} {...props} />;
}
function SessionController({ sessionId, appendGeneratedText, children }: Props) {
  const entries = useRef(new Map<string, Entry>()).current;
  const numberEditors = useRef(new Map<string, NumberEditor>()).current;
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState('');
  const openLink = useOpenContentLink();
  const value = useMemo<ContextValue>(() => {
    const read = (publication: ChatUiRichPublication): Entry => entries.get(publicationKey(sessionId, publication))
      ?? { state: initialState(publication.document), expanded: {}, resetEpoch: 0 };
    return {
      sessionId, entries, read, numberEditors, appendGeneratedText, openLink, notice, setNotice,
      update: (publication, change) => {
        const next = change(read(publication));
        entries.set(publicationKey(sessionId, publication), next);
        setVersion(current => current + 1);
        return next;
      },
    };
  }, [sessionId, entries, version, numberEditors, appendGeneratedText, openLink, notice]);
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
export function useChatUiController(publication: ChatUiRichPublication) {
  const context = useControllerContext();
  const doc = publication.document;
  const key = publicationKey(context.sessionId, publication);
  const entry = context.read(publication);
  const set = (field: string, value: FieldValue) => context.update(publication,
    current => ({ ...current, state: reduce(doc, current.state, { type: 'set', field, value }) })).state;
  return {
    ...entry,
    set,
    toggleEntity(id: string) {
      context.update(publication, current => ({ ...current, expanded: { ...current.expanded, [id]: !current.expanded[id] } }));
    },
    registerNumberEditor(id: string, commit: () => boolean) {
      context.numberEditors.set(id, { publicationKey: key, commit });
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
        if (editor.publicationKey === key && !editor.commit()) return;
      }
      const result = context.appendGeneratedText(context.sessionId, composeText(doc, context.read(publication).state, nodeId));
      context.setNotice(result.ok ? '' : result.reason === 'too_long'
        ? '입력창이 가득 차서 더하지 못했어.' : '지금은 입력창에 더할 수 없어.');
    },
  };
}
export type ChatUiController = ReturnType<typeof useChatUiController>;
