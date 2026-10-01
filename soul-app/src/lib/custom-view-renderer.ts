import type { FolderSnapshot } from '../api/cardTypes';
import type { Session } from '../api/types';

export interface CustomViewBindingRecord {
  title?: string | null;
  status?: string | null;
  completed?: number | string | null;
  total?: number | string | null;
}

export interface CustomViewBindings {
  cards: Record<string, CustomViewBindingRecord>;
  folders: Record<string, CustomViewBindingRecord>;
  sessions: Record<string, CustomViewBindingRecord>;
}

const SOUL_BIND_RE = /<soul-bind\b([^>]*)>\s*<\/soul-bind>/gi;
const ATTRIBUTE_RE = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const CUSTOM_VIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'img-src data: https:',
  'frame-src https://pages.eiaserinnys.me',
].join('; ') + ';';

export function buildCustomViewBindings(
  snapshot: FolderSnapshot | null | undefined,
  sessions: Readonly<Record<string, Session>>,
): CustomViewBindings {
  const bindings: CustomViewBindings = {
    cards: {},
    folders: {},
    sessions: {},
  };
  for (const session of Object.values(sessions)) {
    bindings.sessions[session.agentSessionId] = {
      title: session.displayName || session.prompt || session.agentSessionId,
      status: session.status,
    };
  }
  if (!snapshot) return bindings;
  let completed = 0;
  let total = 0;
  for (const item of snapshot.cards) {
    if (item.archived || item.status === 'cancelled') continue;
    total += 1;
    if (item.status === 'done') completed += 1;
    bindings.cards[item.id] = { title: item.title, status: item.status };
  }
  bindings.folders[snapshot.folder.id] = { completed, total };
  return bindings;
}

export function renderCustomViewHtml(
  html: string,
  bindings: CustomViewBindings,
): string {
  const fragment = html.replace(SOUL_BIND_RE, (_match, raw: string) => {
    const attrs = parseAttributes(raw);
    return escapeHtml(bindingValue(attrs, bindings));
  });
  const meta = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(CUSTOM_VIEW_CSP)}">`;
  if (/<head[\s>]/i.test(fragment)) {
    return fragment.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
  }
  if (/<html[\s>]/i.test(fragment)) {
    return fragment.replace(/<html([^>]*)>/i, `<html$1><head>${meta}</head>`);
  }
  return `<!doctype html><html><head>${meta}</head><body>${fragment}</body></html>`;
}

function parseAttributes(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE_RE)) {
    result[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return result;
}

function bindingValue(
  attrs: Record<string, string>,
  bindings: CustomViewBindings,
): string {
  const { id, field, kind } = attrs;
  if (!id || !field) return '';
  if (kind === 'card' && (field === 'title' || field === 'status')) {
    return stringify(bindings.cards[id]?.[field]);
  }
  if (kind === 'folder' && (field === 'completed' || field === 'total')) {
    return stringify(bindings.folders[id]?.[field]);
  }
  if (kind === 'session' && (field === 'title' || field === 'status')) {
    return stringify(bindings.sessions[id]?.[field]);
  }
  return '';
}

function stringify(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return typeof value === 'string' ? value : '';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
