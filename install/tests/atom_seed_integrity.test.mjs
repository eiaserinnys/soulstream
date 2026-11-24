// Integrity checks for the approved public atom seed (card #1787 U10).
//
// The seed and the two portraits are published byte-for-byte as approved by
// the director; the sha256 comparison in the unit's verify step owns the
// byte-identity check. This file checks the seed's internal contract:
// shape, ordering, placeholders, link blocks, forbidden patterns, profile
// arguments and the portrait files.
//
// Link block rules are transcribed from the load_skill parser:
//   orch-server-ts/src/mcp/skill_handlers.ts (load_skill)
//   orch-server-ts/src/skills/link_blocks.ts:56-152 (fence scan + field rules)
// The TypeScript parser cannot be imported from a plain node:test file, so the
// fence grammar and field rules are re-implemented below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCreatePayload, placeholderKeys, validateSeed } from '../seed/load_atom_seed.mjs';

const SEED_PATH = fileURLToPath(new URL('../seed/atom-seed.json', import.meta.url));
const PORTRAIT_PATHS = {
  seosoyoung: fileURLToPath(new URL('../assets/portraits/seosoyoung.png', import.meta.url)),
  'seosoyoung-pas': fileURLToPath(new URL('../assets/portraits/seosoyoung-pas.png', import.meta.url)),
};

const SEED = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const CARDS = SEED.entries.filter((entry) => entry.entry_kind === 'card');
const SYMLINKS = SEED.entries.filter((entry) => entry.entry_kind === 'symlink');
const REPLACEMENTS = CARDS.filter((entry) => placeholderKeys(entry.content ?? '').length > 0);
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

function seedTexts() {
  const rows = [];
  for (const entry of SEED.entries) {
    rows.push([`title:${entry.key}`, entry.title ?? '']);
    rows.push([`content:${entry.key}`, entry.content ?? '']);
  }
  for (const [name, key] of Object.entries(SEED.exported_keys)) {
    rows.push([`exported:${name}`, String(key)]);
  }
  return rows;
}

test('seed shape: schema, entry counts, exported keys, roots', () => {
  assert.equal(SEED.schema_version, 1);
  assert.equal(SEED.entries.length, 189);
  assert.equal(CARDS.length, 159);
  assert.equal(SYMLINKS.length, 30);
  assert.equal(Object.keys(SEED.exported_keys).length, 20);
  const roots = SEED.entries.filter((entry) => (entry.parent ?? null) === null).map((entry) => entry.title);
  assert.deepEqual(roots, ['에이전트', '프로젝트', '실수 사례']);
});

test('validateSeed accepts the approved seed and rejects contract violations', () => {
  assert.doesNotThrow(() => validateSeed(SEED));
  const clone = () => structuredClone(SEED);
  const duplicate = clone();
  duplicate.entries.push(structuredClone(CARDS[0]));
  assert.throws(() => validateSeed(duplicate), /duplicate seed key/);

  const badKind = clone();
  badKind.entries.find((entry) => entry.entry_kind === 'card').entry_kind = 'folder';
  assert.throws(() => validateSeed(badKind), /invalid entry_kind/);

  const laterParent = clone();
  laterParent.entries.push({ key: 'zz.late.child', title: 'late', card_type: 'knowledge', parent: 'zz.not.yet', entry_kind: 'card', content: '' });
  assert.throws(() => validateSeed(laterParent), /not a preceding card/);

  const badTarget = clone();
  badTarget.entries.find((entry) => entry.entry_kind === 'symlink').symlink_target = 'no.such.card';
  assert.throws(() => validateSeed(badTarget), /targets a non-card key/);

  const symlinkKey = SYMLINKS[0].key;
  const badPlaceholder = clone();
  badPlaceholder.entries.find((entry) => entry.entry_kind === 'card').content = `{{node_id:${symlinkKey}}}`;
  assert.throws(() => validateSeed(badPlaceholder), /non-card key/);

  const badExport = clone();
  badExport.exported_keys = { ...badExport.exported_keys, broken: 'no.such.key' };
  assert.throws(() => validateSeed(badExport), /does not exist/);
});

test('titles are non-empty and at most 50 code points', () => {
  for (const entry of SEED.entries) {
    assert.equal(typeof entry.title, 'string');
    assert.ok(entry.title.length > 0, `empty title for ${entry.key}`);
    assert.ok([...entry.title].length <= 50, `title over 50 code points: ${entry.key}`);
  }
});

test('placeholders: 42 cards, 71 references, 62 distinct card keys, no card_id form', () => {
  const cardKeys = new Set(CARDS.map((entry) => entry.key));
  const distinct = new Set();
  let references = 0;
  for (const entry of REPLACEMENTS) {
    for (const key of placeholderKeys(entry.content ?? '')) {
      references += 1;
      distinct.add(key);
      assert.ok(cardKeys.has(key), `placeholder points at a non-card key: ${key}`);
    }
  }
  assert.equal(REPLACEMENTS.length, 42);
  assert.equal(references, 71);
  assert.equal(distinct.size, 62);
  for (const [, text] of seedTexts()) {
    assert.equal(text.includes('{{card_id:'), false, 'seed must not use the {{card_id: placeholder form');
  }
  assert.equal(SYMLINKS.some((entry) => entry.content !== undefined), false, 'symlink entries must not carry content');
});

test('buildCreatePayload: 159 creates, seed order, positions, body under the Fastify limit', () => {
  const installId = '00000000-0000-4000-8000-000000000000';
  const payload = buildCreatePayload(SEED, installId);
  assert.equal(payload.creates.length, 159);
  assert.deepEqual(payload.creates.map((item) => item.temp_id), CARDS.map((entry) => entry.key));
  const size = Buffer.byteLength(JSON.stringify(payload));
  assert.ok(size < 1_048_576, `batch body is ${size} bytes`);

  const counters = new Map();
  for (const entry of SEED.entries) {
    const parent = entry.parent ?? null;
    const index = counters.get(parent) ?? 0;
    counters.set(parent, index + 1);
    if (entry.entry_kind !== 'card') continue;
    const item = payload.creates.find((create) => create.temp_id === entry.key);
    assert.equal(item.position, 100 * (index + 1), `position mismatch for ${entry.key}`);
    if (parent === null) assert.equal('parent_temp_id' in item, false, `root create ${entry.key} must omit parent_temp_id`);
    else assert.equal(item.parent_temp_id, parent);
    assert.equal(item.source_type, 'soulstream-seed');
    assert.equal(item.source_ref, `${installId}:${entry.key}`);
  }
});

// --- link blocks -----------------------------------------------------------

const ALLOWED_LINK_KEYS = new Set(['call', 'include', 'section', 'when', 'note', 'pick', 'axis', 'top', 'optional']);

function extractLinkBlocks(markdown) {
  const lines = String(markdown).split('\n');
  const blocks = [];
  let open = null;
  for (const line of lines) {
    if (open) {
      const close = /^ {0,3}(`+|~+)\s*$/.exec(line);
      if (close && close[1][0] === open.char && close[1].length >= open.length) {
        blocks.push(open.body.join('\n'));
        open = null;
      } else {
        let indent = 0;
        while (indent < open.indent && line[indent] === ' ') indent += 1;
        open.body.push(line.slice(indent));
      }
      continue;
    }
    const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence && fence[3].trim() === 'link') open = { char: fence[2][0], length: fence[2].length, indent: fence[1].length, body: [] };
  }
  if (open) throw new Error('unclosed link code fence');
  return blocks;
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

function parseLinkBlockBody(body) {
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

test('link blocks follow the load_skill rules and contain only placeholder node references', () => {
  let blockCount = 0;
  for (const entry of CARDS) {
    for (const body of extractLinkBlocks(entry.content ?? '')) {
      blockCount += 1;
      assert.doesNotThrow(() => parseLinkBlockBody(body), `invalid link block in ${entry.key}`);
      assert.equal(UUID_RE.test(body), false, `raw node id inside a link block of ${entry.key}`);
      UUID_RE.lastIndex = 0;
      for (const line of body.split('\n')) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
        if (!match) continue;
        if (!/node_?id/i.test(match[1])) continue;
        assert.match(match[2].trim(), /^\{\{node_id:[^}]+\}\}$/, `node reference must be a placeholder in ${entry.key}`);
      }
    }
  }
  assert.ok(blockCount > 0, 'the seed is expected to contain link blocks');
});

// --- forbidden patterns ----------------------------------------------------

test('forbidden patterns: no UUID, email, non-loopback IPv4, private home path or .ts.net', () => {
  const emailRe = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  const ipv4Re = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  const homeRe = /\/home\/([^/\s"'`)\]}]+)/g;
  const tsNetRe = /\.ts\.net\b/g;
  for (const [where, text] of seedTexts()) {
    assert.equal(UUID_RE.test(text), false, `UUID at ${where}`);
    UUID_RE.lastIndex = 0;
    for (const match of text.matchAll(emailRe)) {
      const domain = match[1].toLowerCase();
      assert.ok(domain === 'example.com' || domain === 'example.org', `email at ${where}: ${match[0]}`);
    }
    for (const match of text.matchAll(ipv4Re)) {
      const [a] = match[0].split('.').map(Number);
      const loopback = a === 127;
      assert.ok(loopback, `non-loopback IPv4 at ${where}: ${match[0]}`);
    }
    for (const match of text.matchAll(homeRe)) {
      if (['soulstream', 'user', '...'].includes(match[1])) continue;
      assert.fail(`private home path at ${where}: ${match[0]}`);
    }
    tsNetRe.lastIndex = 0;
    assert.equal(tsNetRe.test(text), false, `.ts.net at ${where}`);
  }
});

// --- install profile arguments ---------------------------------------------

test('agent_id / profile / mcp_profile arguments match the install profile set', () => {
  const allowed = {
    agent_id: new Set(['seosoyoung', 'seosoyoung-pas', 'card-orchestrator', 'claude-default', 'codex-default', 'antigravity-default']),
    agentId: new Set(['seosoyoung', 'seosoyoung-pas', 'card-orchestrator', 'claude-default', 'codex-default', 'antigravity-default']),
    profile: new Set(['default', 'pas']),
    mcp_profile: new Set(['default', 'pas']),
  };
  const placeholder = '실행할-에이전트-ID';
  const assignmentRe = /(?:^|[^\w-])["']?(agent_id|agentId|mcp_profile|profile)["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;)}\]]+))/g;
  let seen = 0;
  for (const entry of CARDS) {
    for (const match of (entry.content ?? '').matchAll(assignmentRe)) {
      const name = match[1];
      const value = match[2] ?? match[3] ?? match[4];
      seen += 1;
      if (name === 'agent_id' || name === 'agentId') {
        assert.ok(allowed[name].has(value) || value === placeholder, `unknown agent id in ${entry.key}: ${value}`);
      } else {
        assert.ok(allowed[name].has(value), `unknown ${name} in ${entry.key}: ${value}`);
      }
    }
  }
  assert.ok(seen >= 4, `expected the seed profile arguments, found ${seen}`);
});

// --- portraits -------------------------------------------------------------

test('portraits: PNG signature, no text chunks, under 1 MiB', () => {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const FORBIDDEN = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf']);
  for (const [name, file] of Object.entries(PORTRAIT_PATHS)) {
    const buffer = fs.readFileSync(file);
    assert.ok(buffer.length < 1024 * 1024, `${name} portrait exceeds 1 MiB`);
    assert.deepEqual(buffer.subarray(0, 8), PNG_SIGNATURE, `${name} portrait is not a PNG`);
    let offset = 8;
    const types = [];
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString('latin1', offset + 4, offset + 8);
      types.push(type);
      offset += 12 + length;
      if (type === 'IEND') break;
    }
    assert.ok(types.includes('IHDR') && types.includes('IEND'), `${name} portrait is missing IHDR/IEND`);
    for (const type of types) assert.equal(FORBIDDEN.has(type), false, `${name} portrait contains ${type}`);
  }
});
