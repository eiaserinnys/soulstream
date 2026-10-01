/** Native previews render report text, never execute or mount its HTML. Detail keeps the original. */
export function postItActivityText(activity: { body: string; format: 'markdown' | 'html' }) {
  if (activity.format !== 'html') return activity.body;
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return activity.body.replace(/<(script|style|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(?:br|p|div|li|h[1-6]|tr)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&([a-z]+);/gi, (match, entity: string) => entities[entity.toLowerCase()] ?? match)
    .replace(/[^\S\n]+/g, ' ').replace(/\n+/g, '\n').trim();
}
