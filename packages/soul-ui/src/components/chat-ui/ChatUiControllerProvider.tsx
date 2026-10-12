import { createContext, useCallback, useContext, useRef, useState, type PropsWithChildren } from 'react';
import { composeText, initialState, reduce, renderText, type Action, type ChatUiState, type FieldValue, type NormalizedChatUiDocumentV1 } from '@soulstream/chat-ui';
import type { ChatUiComposerHandle, RegisterGeneratedTextActions } from './chat-ui-composer';

type ControllerContext = {
  sessionId: string;
  states: Map<string, ChatUiState>;
  update: (key: string, state: ChatUiState) => void;
  feedback: string;
  feedbackOpen: boolean;
  closeFeedback: () => void;
  notify: (text: string) => void;
  registerComposer: RegisterGeneratedTextActions;
  append: (text: string) => void;
};
const Context = createContext<ControllerContext | null>(null);
const FeedbackLifecycleContext = createContext<(() => void) | null>(null);

/** The scope owns memory; virtualized message rows only borrow their entries. */
type ScopeProps = PropsWithChildren<{ sessionId: string; appendGeneratedText?: ChatUiComposerHandle['appendGeneratedText'] }>;
function ControllerScope({ sessionId, appendGeneratedText, children }: ScopeProps) {
  const [scope, setScope] = useState(() => ({ sessionId, states: new Map<string, ChatUiState>() }));
  const { states } = scope;
  const composer = useRef<ChatUiComposerHandle | null>(null);
  const [, setVersion] = useState(0);
  const [{ text: feedback, open: feedbackOpen }, setFeedback] = useState({ text: '', open: false });
  // Reset this owner before rendering its children; their component lifetimes stay intact.
  if (scope.sessionId !== sessionId) {
    setScope({ sessionId, states: new Map<string, ChatUiState>() });
    setFeedback({ text: '', open: false });
  }
  const notify = useCallback((text: string) => setFeedback(previous => ({ text, open: previous.open || !!text })), []);
  const closeFeedback = useCallback(() => setFeedback({ text: '', open: false }), []);
  const update = useCallback((key: string, state: ChatUiState) => {
    if (states.get(key) === state) return;
    states.set(key, state);
    notify('');
    setVersion(version => version + 1);
  }, [states, notify]);
  const registerComposer = useCallback<RegisterGeneratedTextActions>(handle => { composer.current = handle; }, []);
  const append = useCallback((text: string) => {
    if (!text) return;
    try {
      const result = appendGeneratedText ? appendGeneratedText(sessionId, text) : composer.current?.appendGeneratedText(sessionId, text);
      notify(result?.ok ? '' : '지금은 입력창에 더할 수 없어.');
    } catch {
      notify('지금은 입력창에 더할 수 없어.');
    }
  }, [appendGeneratedText, sessionId, notify]);
  return <FeedbackLifecycleContext.Provider value={closeFeedback}>
    <Context.Provider value={{ sessionId, states, update, feedback, feedbackOpen, closeFeedback, notify, registerComposer, append }}>{children}</Context.Provider>
  </FeedbackLifecycleContext.Provider>;
}

export function ChatUiControllerProvider({ sessionId, appendGeneratedText, children }: ScopeProps) {
  return <ControllerScope sessionId={sessionId} appendGeneratedText={appendGeneratedText}>{children}</ControllerScope>;
}

/** Ordinary composers can also mount outside a chat UI scope. */
export function useChatUiFeedback() {
  const context = useContext(Context);
  return { feedback: context?.feedback ?? '', open: context?.feedbackOpen ?? false };
}

/** Sending subscribes only to the stable lifecycle action, not UI values. */
export function useCloseChatUiFeedback() {
  return useContext(FeedbackLifecycleContext);
}

function useControllerContext() {
  const context = useContext(Context);
  if (!context) throw new Error('ChatUiControllerProvider is required');
  return context;
}

/** The input host registers its bridge and places feedback below the composer. */
export function useChatUiHost() {
  const { feedback, feedbackOpen, closeFeedback, registerComposer } = useControllerContext();
  return { feedback, feedbackOpen, closeFeedback, registerComposer };
}

export function useChatUiController(uiId: string, hash: string, doc: NormalizedChatUiDocumentV1) {
  const { sessionId, states, update, notify, append } = useControllerContext();
  const key = JSON.stringify([sessionId, uiId, hash]);
  if (!states.has(key)) states.set(key, initialState(doc));
  const current = () => states.get(key)!;
  const set = (field: string, value: FieldValue) => {
    const next = reduce(doc, current(), { type: 'set', field, value });
    update(key, next);
    return next.values[field];
  };
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
