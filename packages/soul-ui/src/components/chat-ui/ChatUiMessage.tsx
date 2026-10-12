import { useMemo, type ComponentPropsWithoutRef } from 'react';
import { renderText, validateChatUiDocument } from '@soulstream/chat-ui';
import { MarkdownContent } from '../MarkdownContent';
import { SourceLink } from '../SourceLink';
import { ChatUiErrorBoundary } from './ChatUiErrorBoundary';
import { ChatUiRenderer } from './ChatUiRenderer';
import { useChatUiController } from './ChatUiControllerProvider';
import './chat-ui.css';

type Presentation = 'default' | 'manuscript';
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function readEnvelope(ui: unknown) {
  const raw = isRecord(ui) ? ui : {};
  const validation = validateChatUiDocument(raw.document);
  if (!validation.ok) return { type: 'saved' as const };
  const doc = validation.document;
  const fallbackText = renderText(doc);
  const supported = raw.schema_version === 1 && raw.revision === 1
    && typeof raw.ui_id === 'string' && raw.ui_id.length > 0
    && typeof raw.hash === 'string' && raw.hash.length > 0;
  if (!supported) return { type: 'unsupported' as const, fallbackText };
  return { type: 'rich' as const, doc, fallbackText, uiId: raw.ui_id as string, hash: raw.hash as string };
}

function MarkdownSource(props: ComponentPropsWithoutRef<typeof SourceLink>) {
  return <SourceLink {...props} className="chat-ui-source" />;
}

export function ChatUiFallback({ content, notice }: { content: string; notice: string }) {
  return <div className="chat-ui chat-ui-fallback">
    <p className="chat-ui-meta" role="status">{notice}</p>
    <MarkdownContent content={content} sourceLinkComponent={MarkdownSource} enableBlockquoteCopy />
  </div>;
}

function ValidMessage({ value, presentation }: { value: Extract<ReturnType<typeof readEnvelope>, { type: 'rich' }>; presentation: Presentation }) {
  const controller = useChatUiController(value.uiId, value.hash, value.doc);
  return <ChatUiErrorBoundary key={controller.key} fallback={<ChatUiFallback content={value.fallbackText} notice="화면을 표시하지 못했어. 기본값 글로 보여줄게." />}>
    <ChatUiRenderer doc={value.doc} state={controller.state} onSet={controller.set} onAction={controller.act} presentation={presentation} />
  </ChatUiErrorBoundary>;
}

/** Envelope validation stays at the message boundary; the renderer receives only normalized v1. */
export function ChatUiMessage({ ui, content, presentation = 'default' }: { ui?: unknown; content: string; presentation?: Presentation }) {
  const value = useMemo(() => ui === undefined ? null : readEnvelope(ui), [ui]);
  if (!value) return <MarkdownContent content={content} enableBlockquoteCopy chatImages={presentation === 'manuscript' ? { role: 'assistant' } : undefined} />;
  if (value.type === 'saved') return <ChatUiFallback content={content} notice="화면을 표시하지 못했어. 저장된 글로 보여줄게." />;
  if (value.type === 'unsupported') return <ChatUiFallback content={value.fallbackText} notice="이 버전에서는 기본값 글로 보여줄게." />;
  return <ValidMessage value={value} presentation={presentation} />;
}
