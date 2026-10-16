import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AttachmentDescriptor,
  AttachmentReadContext,
  SessionEventAttachmentResponse,
  SessionEventAttachmentView,
} from '../../../packages/wire-schema/src/attachments';
import { createApiRequestContext } from '../api/clientCore';
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
}

type SessionAttachmentReadContext = Extract<AttachmentReadContext, { type: 'session' }>;

export function useMessageAttachments({
  event,
  readContext,
}: UseMessageAttachmentsArgs): { items: AttachmentView[]; retry(): void } {
  const authGeneration = useAuthScopeGeneration();
  const [retryVersion, setRetryVersion] = useState(0);
  const [state, setState] = useState<AttachmentState>({ key: '', items: [] });
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
    retryVersion,
  ]);

  useEffect(() => {
    if (!signals.hasSignal || !readContext || readContext.type !== 'session' || !readContext.id) {
      setState({ key: requestKey, items: [] });
      return;
    }

    const scope = captureAuthScope();
    if (scope.generation !== authGeneration) return;
    const api = createApiRequestContext(scope.serverUrl, { authScope: scope });
    const controller = new AbortController();
    let active = true;

    void loadEventAttachments({
      api,
      eventId,
      readContext,
      signals,
      signal: controller.signal,
    }).then((items) => {
      if (!active || controller.signal.aborted || !isAuthScopeCurrent(scope)) return;
      setState({ key: requestKey, items });
    }).catch(() => {
      if (!active || controller.signal.aborted || !isAuthScopeCurrent(scope)) return;
      setState({
        key: requestKey,
        items: signals.ids.map((id) => unavailableAttachment(id, readContext)),
      });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [authGeneration, eventId, requestKey, signals]);

  const retry = useCallback(() => setRetryVersion((version) => version + 1), []);
  return { items: state.key === requestKey ? state.items : [], retry };
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
}: {
  api: ReturnType<typeof createApiRequestContext>;
  eventId: string;
  readContext: SessionAttachmentReadContext;
  signals: MessageAttachmentSignals;
  signal: AbortSignal;
}): Promise<AttachmentView[]> {
  const numericEventId = Number(eventId);
  if (!Number.isSafeInteger(numericEventId) || numericEventId < 0) {
    return signals.ids.map((id) => unavailableAttachment(id, readContext));
  }

  try {
    const response = await api.authFetch(
      `${api.base}/api/sessions/${encodeURIComponent(readContext.id)}/events/${numericEventId}/attachments`,
      { method: 'GET', signal },
    );
    const projection = await api.readJson<SessionEventAttachmentResponse>(response, 'getSessionEventAttachments');
    if (String(projection.event_id) !== String(numericEventId)) {
      throw new Error('Event attachment response did not match the requested event');
    }
    return await Promise.all(projection.items.map((item) => toAttachmentView(item, api, signal)));
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    return signals.ids.map((id) => unavailableAttachment(id, readContext));
  }
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
