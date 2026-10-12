import { createContext, useCallback, useContext, useRef, useState, type PropsWithChildren } from 'react';
import { composeText, initialState, reduce, renderText, type Action, type ChatUiState, type FieldValue, type NormalizedChatUiDocumentV1 } from '@soulstream/chat-ui';
import type { ChatUiComposerHandle, RegisterGeneratedTextActions } from './chat-ui-composer';

type ControllerContext = {
  sessionId: string;
  states: Map<string, ChatUiState>;
  update: (key: string, state: ChatUiState) => void;
  feedback: string;
  notify: (text: string) => void;
  registerComposer: RegisterGeneratedTextActions;
  append: (text: string) => void;
};
const Context = createContext<ControllerContext | null>(null);

/** The scope owns memory; virtualized message rows only borrow their entries. */
function ControllerScope({ sessionId, children }: PropsWithChildren<{ sessionId: string }>) {
  const states = useRef(new Map<string, ChatUiState>()).current;
  const composer = useRef<ChatUiComposerHandle | null>(null);
  const [, setVersion] = useState(0);
  const [feedback, notify] = useState('');
  const update = useCallback((key: string, state: ChatUiState) => {
    if (states.get(key) === state) return;
    states.set(key, state);
    setVersion(version => version + 1);
  }, [states]);
  const registerComposer = useCallback<RegisterGeneratedTextActions>(handle => { composer.current = handle; }, []);
  const append = useCallback((text: string) => {
    if (!text) return;
    try {
      const result = composer.current?.appendGeneratedText(sessionId, text);
      notify(result?.ok ? '' : '지금은 입력창에 더할 수 없어.');
    } catch {
      notify('지금은 입력창에 더할 수 없어.');
    }
  }, [sessionId]);
  return <Context.Provider value={{ sessionId, states, update, feedback, notify, registerComposer, append }}>{children}</Context.Provider>;
}

export function ChatUiControllerProvider({ sessionId, children }: PropsWithChildren<{ sessionId: string }>) {
  return <ControllerScope key={sessionId} sessionId={sessionId}>{children}</ControllerScope>;
}

function useControllerContext() {
  const context = useContext(Context);
  if (!context) throw new Error('ChatUiControllerProvider is required');
  return context;
}

/** The input host registers its bridge and places feedback below the composer. */
export function useChatUiHost() {
  const { feedback, registerComposer } = useControllerContext();
  return { feedback, registerComposer };
}

export function useChatUiController(uiId: string, hash: string, doc: NormalizedChatUiDocumentV1) {
  const { sessionId, states, update, notify, append } = useControllerContext();
  const key = JSON.stringify([sessionId, uiId, hash]);
  if (!states.has(key)) states.set(key, initialState(doc));
  const current = () => states.get(key)!;
  const set = (field: string, value: FieldValue) => update(key, reduce(doc, current(), { type: 'set', field, value }));
  const act = async (action: Exclude<Action, { type: 'open_source' }>, nodeId: string) => {
    switch (action.type) {
      case 'set': set(action.field, action.value); break;
      case 'reset': update(key, reduce(doc, current(), action)); notify('기본값으로 돌아갔어'); break;
      case 'compose': append(composeText(doc, current(), nodeId)); break;
      case 'copy':
        try { await navigator.clipboard.writeText(renderText(doc, current())); notify('현재 값 복사됨'); }
        catch { notify('복사하지 못했어.'); }
        break;
    }
  };
  return { key, state: current(), set, act };
}
