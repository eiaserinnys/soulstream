import type { AttachmentView } from './attachment-view';

export function attachmentImageSource(item: AttachmentView & { source: Extract<AttachmentView['source'], { kind: 'ready' }> }, serverUrl: string, jwt: string | null) {
  const value = item.source.previewUrl ?? item.source.originalUrl;
  try {
    const url = new URL(value, `${serverUrl.replace(/\/+$/, '')}/`);
    const sameOrigin = url.origin === new URL(serverUrl).origin;
    const headers = sameOrigin && jwt ? { Authorization: `Bearer ${jwt}` } : undefined;
    return { uri: url.toString(), ...(headers ? { headers } : {}) };
  } catch {
    return { uri: '' };
  }
}
