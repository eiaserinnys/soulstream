import { useCallback, useMemo, useRef, useState } from 'react';
import { renderText, canonicalJson, validateChatUiDocument } from '@soulstream/chat-ui';
import { Button, ChatUiControllerProvider, ChatUiMessage, ChatInput } from '@seosoyoung/soul-ui';
import type { ChatUiComposerHandle, RegisterGeneratedTextActions } from '@seosoyoung/soul-ui/components/chat-ui/chat-ui-composer';
import { ChatUiErrorBoundary } from '@seosoyoung/soul-ui/components/chat-ui/ChatUiErrorBoundary';
import { ChatUiFallback } from '@seosoyoung/soul-ui/components/chat-ui/ChatUiMessage';
import { AssistantMessage } from '@seosoyoung/soul-ui/components/chat/AssistantMessage';
import { UserMessage } from '@seosoyoung/soul-ui/components/chat/UserMessage';
import { useChatTypography } from '@seosoyoung/soul-ui/components/chat/useChatTypography';
import { createChatSessionStore } from '@seosoyoung/soul-ui/stores/dashboard-store';
import { ChatStoreScopeProvider } from '@seosoyoung/soul-ui/stores/chat-store-scope';
import { createProcessingContext } from '@seosoyoung/soul-ui/stores/processing-context';
import { processEventsBatch } from '@seosoyoung/soul-ui/stores/event-processor';
import { flattenTree, type ChatMessage } from '@seosoyoung/soul-ui/lib/flatten-tree';
import type { SoulSSEEvent } from '@seosoyoung/soul-ui/shared/types';
import { DEFAULT_CHAT_REVIEW_COLUMN_CLASS_NAME, MANUSCRIPT_CHAT_REVIEW_COLUMN_CLASS_NAME } from './PersistentManuscriptChatReviewSample';
import { reviewDocuments, reviewPrompts, publishedSonnetEvent, publishedSolEvent } from './chat-ui-review-documents';
import './chat-ui-review-sample.css';

type Example = 'pas' | 'normal' | 'gallery' | 'sonnet' | 'sol' | 'long';
type Mode = 'rich' | 'error' | 'unsupported' | 'invalid';
const examples: [Example, string][] = [['pas', '카드'], ['normal', '요금'], ['gallery', '갤러리'], ['long', '긴 이름'], ['sonnet', 'Sonnet 발행본'], ['sol', 'Sol 발행본']];
const modes: [Mode, string][] = [['rich', '화면'], ['error', '렌더 오류'], ['unsupported', '미지원 버전'], ['invalid', '손상 문서']];

function longDocument() {
  const raw = JSON.parse(canonicalJson(reviewDocuments.gallery));
  raw.fields.order.options = raw.fields.order.options.map((option: { id: string; label: string }) => ({ ...option, label: option.label + ' · 작은 화면에서 입력과 돌아가기, 기존 초안을 함께 확인한 뒤 결정' }));
  raw.fields.checks.options = raw.fields.checks.options.map((option: { id: string; label: string }) => ({ ...option, label: option.label + '과 관련된 긴 확인 항목도 빠짐없이 읽고 선택' }));
  raw.sources.original.label = 'OpenUI 원문 · 직접 React 부품으로 그리는 화면의 출처를 설명하는 긴 이름';
  const result = validateChatUiDocument(raw);
  if (!result.ok) throw new Error('invalid long-label review fixture');
  return result.document;
}

/** Raw publication events use the same factory and flattening path as the web reader. */
export function reviewMessages(example: Example, mode: Mode, sessionId: string) {
  const published = example === 'sonnet' ? publishedSonnetEvent : example === 'sol' ? publishedSolEvent : null;
  const doc = example === 'long' ? longDocument() : reviewDocuments[example] ?? reviewDocuments.normal;
  const raw = published ?? {
    id: 3, event_type: 'assistant_message', payload: {
      type: 'assistant_message', timestamp: 3, content: renderText(doc),
      ui: { schema_version: 1, revision: 1, ui_id: 'ui_' + 'c'.repeat(32), hash: 'd'.repeat(64), document: doc },
    },
  };
  const ui = raw.payload.ui;
  const event = { ...raw.payload, ui: mode === 'unsupported' ? { ...ui, schema_version: 99 } : mode === 'invalid' ? { ...ui, document: { schema_version: 1, body: [{ kind: 'unknown' }] } } : ui };
  const events = [
    { event: { type: 'assistant_message', timestamp: 1, content: '기존 일반 글도 같은 채팅 표면에서 읽습니다. 긴 답변의 말풍선 오른쪽 끝과 구조화 응답의 오른쪽 끝을 함께 비교합니다. 내용이 여러 줄에 걸쳐도 기존 채팅 글자와 여백을 유지합니다.', tool_use_id: 'ordinary-' + sessionId } as SoulSSEEvent, eventId: 1 },
    { event: { type: 'user_message', timestamp: 2, text: reviewPrompts[example as keyof typeof reviewPrompts] ?? '발행된 화면을 조작해줘.', input_id: 'review-' + sessionId } as SoulSSEEvent, eventId: 2 },
    { event: event as SoulSSEEvent, eventId: raw.id },
  ];
  const result = processEventsBatch(events, createProcessingContext(), null, sessionId, null, 0, true);
  return flattenTree(result.root);
}

function ThrowOnRender(): never { throw new Error('components review render failure'); }
function RenderFailure({ msg }: { msg: ChatMessage }) {
  const validation = validateChatUiDocument((msg.ui as { document: unknown }).document);
  if (!validation.ok) throw new Error('render failure sample requires valid document');
  return <ChatUiErrorBoundary fallback={<ChatUiFallback content={renderText(validation.document)} notice="화면을 표시하지 못했어. 기본값 글로 보여줄게." />}><ThrowOnRender /></ChatUiErrorBoundary>;
}

export function ChatUiReviewSample({ presentation }: { presentation: 'default' | 'manuscript' }) {
  const [example, setExample] = useState<Example>('pas');
  const [mode, setMode] = useState<Mode>('rich');
  const sessionId = `chat-ui-review-${presentation}-${example}`;
  const scope = useMemo(() => createChatSessionStore(sessionId), [sessionId]);
  const composer = useRef<ChatUiComposerHandle | null>(null);
  const registerGeneratedTextActions = useCallback<RegisterGeneratedTextActions>(handle => { composer.current = handle; }, []);
  const appendGeneratedText = useCallback<ChatUiComposerHandle['appendGeneratedText']>((target, text) =>
    composer.current?.appendGeneratedText(target, text) ?? { ok: false, reason: 'unavailable' }, []);
  const messages = useMemo(() => reviewMessages(example, mode, sessionId), [example, mode, sessionId]);
  const { chatTypographyStyle } = useChatTypography();
  const manuscript = presentation === 'manuscript';
  return <div className="chat-ui-review" data-testid={`chat-ui-review-${presentation}`} style={chatTypographyStyle}>
    <div className="chat-ui-review-controls" aria-label="검수 문서" >{examples.map(([value, label]) => <Button key={value} variant="outline" aria-pressed={value === example} onClick={() => setExample(value)}>{label}</Button>)}</div>
    <div className="chat-ui-review-controls" aria-label="글 대체 상태">{modes.map(([value, label]) => <Button key={value} variant="outline" aria-pressed={value === mode} onClick={() => setMode(value)}>{label}</Button>)}</div>
    <ChatStoreScopeProvider scope={scope}><ChatUiControllerProvider sessionId={sessionId} appendGeneratedText={appendGeneratedText}>
      <div className={manuscript ? MANUSCRIPT_CHAT_REVIEW_COLUMN_CLASS_NAME : `v3-chat-surface ${DEFAULT_CHAT_REVIEW_COLUMN_CLASS_NAME}`}>
        <div data-slot="chat-root" data-chat-presentation={manuscript ? 'manuscript' : undefined} className="chat-ui-review-transcript">
          <div className="chat-ui-review-messages">{messages.map(msg => msg.role === 'user'
            ? <UserMessage key={msg.treeNodeId} msg={msg} presentation={presentation} />
            : <AssistantMessage key={msg.treeNodeId} msg={msg} presentation={presentation} contentLayout={msg.ui ? 'structured' : 'text'}>
              {msg.ui ? mode === 'error' ? <RenderFailure key={`${example}-${mode}`} msg={msg} /> : <ChatUiMessage ui={msg.ui} content={msg.content} presentation={presentation} /> : undefined}
            </AssistantMessage>)}
          </div>
          <footer className="chat-ui-review-composer"><ChatInput presentation={presentation} registerGeneratedTextActions={registerGeneratedTextActions} /></footer>
        </div>
      </div>
    </ChatUiControllerProvider></ChatStoreScopeProvider>
  </div>;
}
