import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AttachmentDescriptor,
  AttachmentReadContext,
  SessionEventAttachmentResponse,
  SessionEventAttachmentView,
} from '../../../packages/wire-schema/src/attachments';
import { ApiHttpError, createApiRequestContext } from '../api/clientCore';
import { AttachmentReadError } from '../api/attachmentEndpoints';
import type { SessionEvent } from '../api/types';
import {
  attachmentContentUrl,
  isLegacyAttachmentImage,
  type AttachmentView,
} from '../lib/attachment-view';
import { captureAuthScope, isAuthScopeCurrent, useAuthScopeGeneration } from '../lib/auth-scope';

const ATTACHMENT_EVENT_TYPES = new Set([
  'user_message',
  'intervention_sent',
  'assistant_message',
  'complete',
]);

interface UseMessageAttachmentsArgs {
  event: SessionEvent;
  readContext?: AttachmentReadContext;
}

interface MessageAttachmentSignals {
  ids: string[];
  paths: string[];
  hasSignal: boolean;
}

interface AttachmentState {
  key: string;
  items: AttachmentView[];
  phase: 'loading' | 'ready' | 'failed';
  failure: MessageAttachmentFailure | null;
}

export interface MessageAttachmentFailure {
  message: string;
  status: number | null;
  retryable: boolean;
}

type SessionAttachmentReadContext = Extract<AttachmentReadContext, { type: 'session' }>;

export function useMessageAttachments({
  event,
  readContext,
}: UseMessageAttachmentsArgs): { items: AttachmentView[]; phase: 'idle' | AttachmentState['phase']; failure: MessageAttachmentFailure | null; retry(): void } {
  const authGeneration = useAuthScopeGeneration();
  const [retryVersion, setRetryVersion] = useState(0);
  const [state, setState] = useState<AttachmentState>({ key: '', items: [], phase: 'loading', failure: null });
  const eventId = String(event.id);
  const signalKey = JSON.stringify(getMessageAttachmentSignals(event));
  const signals = useMemo(() => JSON.parse(signalKey) as MessageAttachmentSignals, [signalKey]);
  const requestKey = JSON.stringify([
    eventId,
    event.type,
    signals.ids,
    signals.paths,
    readContext,
    authGeneration,
  ]);
  const numericEventId = Number(eventId);
  const canReadProjection = signals.hasSignal && readContext?.type === 'session' && Boolean(readContext.id)
    && Number.isSafeInteger(numericEventId) && numericEventId >= 0;

  useEffect(() => {
    if (!canReadProjection || readContext?.type !== 'session') return;

    const scope = captureAuthScope();
    if (scope.generation !== authGeneration) return;
    const api = createApiRequestContext(scope.serverUrl, { authScope: scope });
    const controller = new AbortController();
    let active = true;
    setState(previous => ({ key: requestKey, items: previous.key === requestKey ? previous.items : [], phase: 'loading', failure: null }));

    void loadEventAttachments({
      api,
      eventId,
      readContext,
      signals,
      output: event.data.attachment_output === true,
      signal: controller.signal,
    }).then((items) => {
      if (!active || controller.signal.aborted || !isAuthScopeCurrent(scope)) return;
      setState({ key: requestKey, items, phase: 'ready', failure: null });
    }).catch((error: unknown) => {
      if (!active || controller.signal.aborted || !isAuthScopeCurrent(scope)) return;
      const status = error instanceof ApiHttpError ? error.status : null;
      const retryable = status !== null ? status >= 500 : error instanceof AttachmentReadError && error.kind === 'retryable';
      const message = status === 401 ? '로그인이 필요합니다' : status === 403 ? '접근 권한이 없습니다'
        : status === 404 ? '찾을 수 없음' : '첨부를 불러오지 못했습니다';
      setState(previous => ({
        key: requestKey,
        items: previous.key === requestKey ? previous.items : [],
        phase: 'failed', failure: { message, status, retryable },
      }));
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [authGeneration, canReadProjection, eventId, requestKey, retryVersion, signals, event.data.attachment_output]);

  const retry = useCallback(() => setRetryVersion((version) => version + 1), []);
  if (!canReadProjection) return { items: [], phase: 'idle', failure: null, retry };
  return { items: state.key === requestKey ? state.items : [], phase: state.key === requestKey ? state.phase : 'loading',
    failure: state.key === requestKey ? state.failure : null, retry };
}

export function getMessageAttachmentSignals(event: SessionEvent): MessageAttachmentSignals {
  if (!ATTACHMENT_EVENT_TYPES.has(event.type)) return { ids: [], paths: [], hasSignal: false };
  const data = event.data as Record<string, unknown>;
  const ids = stringValues(data.attachment_ids);
  const paths = [
    ...stringValues(data.attachments),
    ...stringValues(data.attachment_paths),
  ];
  return { ids, paths, hasSignal: ids.length > 0 || paths.length > 0 };
}

async function loadEventAttachments({
  api,
  eventId,
  readContext,
  signals,
  signal,
  output,
}: {
  api: ReturnType<typeof createApiRequestContext>;
  eventId: string;
  readContext: SessionAttachmentReadContext;
  signals: MessageAttachmentSignals;
  signal: AbortSignal;
  output: boolean;
}): Promise<AttachmentView[]> {
  const numericEventId = Number(eventId);
  let response: Response;
  try {
    response = await api.authFetch(
      `${api.base}/api/sessions/${encodeURIComponent(readContext.id)}/events/${numericEventId}/attachments`,
      { method: 'GET', signal },
    );
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new AttachmentReadError('retryable');
  }
  const projection = await api.readJson<SessionEventAttachmentResponse>(response, 'getSessionEventAttachments');
  if (String(projection.event_id) !== String(numericEventId)) {
    throw new Error('Event attachment response did not match the requested event');
  }
  const displayed = output ? projection.items.filter(item => item.kind === 'asset'
    ? signals.ids.includes(item.descriptor.attachment_id) : item.kind === 'unavailable'
      ? signals.ids.includes(item.attachment_id) : true) : projection.items;
  return await Promise.all(displayed.map((item) => toAttachmentView(item, api, signal)));
}

async function toAttachmentView(
  item: SessionEventAttachmentView,
  api: ReturnType<typeof createApiRequestContext>,
  signal: AbortSignal,
): Promise<AttachmentView> {
  switch (item.kind) {
    case 'asset':
      return descriptorAttachmentView(item.descriptor, item.read_context);
    case 'legacy':
      return item.availability === 'missing'
        ? unavailableAttachment(item.path, item.read_context, item.name, 'missing')
        : readLegacyAttachment(item, api, signal);
    case 'unavailable':
      return readAttachmentById(item.attachment_id, item.read_context, api, signal);
    case 'unavailable_legacy':
      return unavailableAttachment(`legacy:${item.path}`, item.read_context, item.name);
  }
}

async function readAttachmentById(
  id: string,
  context: AttachmentReadContext,
  api: ReturnType<typeof createApiRequestContext>,
  signal: AbortSignal,
): Promise<AttachmentView> {
  try {
    const query = context.type === 'owner'
      ? ''
      : `?${new URLSearchParams({ context_type: context.type, context_id: context.id }).toString()}`;
    const response = await api.authFetch(`${api.base}/api/attachments/${encodeURIComponent(id)}${query}`, { signal });
    const metadata = await api.readJson<{ descriptor: AttachmentDescriptor }>(response, 'getAttachmentMetadata');
    return descriptorAttachmentView(metadata.descriptor, context);
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    return unavailableAttachment(id, context);
  }
}

async function readLegacyAttachment(
  item: Extract<SessionEventAttachmentView, { kind: 'legacy' }>,
  api: ReturnType<typeof createApiRequestContext>,
  signal: AbortSignal,
): Promise<AttachmentView> {
  const context = item.read_context;
  const url = new URL(`${api.base}/api/attachments/files`);
  url.searchParams.set('nodeId', item.node_id);
  url.searchParams.set('path', item.path);
  url.searchParams.set('context_type', context.type);
  url.searchParams.set('context_id', context.id);

  try {
    const response = await api.authFetch(url.href, { method: 'HEAD', signal });
    if (!response.ok) return unavailableAttachment(item.path, context, item.name);

    const name = filenameFromContentDisposition(response.headers.get('content-disposition'))
      || item.name
      || filenameFromPath(item.path);
    const aliasId = response.headers.get('x-attachment-id');
    if (aliasId) {
      try {
        return await readAttachmentById(aliasId, context, api, signal);
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }

    const mimeType = response.headers.get('content-type')?.split(';', 1)[0].trim() || item.mime_type;
    const sizeHeader = response.headers.get('content-length');
    const parsedSize = sizeHeader && /^\d+$/.test(sizeHeader) ? Number(sizeHeader) : item.byte_size;
    const originalUrl = new URL(url.href);
    originalUrl.searchParams.set('download', 'true');
    return {
      key: `${item.node_id}:${item.path}`,
      name,
      mimeType,
      byteSize: parsedSize !== null && Number.isSafeInteger(parsedSize) ? parsedSize : null,
      previewKind: isLegacyAttachmentImage(name) ? 'image' : 'info',
      readContext: context,
      source: {
        kind: 'ready',
        attachmentId: `${item.node_id}:${item.path}`,
        previewUrl: url.href,
        originalUrl: originalUrl.href,
      },
    };
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    return unavailableAttachment(item.path, context, item.name);
  }
}

function descriptorAttachmentView(descriptor: AttachmentDescriptor, context: AttachmentReadContext): AttachmentView {
  const id = descriptor.attachment_id;
  return {
    key: id,
    name: descriptor.name,
    mimeType: descriptor.mime_type || null,
    byteSize: Number.isSafeInteger(descriptor.byte_size) && descriptor.byte_size >= 0
      ? descriptor.byte_size
      : null,
    previewKind: descriptor.preview_kind,
    readContext: context,
    source: {
      kind: 'ready',
      attachmentId: id,
      previewUrl: attachmentContentUrl(id, context),
      originalUrl: attachmentContentUrl(id, context, { download: true }),
    },
  };
}

function unavailableAttachment(
  key: string,
  context: AttachmentReadContext,
  name = '첨부 파일',
  availability: 'unresolved' | 'missing' | 'unavailable' = 'unavailable',
): AttachmentView {
  return {
    key,
    name,
    mimeType: null,
    byteSize: null,
    previewKind: 'info',
    readContext: context,
    source: { kind: 'unavailable', availability },
  };
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function filenameFromPath(path: string): string {
  const filename = path.split(/[\\/]/).filter(Boolean).pop() ?? '';
  try { return decodeURIComponent(filename); } catch { return filename; }
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1]?.trim();
  if (encoded) {
    try { return decodeURIComponent(encoded.replace(/^"|"$/g, '')); } catch { return null; }
  }
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value);
  return (plain?.[1] ?? plain?.[2])?.trim() || null;
}
