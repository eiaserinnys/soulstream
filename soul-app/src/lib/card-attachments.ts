export interface CardAttachment { name: string; url: string }

export function cardAttachmentUrl(serverUrl: string, nodeId: string, path: string): string {
  return `${serverUrl.replace(/\/$/, '')}/api/attachments/files?${new URLSearchParams({ nodeId, path })}`;
}

export function appendCardAttachments(text: string, files: readonly CardAttachment[]): string {
  if (!files.length) return text;
  return `${text}\n\n${files.map(({ name, url }) => `첨부: ${name}(${url})`).join('\n')}`;
}

/** Only the trailing attachment block is interpreted; ordinary request text stays literal. */
export function parseCardRequest(request: string) {
  const lines = request.split('\n');
  const attachments: Array<CardAttachment & { image: boolean }> = [];
  while (lines.length) {
    const line = lines.at(-1)!;
    if (attachments.length && line === '') { lines.pop(); continue; }
    const match = /^첨부: (.*)\((https?:\/\/.*)\)$/.exec(line)
      ?? /^!?\[([^\]]*)\]\((https?:\/\/.*)\)$/.exec(line);
    if (!match) break;
    const [, name, url] = match;
    const parsed = new URL(url);
    const path = parsed.searchParams.get('path') ?? parsed.pathname;
    attachments.unshift({ name, url, image: /\.(png|jpe?g|gif|webp|heic|avif)$/i.test(path) });
    lines.pop();
  }
  if (attachments.length && lines.at(-1) === '') lines.pop();
  return { text: lines.join('\n'), attachments };
}
