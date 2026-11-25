#!/usr/bin/env node
// Clean-install atom seed loader.
//
// Loads the approved public seed (install/seed/atom-seed.json) into a freshly
// installed atom instance through the password-login HTTP contract. The three
// local state files live in stateDir and make every step resumable:
//
//   .atom-seed-state.json      (0600) install_id, phase, seed sha256, key map
//   .atom-seed-inprogress.json (0600) byte copy of the seed used for the run
//   .atom-seed-map.json        (0644) exported name -> node id (null = deleted)
//
// Phases: creating -> created -> symlinked -> completed. Every step re-reads
// before writing, so a run that stopped on a lost response can be resumed
// without resending the same write.
//
// CLI:
//   node install/seed/load_atom_seed.mjs --atom-url <url> \
//     --password-file <path> --state-dir <dir> [--seed <path>]
//
// HTTP rules: one password login per run; a single re-login plus a restart of
// the state machine when any request answers 401; abort on 403, 429, 5xx,
// network errors and lost responses (a response body that cannot be read).
// Passwords, cookies and response bodies are never printed.

import { createHash, randomUUID as defaultRandomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SEED_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'atom-seed.json');
const SEED_SOURCE_TYPE = 'soulstream-seed';
const STATE_FILE = '.atom-seed-state.json';
const INPROGRESS_FILE = '.atom-seed-inprogress.json';
const MAP_FILE = '.atom-seed-map.json';
const STATE_SCHEMA = 1;
const REQUEST_TIMEOUT_MS = 30_000;
const PLACEHOLDER_RE = /\{\{node_id:([^}]+)\}\}/g;

const CARD_KEYS = new Set(['card', 'symlink']);

export class SeedLoadError extends Error {
  constructor(step, method, pathName, status, message) {
    super(message ?? `atom seed failed: step=${step} method=${method} path=${pathName} status=${status}`);
    this.name = 'SeedLoadError';
    this.step = step;
    this.method = method;
    this.path = pathName;
    this.status = status;
  }
}

class Reauth extends Error {
  constructor(step, method, pathName) {
    super('re-login required');
    this.name = 'Reauth';
    this.step = step;
    this.method = method;
    this.path = pathName;
  }
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function dedupe(list) {
  return [...new Set(list)];
}

function sortedObject(entries) {
  const out = {};
  for (const key of Object.keys(entries).sort()) out[key] = entries[key];
  return out;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/** Returns every placeholder key in the order it appears (duplicates kept). */
export function placeholderKeys(content) {
  const text = typeof content === 'string' ? content : '';
  const keys = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) keys.push(match[1]);
  return keys;
}

/** Replaces every {{node_id:<key>}} with the node id recorded for that key. */
export function renderContent(content, keyMap) {
  return String(content ?? '').replace(PLACEHOLDER_RE, (_full, key) => {
    const entry = keyMap?.[key];
    if (!entry?.node_id) throw new Error(`no node id recorded for placeholder key: ${key}`);
    return entry.node_id;
  });
}

/**
 * Validates the seed contract before any atom call.
 * key uniqueness, entry kinds, parent-before-child, symlink targets and
 * placeholder keys resolve to cards, exported keys exist.
 */
export function validateSeed(seed) {
  if (!seed || typeof seed !== 'object' || !Array.isArray(seed.entries)) {
    throw new Error('seed.entries must be an array');
  }
  const keys = new Set();
  const cardKeys = new Set();
  for (const entry of seed.entries) {
    if (typeof entry.key !== 'string' || entry.key.length === 0) throw new Error('seed entry key must be a non-empty string');
    if (keys.has(entry.key)) throw new Error(`duplicate seed key: ${entry.key}`);
    keys.add(entry.key);
    if (!CARD_KEYS.has(entry.entry_kind)) throw new Error(`invalid entry_kind for ${entry.key}: ${entry.entry_kind}`);
    if (entry.entry_kind === 'card') {
      if (typeof entry.title !== 'string' || entry.title.length === 0) throw new Error(`card entry ${entry.key} needs a title`);
      cardKeys.add(entry.key);
    }
  }
  const seenCards = new Set();
  for (const entry of seed.entries) {
    const parent = entry.parent ?? null;
    if (parent !== null && !seenCards.has(parent)) {
      throw new Error(`parent of ${entry.key} is not a preceding card: ${parent}`);
    }
    if (entry.entry_kind === 'card') {
      seenCards.add(entry.key);
      for (const key of placeholderKeys(entry.content ?? '')) {
        if (!cardKeys.has(key)) throw new Error(`placeholder in ${entry.key} points at a non-card key: ${key}`);
      }
    } else if (!cardKeys.has(entry.symlink_target)) {
      throw new Error(`symlink ${entry.key} targets a non-card key: ${entry.symlink_target}`);
    }
  }
  const exported = seed.exported_keys;
  if (!exported || typeof exported !== 'object' || Array.isArray(exported)) throw new Error('seed.exported_keys must be an object');
  for (const [name, key] of Object.entries(exported)) {
    if (!keys.has(key)) throw new Error(`exported key ${name} does not exist: ${key}`);
  }
}

/**
 * Builds the single POST /batch body. Card entries become creates in seed
 * order; `position` is the sibling number in seed order (cards and symlinks
 * counted together) times 100.
 */
export function buildCreatePayload(seed, installId) {
  const counters = new Map();
  const creates = [];
  for (const entry of seed.entries) {
    const parent = entry.parent ?? null;
    const index = counters.get(parent) ?? 0;
    counters.set(parent, index + 1);
    if (entry.entry_kind !== 'card') continue;
    const item = {
      temp_id: entry.key,
      card_type: entry.card_type,
      title: entry.title,
      content: entry.content ?? null,
      source_type: SEED_SOURCE_TYPE,
      source_ref: `${installId}:${entry.key}`,
      position: 100 * (index + 1),
    };
    if (entry.tags !== undefined) item.tags = entry.tags;
    if (parent !== null) item.parent_temp_id = parent;
    creates.push(item);
  }
  return { creates };
}

function siblingPositions(seed) {
  const counters = new Map();
  const positions = new Map();
  for (const entry of seed.entries) {
    const parent = entry.parent ?? null;
    const index = counters.get(parent) ?? 0;
    counters.set(parent, index + 1);
    positions.set(entry.key, 100 * (index + 1));
  }
  return positions;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

let tempCounter = 0;

function writeFileAtomic(file, data, mode) {
  const temp = `${file}.tmp-${process.pid}-${tempCounter++}`;
  const fd = fs.openSync(temp, 'w', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, file);
}

function readJsonFile(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new SeedLoadError(label, 'LOCAL', file, 'local', `cannot read ${path.basename(file)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SeedLoadError(label, 'LOCAL', file, 'local', `${path.basename(file)} is not valid JSON; refusing to overwrite it`);
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

class SeedEngine {
  constructor(options) {
    this.atomUrl = options.atomUrl.replace(/\/+$/, '');
    this.password = options.password;
    this.seedBytes = options.seedBytes;
    this.seed = options.seed;
    this.fetchImpl = options.fetchImpl;
    this.randomUUID = options.randomUUID;
    this.stateDir = options.stateDir;
    this.statePath = path.join(this.stateDir, STATE_FILE);
    this.inprogressPath = path.join(this.stateDir, INPROGRESS_FILE);
    this.mapPath = path.join(this.stateDir, MAP_FILE);
    this.cookie = null;
  }

  async login() {
    const pathName = '/api/auth/password-login';
    let response;
    try {
      response = await this.fetchImpl(`${this.atomUrl}${pathName}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: this.password }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new SeedLoadError('login', 'POST', pathName, 'network');
    }
    try {
      await response.text();
    } catch {
      throw new SeedLoadError('login', 'POST', pathName, 'network');
    }
    if (response.status !== 200) throw new SeedLoadError('login', 'POST', pathName, response.status);
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    const auth = cookies.find((line) => line.startsWith('atom_auth='));
    if (!auth) throw new SeedLoadError('login', 'POST', pathName, 'local', 'password-login response has no atom_auth cookie');
    const end = auth.indexOf(';');
    this.cookie = end === -1 ? auth : auth.slice(0, end);
  }

  async request(step, method, pathName, options = {}) {
    const { body, accept = [200] } = options;
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers['cookie'] = this.cookie;
    let response;
    try {
      response = await this.fetchImpl(`${this.atomUrl}${pathName}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new SeedLoadError(step, method, pathName, 'network');
    }
    if (response.status === 401) {
      try {
        await response.arrayBuffer();
      } catch {
        // The request was rejected anyway; a body failure changes nothing.
      }
      throw new Reauth(step, method, pathName);
    }
    if (!accept.includes(response.status)) {
      try {
        await response.arrayBuffer();
      } catch {
        // Body content is never printed; draining is best effort.
      }
      throw new SeedLoadError(step, method, pathName, response.status);
    }
    if (response.status === 204) return { status: 204, json: null };
    try {
      return { status: response.status, json: await response.json() };
    } catch {
      throw new SeedLoadError(step, method, pathName, 'network');
    }
  }

  readState() {
    return readJsonFile(this.statePath, 'state');
  }

  writeState(state) {
    writeFileAtomic(this.statePath, `${JSON.stringify(state)}\n`, 0o600);
  }

  writeInprogress(bytes) {
    writeFileAtomic(this.inprogressPath, bytes, 0o600);
  }

  readMap() {
    return readJsonFile(this.mapPath, 'map');
  }

  writeMap(map) {
    writeFileAtomic(this.mapPath, `${JSON.stringify(sortedObject(map), null, 2)}\n`, 0o644);
  }

  buildMap(state) {
    const map = {};
    for (const [name, key] of Object.entries(state.exported_keys ?? {})) {
      map[name] = state.key_map?.[key]?.node_id ?? null;
    }
    return map;
  }

  loadPendingSeed(state) {
    const step = 'resume';
    let bytes;
    try {
      bytes = fs.readFileSync(this.inprogressPath);
    } catch {
      throw new SeedLoadError(step, 'LOCAL', this.inprogressPath, 'local', 'in-progress seed copy is missing');
    }
    if (sha256Hex(bytes) !== state.seed_sha256) {
      throw new SeedLoadError(step, 'LOCAL', this.inprogressPath, 'local', 'in-progress seed copy does not match state.seed_sha256');
    }
    let seed;
    try {
      seed = JSON.parse(bytes.toString('utf8'));
      validateSeed(seed);
    } catch (error) {
      throw new SeedLoadError(step, 'LOCAL', this.inprogressPath, 'local', `in-progress seed copy is invalid: ${error.message}`);
    }
    return seed;
  }

  async run() {
    const state = this.readState();
    if (state === null) return this.startFresh();
    if (state.phase === 'completed') return this.runCompleted(state);
    if (!['creating', 'created', 'symlinked'].includes(state.phase)) {
      throw new SeedLoadError('state', 'LOCAL', this.statePath, 'local', `unknown phase: ${state.phase}`);
    }
    const seed = this.loadPendingSeed(state);
    if (state.phase === 'creating') return this.runCreating(state, seed);
    if (state.phase === 'created') return this.runSymlinks(state, seed);
    return this.runReplacements(state, seed);
  }

  async startFresh() {
    const roots = await this.request('init', 'GET', '/tree');
    if (!Array.isArray(roots.json)) throw new SeedLoadError('init', 'GET', '/tree', 'local', 'GET /tree did not return an array');
    if (roots.json.length > 0) {
      const warnings = [];
      let map = this.readMap();
      let changed = false;
      if (map === null) {
        map = {};
        changed = true;
      } else {
        for (const [name, nodeId] of Object.entries(map)) {
          if (!nodeId) continue;
          const found = await this.request('preserve', 'GET', `/tree/${nodeId}`, { accept: [200, 404] });
          if (found.status === 404) {
            map[name] = null;
            changed = true;
            warnings.push(`exported node deleted: ${name}`);
          }
        }
      }
      if (changed) this.writeMap(map);
      warnings.push('existing atom tree found; seed not loaded');
      return { phase: 'preserved', warnings: dedupe(warnings), conflicts: [] };
    }
    this.writeInprogress(this.seedBytes);
    const state = {
      schema: STATE_SCHEMA,
      install_id: this.randomUUID(),
      phase: 'creating',
      seed_sha256: sha256Hex(this.seedBytes),
      exported_keys: this.seed.exported_keys,
      key_map: {},
      conflicts: [],
      warnings: [],
    };
    this.writeState(state);
    return this.runCreating(state, this.seed);
  }

  async runCreating(state, seed) {
    const installId = state.install_id;
    const roots = await this.request('create', 'GET', '/tree');
    if (!Array.isArray(roots.json)) throw new SeedLoadError('create', 'GET', '/tree', 'local', 'GET /tree did not return an array');
    const markers = await this.scanMarkers(roots.json, installId);
    const cardEntries = seed.entries.filter((entry) => entry.entry_kind === 'card');
    const cardKeySet = new Set(cardEntries.map((entry) => entry.key));

    if (markers.size === 0) {
      if (roots.json.length > 0) {
        throw new SeedLoadError('create', 'POST', '/batch', 'local', 'tree changed before seed creation');
      }
      const payload = buildCreatePayload(seed, installId);
      const created = await this.request('create', 'POST', '/batch', { body: payload });
      const items = created.json?.created;
      if (!Array.isArray(items) || items.length !== cardEntries.length) {
        throw new SeedLoadError('create', 'POST', '/batch', 'local', `batch created ${Array.isArray(items) ? items.length : 'no'} cards; expected ${cardEntries.length}`);
      }
      const keyMap = {};
      for (const item of items) keyMap[item.temp_id] = { card_id: item.card_id, node_id: item.node_id };
      for (const entry of cardEntries) {
        if (!keyMap[entry.key]) throw new SeedLoadError('create', 'POST', '/batch', 'local', `batch response is missing seed key: ${entry.key}`);
      }
      state.key_map = keyMap;
      state.phase = 'created';
      this.writeState(state);
      return this.runSymlinks(state, seed);
    }

    if (markers.size !== cardEntries.length) {
      throw new SeedLoadError('create', 'GET', '/tree', 'local', `seed markers are partial: ${markers.size} of ${cardEntries.length}`);
    }
    const keyMap = {};
    for (const [key, nodes] of markers) {
      if (!cardKeySet.has(key)) throw new SeedLoadError('create', 'GET', '/tree', 'local', `unexpected seed marker: ${key}`);
      if (nodes.length !== 1) throw new SeedLoadError('create', 'GET', '/tree', 'local', `duplicate seed marker: ${key}`);
      keyMap[key] = { card_id: nodes[0].card_id, node_id: nodes[0].id };
    }
    for (const entry of cardEntries) {
      if (!keyMap[entry.key]) throw new SeedLoadError('create', 'GET', '/tree', 'local', `seed marker is missing: ${entry.key}`);
    }
    state.key_map = keyMap;
    state.phase = 'created';
    this.writeState(state);
    return this.runSymlinks(state, seed);
  }

  async scanMarkers(roots, installId) {
    const prefix = `${installId}:`;
    const markers = new Map();
    const queue = [...roots];
    const visited = new Set();
    while (queue.length > 0) {
      const node = queue.shift();
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      if (node.is_symlink) continue;
      const card = node.card;
      if (card?.source_type === SEED_SOURCE_TYPE && typeof card.source_ref === 'string' && card.source_ref.startsWith(prefix)) {
        const key = card.source_ref.slice(prefix.length);
        const list = markers.get(key) ?? [];
        list.push(node);
        markers.set(key, list);
      }
      const children = await this.request('create', 'GET', `/tree/${node.id}/children`);
      if (!Array.isArray(children.json)) throw new SeedLoadError('create', 'GET', `/tree/${node.id}/children`, 'local', 'children response is not an array');
      queue.push(...children.json);
    }
    return markers;
  }

  async runSymlinks(state, seed) {
    const positions = siblingPositions(seed);
    for (const entry of seed.entries) {
      if (entry.entry_kind !== 'symlink') continue;
      const target = state.key_map?.[entry.symlink_target];
      const parent = state.key_map?.[entry.parent];
      if (!target || !parent) throw new SeedLoadError('symlink', 'LOCAL', entry.key, 'local', `key map is missing an entry for ${entry.key}`);
      const cardPath = `/cards/${target.card_id}`;
      const card = await this.request('symlink', 'GET', cardPath, { accept: [200, 404] });
      if (card.status === 404) throw new SeedLoadError('symlink', 'GET', cardPath, 404, 'seed source card is missing');
      if (card.json?.source_ref !== `${state.install_id}:${entry.symlink_target}`) {
        throw new SeedLoadError('symlink', 'GET', cardPath, 'local', 'seed source card ownership check failed');
      }
      const children = await this.request('symlink', 'GET', `/tree/${parent.node_id}/children`);
      if (!Array.isArray(children.json)) throw new SeedLoadError('symlink', 'GET', `/tree/${parent.node_id}/children`, 'local', 'children response is not an array');
      const existing = children.json.find((node) => node.is_symlink === true && node.card_id === target.card_id);
      let nodeId = existing?.id;
      if (!nodeId) {
        const pathName = '/tree/symlink';
        const created = await this.request('symlink', 'POST', pathName, {
          accept: [201],
          body: { card_id: target.card_id, parent_node_id: parent.node_id, position: positions.get(entry.key) },
        });
        nodeId = created.json?.id;
        if (!nodeId) throw new SeedLoadError('symlink', 'POST', pathName, 'local', 'symlink response has no node id');
      }
      state.key_map[entry.key] = { card_id: target.card_id, node_id: nodeId };
      this.writeState(state);
    }
    state.phase = 'symlinked';
    this.writeState(state);
    return this.runReplacements(state, seed);
  }

  async runReplacements(state, seed) {
    const replacements = seed.entries.filter(
      (entry) => entry.entry_kind === 'card' && placeholderKeys(entry.content ?? '').length > 0
    );
    const conflicts = [];
    const warnings = [];
    const addConflict = (key, reason) => {
      conflicts.push({ key, reason });
      warnings.push(`seed card kept because it was changed: ${key} (${reason})`);
    };

    for (const entry of replacements) {
      const mapped = state.key_map?.[entry.key];
      if (!mapped) throw new SeedLoadError('replace', 'LOCAL', entry.key, 'local', `key map is missing an entry for ${entry.key}`);
      const pathName = `/cards/${mapped.card_id}`;
      const raw = entry.content ?? '';
      const rendered = renderContent(raw, state.key_map);
      const found = await this.request('replace', 'GET', pathName, { accept: [200, 404] });
      if (found.status === 404) {
        addConflict(entry.key, 'deleted');
        continue;
      }
      const card = found.json;
      if (card?.source_ref !== `${state.install_id}:${entry.key}`) {
        addConflict(entry.key, 'ownership');
        continue;
      }
      if (card.content === rendered) continue;
      if (card.version === 1 && card.content === raw) {
        const put = await this.request('replace', 'PUT', pathName, {
          accept: [200, 404, 409],
          body: { content: rendered, expected_version: 1 },
        });
        if (put.status === 200) continue;
        let current = put;
        if (put.status !== 404) current = await this.request('replace', 'GET', pathName, { accept: [200, 404] });
        if (current.status === 404) {
          addConflict(entry.key, 'deleted');
          continue;
        }
        if (current.json?.content === rendered) continue;
      }
      addConflict(entry.key, 'edited');
    }

    state.conflicts = conflicts;
    const conflictKeys = new Set(conflicts.map((conflict) => conflict.key));
    let seededReferences = 0;
    let conflictedReferences = 0;
    for (const entry of replacements) {
      const count = placeholderKeys(entry.content ?? '').length;
      seededReferences += count;
      if (conflictKeys.has(entry.key)) conflictedReferences += count;
    }
    let verifiedReferences = 0;
    for (const entry of replacements) {
      if (conflictKeys.has(entry.key)) continue;
      const mapped = state.key_map[entry.key];
      const pathName = `/cards/${mapped.card_id}`;
      const rendered = renderContent(entry.content ?? '', state.key_map);
      const found = await this.request('verify', 'GET', pathName, { accept: [200, 404] });
      const text = found.status === 200 ? found.json?.content ?? '' : null;
      if (text === null || text !== rendered) {
        throw new SeedLoadError('verify', 'GET', pathName, 'local', `replacement verification failed for ${entry.key}`);
      }
      if (text.includes('{{node_id:') || text.includes('{{card_id:')) {
        throw new SeedLoadError('verify', 'GET', pathName, 'local', `unresolved placeholder remains in ${entry.key}`);
      }
      verifiedReferences += placeholderKeys(entry.content ?? '').length;
    }
    if (verifiedReferences !== seededReferences - conflictedReferences) {
      throw new SeedLoadError('verify', 'GET', '/cards', 'local', 'resolved reference count does not match the seed');
    }

    this.writeMap(this.buildMap(state));
    state.phase = 'completed';
    this.writeState(state);
    try {
      fs.unlinkSync(this.inprogressPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new SeedLoadError('finish', 'LOCAL', this.inprogressPath, 'local', 'cannot remove the in-progress seed copy');
    }
    return { phase: 'completed', warnings: dedupe(warnings), conflicts };
  }

  async runCompleted(state) {
    const warnings = [];
    const map = {};
    for (const [name, key] of Object.entries(state.exported_keys ?? {})) {
      const nodeId = state.key_map?.[key]?.node_id ?? null;
      if (!nodeId) {
        map[name] = null;
        continue;
      }
      const found = await this.request('completed', 'GET', `/tree/${nodeId}`, { accept: [200, 404] });
      map[name] = found.status === 404 ? null : nodeId;
      if (found.status === 404) warnings.push(`exported node deleted: ${name}`);
    }
    const sorted = sortedObject(map);
    const existing = this.readMap();
    if (existing === null || JSON.stringify(sortedObject(existing)) !== JSON.stringify(sorted)) this.writeMap(sorted);
    if (!Array.isArray(state.warnings)) state.warnings = [];
    let stateChanged = false;
    for (const warning of warnings) {
      if (state.warnings.includes(warning)) continue;
      state.warnings.push(warning);
      stateChanged = true;
    }
    if (stateChanged) this.writeState(state);
    const conflicts = Array.isArray(state.conflicts) ? state.conflicts : [];
    const conflictWarnings = conflicts.map(
      (conflict) => `seed card kept because it was changed: ${conflict.key} (${conflict.reason})`
    );
    return { phase: 'completed', warnings: dedupe([...warnings, ...conflictWarnings]), conflicts };
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Loads the seed into the atom at atomUrl. Returns
 * { phase: "completed" | "preserved", warnings, conflicts }.
 * Throws SeedLoadError on abort.
 */
export async function loadAtomSeed({
  atomUrl,
  password,
  stateDir,
  seedPath = DEFAULT_SEED_PATH,
  fetchImpl = globalThis.fetch,
  randomUUID = defaultRandomUUID,
}) {
  if (typeof atomUrl !== 'string' || atomUrl.length === 0) throw new Error('atomUrl is required');
  if (typeof password !== 'string') throw new Error('password is required');
  if (typeof stateDir !== 'string' || stateDir.length === 0) throw new Error('stateDir is required');

  let seedBytes;
  try {
    seedBytes = fs.readFileSync(seedPath);
  } catch {
    throw new SeedLoadError('load-seed', 'LOCAL', seedPath, 'local', 'cannot read the seed file');
  }
  let seed;
  try {
    seed = JSON.parse(seedBytes.toString('utf8'));
  } catch {
    throw new SeedLoadError('load-seed', 'LOCAL', seedPath, 'local', 'seed file is not valid JSON');
  }
  try {
    validateSeed(seed);
  } catch (error) {
    throw new SeedLoadError('validate-seed', 'LOCAL', seedPath, 'local', error.message);
  }
  fs.mkdirSync(stateDir, { recursive: true });

  const engine = new SeedEngine({ atomUrl, password, stateDir, seedBytes, seed, fetchImpl, randomUUID });
  await engine.login();
  let relogged = false;
  for (;;) {
    try {
      return await engine.run();
    } catch (error) {
      if (!(error instanceof Reauth)) throw error;
      if (relogged) throw new SeedLoadError(error.step, error.method, error.path, 401);
      relogged = true;
      await engine.login();
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--atom-url' && value !== undefined) {
      options.atomUrl = value;
      index += 1;
    } else if (arg === '--password-file' && value !== undefined) {
      options.passwordFile = value;
      index += 1;
    } else if (arg === '--state-dir' && value !== undefined) {
      options.stateDir = value;
      index += 1;
    } else if (arg === '--seed' && value !== undefined) {
      options.seedPath = value;
      index += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  for (const name of ['atomUrl', 'passwordFile', 'stateDir']) {
    if (!options[name]) throw new Error(`missing required option: --${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  let password;
  try {
    password = fs.readFileSync(options.passwordFile, 'utf8').trim();
  } catch {
    process.stderr.write(`atom seed failed: password file is not readable\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const result = await loadAtomSeed({
      atomUrl: options.atomUrl,
      password,
      stateDir: options.stateDir,
      seedPath: options.seedPath ?? DEFAULT_SEED_PATH,
    });
    process.stdout.write(`atom seed: ${result.phase}\n`);
    const lines = dedupe([
      ...result.warnings,
      ...result.conflicts.map((conflict) => `seed card kept because it was changed: ${conflict.key} (${conflict.reason})`),
    ]);
    for (const line of lines) process.stdout.write(`WARNING: ${line}\n`);
    process.exitCode = 0;
  } catch (error) {
    if (error instanceof SeedLoadError) {
      process.stderr.write(`atom seed failed: step=${error.step} method=${error.method} path=${error.path} status=${error.status}\n`);
    } else {
      process.stderr.write(`atom seed failed: ${error.message}\n`);
    }
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main(process.argv.slice(2));
