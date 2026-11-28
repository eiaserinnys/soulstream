import type { Node, ValidationIssue } from "./types.js";

export type UnknownRecord = Record<string, unknown>;
export const MAX_ISSUES = 20;
export const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
export const codePointLength = (value: string): number => [...value].length;
export function addIssue(issues: ValidationIssue[], path: string, reason: string): void {
  if (issues.length < MAX_ISSUES) issues.push({ path: path || "$", reason });
}

export function isPlainObject(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function inspectJsonValue(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  active: WeakSet<object>,
  depth: number,
  maxDepth: number,
): void {
  if (issues.length >= MAX_ISSUES) return;
  if (value === null) return;
  if (value === undefined) {
    addIssue(issues, path, "undefined는 사용할 수 없습니다.");
    return;
  }
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) addIssue(issues, path, "유한한 수만 사용할 수 있습니다.");
    return;
  }
  if (typeof value !== "object") {
    addIssue(issues, path, "JSON 값만 사용할 수 있습니다.");
    return;
  }
  if (depth > maxDepth) {
    addIssue(issues, path, "JSON 중첩 깊이가 허용 상한을 넘습니다.");
    return;
  }
  if (active.has(value)) {
    addIssue(issues, path, "순환하는 객체 참조는 사용할 수 없습니다.");
    return;
  }
  active.add(value);

  const array = Array.isArray(value);
  if (array) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      addIssue(issues, path, "일반 배열만 사용할 수 있습니다.");
      active.delete(value);
      return;
    }
    const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
    if (keys.some((key) => typeof key !== "string") || keys.length !== value.length) {
      addIssue(issues, path, "빈 칸이나 추가 속성이 없는 배열만 사용할 수 있습니다.");
      active.delete(value);
      return;
    }
    for (let index = 0; index < value.length && issues.length < MAX_ISSUES; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        addIssue(issues, `${path}[${index}]`, "열거 가능한 일반 데이터 속성만 사용할 수 있습니다.");
        continue;
      }
      inspectJsonValue(descriptor.value, `${path}[${index}]`, issues, active, depth + 1, maxDepth);
    }
    active.delete(value);
    return;
  }

  if (!isPlainObject(value)) {
    addIssue(issues, path, "일반 객체만 사용할 수 있습니다.");
    active.delete(value);
    return;
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string") {
      addIssue(issues, path, "문자열 키만 사용할 수 있습니다.");
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      addIssue(issues, path ? `${path}.${key}` : key, "열거 가능한 일반 데이터 속성만 사용할 수 있습니다.");
      continue;
    }
    inspectJsonValue(
      descriptor.value,
      path ? `${path}.${key}` : key,
      issues,
      active,
      depth + 1,
      maxDepth,
    );
    if (issues.length >= MAX_ISSUES) break;
  }
  active.delete(value);
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

const specs: Record<string, [string[], string[]]> = {
  stats: [['label', 'tiles'], ['tiles']], badge: [['label', 'tone'], ['label', 'tone']],
  table: [['label', 'columns', 'rows'], ['columns', 'rows']], list: [['label', 'numbered', 'items'], ['items']],
  bars: [['label', 'unit', 'max', 'series', 'items'], ['items']], line: [['label', 'unit', 'series', 'baseline'], ['series']],
  steps: [['items'], ['items']], compare: [['columns'], ['columns']], flow: [['nodes', 'edges'], ['nodes', 'edges']],
  image: [['attachment_id', 'alt', 'caption'], ['attachment_id', 'alt']], html: [['html', 'height', 'alt'], ['html', 'height', 'alt']],
};
export const displayNodeSpecs = specs;
const keyPattern = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const tones = ['neutral', 'good', 'warn', 'bad', 'info'];

type CheckPart = (value: unknown, path: string, issues: ValidationIssue[]) => void;
export function checkDisplayStructure(node: UnknownRecord, path: string, issues: ValidationIssue[], checkPart: CheckPart): void {
  const issue = (p: string, reason = '형식이 올바르지 않습니다.') => addIssue(issues, p, reason);
  const object = (v: unknown, p: string, allowed: string[], required: string[]): UnknownRecord | undefined => {
    if (!isPlainObject(v)) { issue(p, '객체가 필요합니다.'); return; }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) issue(`${p}.${k}`, '알 수 없는 키입니다.');
    for (const k of required) if (!hasOwn(v, k)) issue(`${p}.${k}`, '필수 값입니다.');
    return v;
  };
  const arr = (v: unknown, p: string, min: number, max: number): unknown[] => {
    if (!Array.isArray(v)) { issue(p, '배열이 필요합니다.'); return []; }
    if (v.length < min || v.length > max) issue(p, `${min}개에서 ${max}개까지 필요합니다.`);
    return v;
  };
  const str = (v: unknown, p: string) => { if (typeof v !== 'string') issue(p, '문자열이 필요합니다.'); };
  const key = (v: unknown, p: string) => { const match = typeof v === 'string' ? keyPattern.exec(v) : null; if (!match || match[0] !== v) issue(p, '올바른 키가 필요합니다.'); };
  const num = (v: unknown, p: string) => { if (typeof v !== 'number' || !Number.isFinite(v)) issue(p, '유한한 수가 필요합니다.'); };
  const bool = (v: unknown, p: string) => { if (typeof v !== 'boolean') issue(p, '불리언 값이 필요합니다.'); };
  const tone = (v: unknown, p: string) => { if (!tones.includes(v as string)) issue(p, '지원하지 않는 tone입니다.'); };
  const url = (v: unknown, p: string) => { if (typeof v !== 'string' || !v.startsWith('https://') || Array.from(v).length > 2000) issue(p, 'url은 2000자 이하의 https 주소여야 합니다.'); };
  const optional = (o: UnknownRecord, k: string, p: string, f: (v: unknown, path: string) => void) => { if (hasOwn(o, k)) f(o[k], `${p}.${k}`); };
  const display = (v: unknown, p: string) => { if (typeof v === 'number') num(v, p); else checkPart(v, p, issues); };
  const badge = (v: unknown, p: string) => { const o = object(v, p, ['label', 'tone'], ['label', 'tone']); if (o) { str(o.label, `${p}.label`); tone(o.tone, `${p}.tone`); } };
  const link = (v: unknown, p: string) => { const o = object(v, p, ['label', 'url'], ['label', 'url']); if (o) { str(o.label, `${p}.label`); url(o.url, `${p}.url`); } };
  optional(node, 'label', path, str);
  optional(node, 'unit', path, key);
  switch (node.kind) {
    case 'stats':
      arr(node.tiles, `${path}.tiles`, 2, 4).forEach((v, i) => { const p = `${path}.tiles[${i}]`; const o = object(v, p, ['label', 'value', 'unit', 'note', 'tone'], ['label', 'value']); if (!o) return; str(o.label, `${p}.label`); display(o.value, `${p}.value`); optional(o, 'unit', p, key); optional(o, 'note', p, str); optional(o, 'tone', p, tone); });
      break;
    case 'badge': tone(node.tone, `${path}.tone`); break;
    case 'table': {
      const cols = arr(node.columns, `${path}.columns`, 1, 8); const keys = new Set<string>();
      cols.forEach((v, i) => { const p = `${path}.columns[${i}]`; const o = object(v, p, ['key', 'label', 'type', 'wrap', 'unit'], ['key', 'label']); if (!o) return; key(o.key, `${p}.key`); str(o.label, `${p}.label`); if (typeof o.key === 'string') { if (keys.has(o.key)) issue(`${p}.key`, '열 key가 중복됩니다.'); keys.add(o.key); } if (hasOwn(o, 'type') && !['text', 'number', 'badge', 'link'].includes(o.type as string)) issue(`${p}.type`); optional(o, 'wrap', p, bool); optional(o, 'unit', p, key); });
      arr(node.rows, `${path}.rows`, 0, 50).forEach((v, i) => { const p = `${path}.rows[${i}]`; if (!isPlainObject(v)) { issue(p); return; } for (const [k, cell] of Object.entries(v)) { const cp = `${p}.${k}`; const col = cols.find(c => isPlainObject(c) && c.key === k); if (!isPlainObject(col)) { issue(cp, '열에 없는 key입니다.'); continue; } if (cell === null) continue; if (col.type === 'badge') badge(cell, cp); else if (col.type === 'link') link(cell, cp); else if (col.type === 'number' && typeof cell !== 'number' && !(isPlainObject(cell) && hasOwn(cell, 'value'))) issue(cp, '숫자 또는 숫자 참조가 필요합니다.'); else display(cell, cp); } });
      break;
    }
    case 'list': {
      optional(node, 'numbered', path, bool); const ids = new Set<string>();
      arr(node.items, `${path}.items`, 0, 50).forEach((v, i) => { const p = `${path}.items[${i}]`; const o = object(v, p, ['id', 'title', 'note', 'badge', 'value', 'url'], ['id', 'title']); if (!o) return; key(o.id, `${p}.id`); if (typeof o.id === 'string') { if (ids.has(o.id)) issue(`${p}.id`, 'id가 중복됩니다.'); ids.add(o.id); } str(o.title, `${p}.title`); optional(o, 'note', p, str); optional(o, 'badge', p, badge); optional(o, 'value', p, display); optional(o, 'url', p, url); }); break;
    }
    case 'bars': {
      optional(node, 'max', path, num); const series = hasOwn(node, 'series') ? arr(node.series, `${path}.series`, 2, 4) : undefined;
      series?.forEach((v, i) => { const p = `${path}.series[${i}]`; const o = object(v, p, ['key', 'label'], ['key', 'label']); if (o) { key(o.key, `${p}.key`); str(o.label, `${p}.label`); } });
      arr(node.items, `${path}.items`, 1, 20).forEach((v, i) => { const p = `${path}.items[${i}]`; const o = object(v, p, ['label', 'value', 'tone', 'excluded'], ['label', 'value']); if (!o) return; str(o.label, `${p}.label`); if (series) arr(o.value, `${p}.value`, series.length, series.length).forEach((n, j) => num(n, `${p}.value[${j}]`)); else num(o.value, `${p}.value`); optional(o, 'tone', p, tone); optional(o, 'excluded', p, bool); }); break;
    }
    case 'line':
      arr(node.series, `${path}.series`, 1, 4).forEach((v, i) => { const p = `${path}.series[${i}]`; const o = object(v, p, ['label', 'points'], ['label', 'points']); if (!o) return; str(o.label, `${p}.label`); let previous = -Infinity; arr(o.points, `${p}.points`, 2, 200).forEach((v, j) => { const q = `${p}.points[${j}]`; const pt = object(v, q, ['x', 'y'], ['x', 'y']); if (!pt) return; const time = typeof pt.x === 'string' && /^\d{4}-\d\d-\d\dT/.test(pt.x) ? Date.parse(pt.x) : NaN; if (!Number.isFinite(time) || time <= previous) issue(`${q}.x`, '오름차순 ISO 시각이 필요합니다.'); previous = time; num(pt.y, `${q}.y`); }); });
      if (hasOwn(node, 'baseline')) { const o = object(node.baseline, `${path}.baseline`, ['value', 'label'], ['value', 'label']); if (o) { num(o.value, `${path}.baseline.value`); str(o.label, `${path}.baseline.label`); } } break;
    case 'steps':
      arr(node.items, `${path}.items`, 1, 20).forEach((v, i) => { const p = `${path}.items[${i}]`; const o = object(v, p, ['title', 'state', 'note', 'time'], ['title', 'state']); if (!o) return; str(o.title, `${p}.title`); if (!['done', 'current', 'pending', 'failed'].includes(o.state as string)) issue(`${p}.state`); optional(o, 'note', p, str); optional(o, 'time', p, str); }); break;
    case 'compare': {
      let selected = 0; const ids = new Set<string>();
      arr(node.columns, `${path}.columns`, 2, 3).forEach((v, i) => { const p = `${path}.columns[${i}]`; const o = object(v, p, ['id', 'title', 'selected', 'items'], ['id', 'title', 'items']); if (!o) return; key(o.id, `${p}.id`); if (typeof o.id === 'string') { if (ids.has(o.id)) issue(`${p}.id`); ids.add(o.id); } str(o.title, `${p}.title`); optional(o, 'selected', p, bool); if (o.selected === true && ++selected > 1) issue(`${p}.selected`); arr(o.items, `${p}.items`, 1, 12).forEach((v, j) => { const q = `${p}.items[${j}]`; const item = object(v, q, ['mark', 'text'], ['text']); if (!item) return; if (hasOwn(item, 'mark') && !['yes', 'no', 'partial'].includes(item.mark as string)) issue(`${q}.mark`); display(item.text, `${q}.text`); }); }); break;
    }
    case 'flow': {
      const ids = new Set<string>(), positions = new Set<string>(), edges = new Set<string>();
      arr(node.nodes, `${path}.nodes`, 1, 12).forEach((v, i) => { const p = `${path}.nodes[${i}]`; const o = object(v, p, ['id', 'title', 'note', 'col', 'row', 'tone'], ['id', 'title', 'col', 'row']); if (!o) return; key(o.id, `${p}.id`); if (typeof o.id === 'string') { if (ids.has(o.id)) issue(`${p}.id`); ids.add(o.id); } str(o.title, `${p}.title`); optional(o, 'note', p, str); optional(o, 'tone', p, tone); for (const k of ['col', 'row']) if (![1, 2, 3, 4].includes(o[k] as number)) issue(`${p}.${k}`); const pos = `${o.col}:${o.row}`; if (positions.has(pos)) issue(p, '같은 칸을 사용할 수 없습니다.'); positions.add(pos); });
      arr(node.edges, `${path}.edges`, 0, 24).forEach((v, i) => { const p = `${path}.edges[${i}]`; const o = object(v, p, ['from', 'to', 'both'], ['from', 'to']); if (!o) return; for (const k of ['from', 'to']) { key(o[k], `${p}.${k}`); if (typeof o[k] === 'string' && !ids.has(o[k] as string)) issue(`${p}.${k}`, '노드를 찾을 수 없습니다.'); } if (o.from === o.to) issue(p, '자기 자신에게 연결할 수 없습니다.'); const pair = [o.from, o.to].sort().join(':'); if (edges.has(pair)) issue(p, '연결이 중복됩니다.'); edges.add(pair); optional(o, 'both', p, bool); }); break;
    }
    case 'image': str(node.attachment_id, `${path}.attachment_id`); str(node.alt, `${path}.alt`); if (typeof node.alt === 'string' && !node.alt.trim()) issue(`${path}.alt`); optional(node, 'caption', path, str); break;
    case 'html': str(node.html, `${path}.html`); if (typeof node.html === 'string' && utf8ByteLength(node.html) > 32768) issue(`${path}.html`); if (!Number.isInteger(node.height) || (node.height as number) < 80 || (node.height as number) > 480) issue(`${path}.height`); str(node.alt, `${path}.alt`); if (typeof node.alt === 'string' && !node.alt.trim()) issue(`${path}.alt`); break;
  }
}

export function visitDisplayValues(node: Node, path: string, check: (value: unknown, path: string, unit?: string, numeric?: boolean) => void): void {
  if (node.kind === 'stats') node.tiles.forEach((tile, i) => check(tile.value, `${path}.tiles[${i}].value`, tile.unit));
  if (node.kind === 'table') node.rows.forEach((row, i) => node.columns.forEach(column => { const cell = row[column.key]; if (cell !== undefined && cell !== null && (column.type === undefined || column.type === 'text' || column.type === 'number')) check(cell, `${path}.rows[${i}].${column.key}`, column.unit, column.type === 'number'); }));
  if (node.kind === 'list') node.items.forEach((item, i) => { if (item.value !== undefined) check(item.value, `${path}.items[${i}].value`); });
  if (node.kind === 'compare') node.columns.forEach((column, i) => column.items.forEach((item, j) => check(item.text, `${path}.columns[${i}].items[${j}].text`)));
}
