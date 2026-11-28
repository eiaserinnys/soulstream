import assert from 'node:assert/strict';

const ALLOWED_LINK_KEYS = new Set(['call', 'include', 'section', 'when', 'note', 'pick', 'axis', 'top', 'optional']);

function* scanMarkdown(markdown) {
  let open = null;
  for (const line of markdown.split('\n')) {
    if (open) {
      const close = /^ {0,3}(`+|~+)\s*$/.exec(line);
      if (close && close[1][0] === open.char && close[1].length >= open.length) {
        if (open.isLink) yield { body: open.body.join('\n') };
        open = null;
      } else if (open.isLink) {
        let indent = 0;
        while (indent < open.indent && line[indent] === ' ') indent += 1;
        open.body.push(line.slice(indent));
      }
      continue;
    }
    const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      open = { char: fence[2][0], length: fence[2].length, indent: fence[1].length, isLink: fence[3].trim() === 'link', body: [] };
    } else {
      yield { line };
    }
  }
  if (open?.isLink) throw new Error('unclosed link code fence');
}

export function extractLinkBlocks(markdown) {
  return Array.from(scanMarkdown(markdown)).flatMap(({ body }) => body === undefined ? [] : [body]);
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((part) => parseScalar(part));
  }
  return value;
}

export function parseLinkBlockBody(body) {
  const fields = {};
  for (const line of body.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!match) throw new Error(`unreadable link block line: ${line}`);
    const [, key, raw] = match;
    if (!ALLOWED_LINK_KEYS.has(key)) throw new Error(`unknown link block key: ${key}`);
    if (key in fields) throw new Error(`duplicate link block key: ${key}`);
    fields[key] = parseScalar(raw);
  }
  const kinds = ['call', 'include', 'pick'].filter((key) => key in fields);
  if (kinds.length !== 1) throw new Error('link block must contain exactly one of call, include, or pick');
  const kind = kinds[0];
  const isString = (value) => typeof value === 'string' && value.trim().length > 0;
  if (kind === 'call') {
    if (!isString(fields.call)) throw new Error('call must be a non-empty skill name');
    for (const key of ['include', 'section', 'pick', 'axis', 'top', 'optional']) {
      if (key in fields) throw new Error(`call has keys belonging to another link kind: ${key}`);
    }
  } else if (kind === 'include') {
    if (!isString(fields.include)) throw new Error('include must be a non-empty document name');
    for (const key of ['call', 'pick', 'axis', 'top', 'optional', 'when']) {
      if (key in fields) throw new Error(`include has keys belonging to another link kind: ${key}`);
    }
    if ('section' in fields && typeof fields.section !== 'string') throw new Error('section must be a string');
  } else {
    if (fields.pick !== 'catalog') throw new Error('pick must be catalog');
    if (!Array.isArray(fields.axis) || fields.axis.length === 0 || fields.axis.some((axis) => !isString(axis))) {
      throw new Error('pick needs a non-empty string axis list');
    }
    for (const key of ['call', 'include', 'section', 'when']) {
      if (key in fields) throw new Error(`pick has keys belonging to another link kind: ${key}`);
    }
    const top = 'top' in fields ? fields.top : 1;
    const optional = 'optional' in fields ? fields.optional : false;
    if (!Number.isInteger(top) || top < 1 || typeof optional !== 'boolean') throw new Error('bad pick top/optional');
  }
  for (const key of ['note', 'when']) {
    if (key in fields && typeof fields[key] !== 'string') throw new Error(`${key} must be a string`);
  }
  return { kind, fields };
}

function normalizeHeading(value) {
  return value.replace(/<!--.*?-->/gs, '').replace(/`/g, '')
    .trim().replace(/^#{1,6}\s*/, '').trim().replace(/\s+/g, ' ');
}

export function compareLinkBlocks(lang, originalCards, localizedCards) {
  const byKey = new Map(localizedCards.map((card) => [card.key, card]));
  const byTitle = new Map(localizedCards.map((card) => [card.title, card]));
  const readBlocks = (card) => extractLinkBlocks(card.content ?? '').map(parseLinkBlockBody);
  for (const originalCard of originalCards) {
    const original = readBlocks(originalCard);
    const localized = readBlocks(byKey.get(originalCard.key));
    const context = `${lang} ${originalCard.key} link block`;
    assert.equal(localized.length, original.length, `${context} #${Math.min(original.length, localized.length) + 1} count`);
    for (const [index, { kind, fields }] of localized.entries()) {
      const at = `${context} #${index + 1}`;
      const expected = original[index];
      assert.equal(kind, expected.kind, `${at} kind`);
      assert.deepEqual(Object.keys(fields).sort(), Object.keys(expected.fields).sort(), `${at} keys`);
      for (const key of Object.keys(fields)) {
        if (['when', 'note', 'section'].includes(key)) continue;
        assert.deepEqual(fields[key], expected.fields[key], `${at} ${key}`);
      }
      if (kind === 'include' && fields.section) {
        const target = byTitle.get(fields.include);
        const bodyKey = target?.content?.match(/^body_node_id:[^\n]*\{\{node_id:([^}]+)\}\}/m)?.[1];
        const body = byKey.get(bodyKey)?.content;
        assert.ok(typeof body === 'string', `${at} include target: ${fields.include}`);
        const headings = Array.from(scanMarkdown(body)).flatMap(({ line }) => {
          const heading = line?.match(/^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/);
          return heading ? [normalizeHeading(heading[2])] : [];
        });
        assert.equal(headings.filter((heading) => heading === normalizeHeading(fields.section)).length, 1,
          `${at} section "${fields.section}" must match one heading in ${bodyKey}`);
      }
    }
  }
}
