import type { AttachmentUploadInput } from '../../hooks/useChatAttachments';

export function extensionFromUri(uri: string): string {
  const path = uri.split('?')[0] ?? uri;
  const match = path.match(/\.[a-zA-Z0-9]+$/);
  return match?.[0] ?? '.m4a';
}

export function audioMimeType(extension: string): string {
  switch (extension.toLowerCase()) {
    case '.webm':
      return 'audio/webm';
    case '.wav':
      return 'audio/wav';
    case '.caf':
      return 'audio/x-caf';
    case '.m4a':
    case '.mp4':
    default:
      return 'audio/mp4';
  }
}

export function recordingFileName(
  extension: string,
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `recording-${stamp}${extension}`;
}

export function buildRecordingUploadInput(
  uri: string,
  now?: Date,
): AttachmentUploadInput {
  const extension = extensionFromUri(uri);
  return {
    uri,
    name: recordingFileName(extension, now),
    type: audioMimeType(extension),
  };
}
