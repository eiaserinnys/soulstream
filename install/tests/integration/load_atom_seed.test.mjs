// Integration tests for install/seed/load_atom_seed.mjs against a real atom
// API server (SQLite). The design document asked for PostgreSQL; this unit
// uses SQLite because the loader only relies on the HTTP contract, while
// PostgreSQL schema checks stay with install.sh (U11) and the live server (U12).
//
// ATOM_TEST_DIR must point at a built atom checkout (b88c7a5b). Each case gets
// a fresh atom process, database and temp state directory. Faults are injected
// by wrapping fetch; requests themselves always go to the real server, except
// for the single fake 503 in case 9.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAtomSeed, placeholderKeys, SeedLoadError } from '../../seed/load_atom_seed.mjs';
import { startAtom } from './atom_test_server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const CLI = path.join(ROOT, 'install/seed/load_atom_seed.mjs');
const SEED_PATH = path.join(ROOT, 'install/seed/atom-seed.json');
const SEED = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const CARD_ENTRIES = SEED.entries.filter((entry) => entry.entry_kind === 'card');
const REPLACEMENTS = CARD_ENTRIES.filter((entry) => placeholderKeys(entry.content ?? '').length > 0);
const REPLACEMENT_KEYS = new Set(REPLACEMENTS.map((entry) => entry.key));
const TITLE_BY_KEY = new Map(SEED.entries.map((entry) => [entry.key, entry.title]));
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

async function withAtom(run) {
  const atom = await startAtom();
  const dirs = [];
  try {
    const makeDir = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atom-seed-test-'));
      dirs.push(dir);
      return dir;
    };
    return await run({ atom, makeDir });
  } finally {
    await atom.stop();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function login(atom) {
  const response = await fetch(`${atom.url}/api/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: atom.password }),
  });
  assert.equal(response.status, 200, 'test login failed');
  const line = response.headers.getSetCookie().find((cookie) => cookie.startsWith('atom_auth='));
  return line.split(';')[0];
}

async function api(atom, cookie, method, pathName, body) {
  const response = await fetch(`${atom.url}${pathName}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // 204 responses have no body.
  }
  return { status: response.status, json };
}

function makeFetchWrapper(hook) {
  const writes = [];
  const logins = [];
  const wrapped = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const pathName = new URL(url).pathname;
    const entry = { method, pathName, init };
    if (pathName === '/api/auth/password-login') logins.push(entry);
    else if (method !== 'GET' && method !== 'HEAD') writes.push(`${method} ${pathName}`);
    if (hook) {
      const injected = await hook(entry);
      if (injected !== undefined) return injected;
    }
    return fetch(url, init);
  };
  return {
    fetch: wrapped,
    writes,
    logins,
    count(method, pathName) {
      return writes.filter((write) => write === `${method} ${pathName}`).length;
    },
  };
}

async function readAll(atom, cookie) {
  const roots = (await api(atom, cookie, 'GET', '/tree')).json;
  const nodes = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const node = queue.shift();
    nodes.push(node);
    if (!node.is_symlink) {
      const children = (await api(atom, cookie, 'GET', `/tree/${node.id}/children`)).json;
      queue.push(...children);
    }
  }
  return { roots, nodes };
}

function markerMap(nodes, installId) {
  const prefix = `${installId}:`;
  const map = new Map();
  for (const node of nodes) {
    if (node.is_symlink) continue;
    const ref = node.card?.source_ref;
    if (node.card?.source_type !== 'soulstream-seed' || typeof ref !== 'string' || !ref.startsWith(prefix)) continue;
    map.set(ref.slice(prefix.length), node);
  }
  return map;
}

function readState(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, '.atom-seed-state.json'), 'utf8'));
}

function keyByCardId(state, cardId) {
  for (const [key, entry] of Object.entries(state.key_map)) {
    if (entry.card_id === cardId) return key;
  }
  return null;
}

async function startSeedLoad(atom, stateDir, extra = {}) {
  return loadAtomSeed({ atomUrl: atom.url, password: atom.password, stateDir, ...extra });
}

test('case 1: full run via CLI, then an idempotent rerun', async () => {
  await withAtom(async ({ atom, makeDir }) => {
    const stateDir = makeDir();
    const passwordFile = path.join(makeDir(), '.admin-password');
    fs.writeFileSync(passwordFile, `${atom.password}\n`, { mode: 0o600 });

    const argv = [CLI, '--atom-url', atom.url, '--password-file', passwordFile, '--state-dir', stateDir];
    const run = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 300_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.split('\n')[0], 'atom seed: completed');
    const printed = `${run.stdout}${run.stderr}${argv.join(' ')}`;
    assert.equal(printed.includes(atom.password), false, 'password must not be printed');
    assert.equal(printed.includes('atom_auth='), false, 'cookie must not be printed');

    const state = readState(stateDir);
    assert.equal(state.phase, 'completed');
    const cookie = await login(atom);
    const { nodes } = await readAll(atom, cookie);

    const markers = markerMap(nodes, state.install_id);
    assert.equal(nodes.filter((node) => !node.is_symlink && node.card.source_type === 'soulstream-seed').length, 172);
    assert.equal(markers.size, 172);
    assert.equal(nodes.filter((node) => node.is_symlink).length, 38);

    const parents = new Set(SEED.entries.map((entry) => entry.parent ?? null));
    for (const parentKey of parents) {
      const actual = parentKey === null
        ? (await api(atom, cookie, 'GET', '/tree')).json
        : (await api(atom, cookie, 'GET', `/tree/${markers.get(parentKey).id}/children`)).json;
      const expected = SEED.entries.filter((entry) => (entry.parent ?? null) === parentKey);
      assert.equal(actual.length, expected.length, `child count under ${parentKey}`);
      expected.forEach((entry, index) => {
        const node = actual[index];
        if (entry.entry_kind === 'card') {
          assert.equal(node.is_symlink, false, `order under ${parentKey}: ${entry.key}`);
          assert.equal(node.id, markers.get(entry.key).id, `order under ${parentKey}: ${entry.key}`);
          assert.equal(node.card.title, entry.title);
        } else {
          assert.equal(node.is_symlink, true, `order under ${parentKey}: ${entry.key}`);
          assert.equal(node.card_id, markers.get(entry.symlink_target).card_id, `order under ${parentKey}: ${entry.key}`);
        }
      });
    }

    const nodeIdToKey = new Map([...markers.entries()].map(([key, node]) => [node.id, key]));
    for (const entry of REPLACEMENTS) {
      const node = markers.get(entry.key);
      const card = (await api(atom, cookie, 'GET', `/cards/${node.card_id}`)).json;
      assert.equal(card.version, 2, `version for replacement ${entry.key}`);
      assert.equal(card.content.includes('{{node_id:'), false, `unresolved placeholder in ${entry.key}`);
      assert.equal(card.content.includes('{{card_id:'), false, `unresolved placeholder in ${entry.key}`);
      for (const match of card.content.matchAll(UUID_RE)) {
        const key = nodeIdToKey.get(match[0]);
        assert.ok(key, `unknown node id in ${entry.key}`);
        const fetched = await api(atom, cookie, 'GET', `/tree/${match[0]}`);
        assert.equal(fetched.status, 200, `referenced node ${match[0]} in ${entry.key}`);
        assert.equal(fetched.json.card.title, TITLE_BY_KEY.get(key));
      }
    }
    for (const entry of CARD_ENTRIES) {
      if (REPLACEMENT_KEYS.has(entry.key)) continue;
      const card = (await api(atom, cookie, 'GET', `/cards/${markers.get(entry.key).card_id}`)).json;
      assert.equal(card.version, 1, `untouched card ${entry.key} must stay at version 1`);
    }

    const mapPath = path.join(stateDir, '.atom-seed-map.json');
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    assert.equal(Object.keys(map).length, 20);
    assert.equal(fs.statSync(mapPath).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(stateDir, '.atom-seed-state.json')).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(stateDir, '.atom-seed-inprogress.json')), false);

    const versions = new Map(nodes.map((node) => [node.card.id, node.card.version]));
    const rerun = makeFetchWrapper();
    const result = await startSeedLoad(atom, stateDir, { fetchImpl: rerun.fetch });
    assert.equal(result.phase, 'completed');
    assert.deepEqual(rerun.writes, [], 'a completed rerun must not write');
    const { nodes: after } = await readAll(atom, cookie);
    for (const node of after) assert.equal(node.card.version, versions.get(node.card.id));
  });
});

test('case 2a: lost /batch response resumes from markers without resending', async () => {
  await withAtom(async ({ atom, makeDir }) => {
    const stateDir = makeDir();
    let fired = false;
    const first = makeFetchWrapper(async (entry) => {
      if (!fired && entry.method === 'POST' && entry.pathName === '/batch') {
        fired = true;
        const response = await fetch(`${atom.url}${entry.pathName}`, entry.init);
        await response.arrayBuffer();
        throw new Error('injected response loss');
      }
    });
    await assert.rejects(startSeedLoad(atom, stateDir, { fetchImpl: first.fetch }), SeedLoadError);
    assert.equal(first.count('POST', '/batch'), 1);

    const cookie = await login(atom);
    const created = await api(atom, cookie, 'POST', '/cards', {
      card_type: 'knowledge',
      title: '사용자 카드 2a',
      parent_node_id: null,
    });
    assert.equal(created.status, 201);

    const second = makeFetchWrapper();
    const result = await startSeedLoad(atom, stateDir, { fetchImpl: second.fetch });
    assert.equal(result.phase, 'completed');
    assert.equal(second.count('POST', '/batch'), 0);

    const roots = (await api(atom, cookie, 'GET', '/tree')).json;
    assert.ok(roots.some((node) => node.card.title === '사용자 카드 2a'), 'user card must be preserved');
    const state = readState(stateDir);
    const { nodes } = await readAll(atom, cookie);
    assert.equal(markerMap(nodes, state.install_id).size, 172);
  });
});

test('case 2b: tree changed before the batch aborts with zero writes', async () => {
  await withAtom(async ({ atom, makeDir }) => {
    const stateDir = makeDir();
    const first = makeFetchWrapper(async (entry) => {
      if (entry.method === 'POST' && entry.pathName === '/batch') throw new Error('injected before send');
    });
    await assert.rejects(
      startSeedLoad(atom, stateDir, { fetchImpl: first.fetch }),
      (error) => error instanceof SeedLoadError && error.status === 'network'
    );

    const cookie = await login(atom);
    assert.equal((await api(atom, cookie, 'POST', '/cards', { card_type: 'knowledge', title: '사용자 카드 2b', parent_node_id: null })).status, 201);

    const second = makeFetchWrapper();
    await assert.rejects(
      startSeedLoad(atom, stateDir, { fetchImpl: second.fetch }),
      (error) => error instanceof SeedLoadError && /tree changed/.test(error.message)
    );
    assert.deepEqual(second.writes, []);
    assert.equal(readState(stateDir).phase, 'creating');
  });
});

test('case 3a: user edit before replacement is preserved as a conflict', async () => {
  await withAtom(async ({ atom, makeDir }) => {
    const stateDir = makeDir();
    let targetPath = null;
    const first = makeFetchWrapper(async (entry) => {
      if (targetPath === null && entry.method === 'PUT' && entry.pathName.startsWith('/cards/')) {
        targetPath = entry.pathName;
        throw new Error('injected before the first conditional PUT');
      }
    });
    await assert.rejects(startSeedLoad(atom, stateDir, { fetchImpl: first.fetch }), SeedLoadError);
    assert.ok(targetPath);

    const cookie = await login(atom);
    const cardId = targetPath.split('/').pop();
    const state = readState(stateDir);
    const key = keyByCardId(state, cardId);
    assert.ok(key);
    assert.equal((await api(atom, cookie, 'PUT', targetPath, { content: '사용자 편집 3a' })).status, 200);

    const result = await startSeedLoad(atom, stateDir);
    assert.equal(result.phase, 'completed');
    assert.deepEqual(result.conflicts, [{ key, reason: 'edited' }]);
    assert.ok(result.warnings.includes(`seed card kept because it was changed: ${key} (edited)`));

    const kept = (await api(atom, cookie, 'GET', `/cards/${cardId}`)).json;
    assert.equal(kept.content, '사용자 편집 3a');
    assert.equal(kept.version, 2);

    const { nodes } = await readAll(atom, cookie);
    const markers = markerMap(nodes, state.install_id);
    let replaced = 0;
    for (const entry of REPLACEMENTS) {
      if (entry.key === key) continue;
      const card = (await api(atom, cookie, 'GET', `/cards/${markers.get(entry.key).card_id}`)).json;
      assert.equal(card.version, 2, `replacement ${entry.key}`);
      assert.equal(card.content.includes('{{node_id:'), false);
      replaced += 1;
    }
    assert.equal(replaced, 41);
    const conflictReferences = placeholderKeys(REPLACEMENTS.find((entry) => entry.key === key).content ?? '').length;
    assert.equal(71 - conflictReferences, REPLACEMENTS.reduce((sum, entry) => sum + (entry.key === key ? 0 : placeholderKeys(entry.content ?? '').length), 0));
  });
});

test('case 3b: an edit racing the PUT turns into a 409 and an edited conflict', async () => {
  await withAtom(async ({ atom, makeDir }) => {
    const stateDir = makeDir();
    const cookie = await login(atom);
    let targetPath = null;
    const wrapper = makeFetchWrapper(async (entry) => {
      if (targetPath === null && entry.method === 'PUT' && entry.pathName.startsWith('/cards/')) {
        targetPath = entry.pathName;
        const response = await fetch(`${atom.url}${entry.pathName}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ content: '사용자 편집 3b' }),
        });
        assert.equal(response.status, 200);
      }
    });
    const result = await startSeedLoad(atom, stateDir, { fetchImpl: wrapper.fetch });
    assert.equal(result.phase, 'completed');
    const state = readState(stateDir);
    const cardId = targetPath.split('/').pop();
    const key = keyByCardId(state, cardId);
    assert.deepEqual(result.conflicts, [{ key, reason: 'edited' }]);
    const kept = (await api(atom, cookie, 'GET', targetPath)).json;
    assert.equal(kept.content, '사용자 편집 3b');
    assert.equal(kept.version, 2);
  });
});

test('case 3c: the same rendered body written first counts as success', async () => {
  await withAtom(async ({ atom, makeDir }) => {
    const stateDir = makeDir();
    const cookie = await login(atom);
    let hooked = false;
    const wrapper = makeFetchWrapper(async (entry) => {
      if (!hooked && entry.method === 'PUT' && entry.pathName.startsWith('/cards/')) {
        hooked = true;
        const body = JSON.parse(entry.init.body);
        const response = await fetch(`${atom.url}${entry.pathName}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ content: body.content, expected_version: 1 }),
        });
        assert.equal(response.status, 200);
      }
    });
    const result = await startSeedLoad(atom, stateDir, { fetchImpl: wrapper.fetch });
    assert.equal(result.phase, 'completed');
    assert.deepEqual(result.conflicts, []);
  });
});

test('case 4: lost PUT response resumes without a second PUT', async () => {
  await withAtom(async ({ atom, makeDir }) => {
    const stateDir = makeDir();
    let targetPath = null;
    const first = makeFetchWrapper(async (entry) => {
      if (targetPath === null && entry.method === 'PUT' && entry.pathName.startsWith('/cards/')) {
        targetPath = entry.pathName;
        const response = await fetch(`${atom.url}${entry.pathName}`, entry.init);
        await response.arrayBuffer();
        throw new Error('injected PUT response loss');
      }
    });
    await assert.rejects(startSeedLoad(atom, stateDir, { fetchImpl: first.fetch }), SeedLoadError);
    assert.equal(first.count('PUT', targetPath), 1);

    const second = makeFetchWrapper();
    const result = await startSeedLoad(atom, stateDir, { fetchImpl: second.fetch });
    assert.equal(result.phase, 'completed');
    assert.equal(second.count('PUT', targetPath), 0);
    const cookie = await login(atom);
    const card = (await api(atom, cookie, 'GET', targetPath)).json;
    assert.equal(card.version, 2);
  });
});

test('case 5: completed reruns rebuild the map and report deleted exports', async () => {
  await withAtom(async ({ atom, makeDir }) => {
    const stateDir = makeDir();
    assert.equal((await startSeedLoad(atom, stateDir)).phase, 'completed');
    const mapPath = path.join(stateDir, '.atom-seed-map.json');
    const mapBefore = fs.readFileSync(mapPath, 'utf8');
    fs.unlinkSync(mapPath);

    const rebuild = makeFetchWrapper();
    const rebuilt = await startSeedLoad(atom, stateDir, { fetchImpl: rebuild.fetch });
    assert.equal(rebuilt.phase, 'completed');
    assert.equal(fs.readFileSync(mapPath, 'utf8'), mapBefore);
    assert.deepEqual(rebuild.writes, []);

    const cookie = await login(atom);
    const state = readState(stateDir);
    const exportedName = 'mistakes_root';
    const nodeId = state.key_map[SEED.exported_keys[exportedName]].node_id;
    assert.equal((await api(atom, cookie, 'DELETE', `/tree/${nodeId}`)).status, 204);
    const { nodes: afterDelete } = await readAll(atom, cookie);

    const rerun = makeFetchWrapper();
    const result = await startSeedLoad(atom, stateDir, { fetchImpl: rerun.fetch });
    assert.equal(result.phase, 'completed');
    assert.deepEqual(rerun.writes, []);
    const mapAfter = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    assert.equal(mapAfter[exportedName], null);
    assert.ok(result.warnings.includes(`exported node deleted: ${exportedName}`));
    const { nodes: afterRerun } = await readAll(atom, cookie);
    assert.equal(afterRerun.length, afterDelete.length, 'rerun must not recreate the deleted node');
  });
});

test('case 6a: a single 401 re-login resumes and completes', async () => {
  await withAtom(async ({ atom, makeDir }) => {
    const stateDir = makeDir();
    let mangled = false;
    const wrapper = makeFetchWrapper(async (entry) => {
      if (entry.pathName === '/api/auth/password-login') return undefined;
      if (!mangled && entry.method === 'GET' && entry.pathName.startsWith('/cards/')) {
        mangled = true;
        return fetch(`${atom.url}${entry.pathName}`, {
          ...entry.init,
          headers: { ...entry.init.headers, cookie: 'atom_auth=broken' },
        });
      }
    });
    const result = await startSeedLoad(atom, stateDir, { fetchImpl: wrapper.fetch });
    assert.equal(result.phase, 'completed');
    assert.equal(wrapper.logins.length, 2);
  });
});

test('case 6b: a second 401 aborts after exactly two logins', async () => {
  await withAtom(async ({ atom, makeDir }) => {
    const stateDir = makeDir();
    const wrapper = makeFetchWrapper(async (entry) => {
      if (entry.pathName === '/api/auth/password-login') return undefined;
      return fetch(`${atom.url}${entry.pathName}`, {
        ...entry.init,
        headers: { ...entry.init.headers, cookie: 'atom_auth=broken' },
      });
    });
    await assert.rejects(
      startSeedLoad(atom, stateDir, { fetchImpl: wrapper.fetch }),
      (error) => error instanceof SeedLoadError && error.status === 401
    );
    assert.equal(wrapper.logins.length, 2);
  });
});

test('case 7: an existing tree without state is preserved, not seeded', async () => {
  await withAtom(async ({ atom, makeDir }) => {
    const stateDir = makeDir();
    const cookie = await login(atom);
    assert.equal((await api(atom, cookie, 'POST', '/cards', { card_type: 'knowledge', title: '기존 사용자 카드', parent_node_id: null })).status, 201);

    const wrapper = makeFetchWrapper();
    const result = await startSeedLoad(atom, stateDir, { fetchImpl: wrapper.fetch });
    assert.equal(result.phase, 'preserved');
    assert.ok(result.warnings.includes('existing atom tree found; seed not loaded'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, '.atom-seed-map.json'), 'utf8')), {});
    assert.deepEqual(wrapper.writes, []);
    assert.equal(fs.existsSync(path.join(stateDir, '.atom-seed-state.json')), false);
  });
});

test('case 8: a mismatched in-progress copy aborts without writes', async () => {
  await withAtom(async ({ atom, makeDir }) => {
    const stateDir = makeDir();
    const first = makeFetchWrapper(async (entry) => {
      if (entry.method === 'GET' && entry.pathName.startsWith('/cards/')) throw new Error('injected before symlinks');
    });
    await assert.rejects(startSeedLoad(atom, stateDir, { fetchImpl: first.fetch }), SeedLoadError);
    assert.equal(readState(stateDir).phase, 'created');

    const inprogress = path.join(stateDir, '.atom-seed-inprogress.json');
    const bytes = fs.readFileSync(inprogress);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(inprogress, bytes);

    const second = makeFetchWrapper();
    await assert.rejects(
      startSeedLoad(atom, stateDir, { fetchImpl: second.fetch }),
      (error) => error instanceof SeedLoadError && /in-progress seed copy/.test(error.message)
    );
    assert.deepEqual(second.writes, []);
    assert.equal(readState(stateDir).phase, 'created');
  });
});

test('case 9: a 503 on the first batch aborts without resending', async () => {
  await withAtom(async ({ atom, makeDir }) => {
    const stateDir = makeDir();
    let faked = false;
    const first = makeFetchWrapper(async (entry) => {
      if (!faked && entry.method === 'POST' && entry.pathName === '/batch') {
        faked = true;
        return new Response(JSON.stringify({ error: 'injected' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
    });
    await assert.rejects(
      startSeedLoad(atom, stateDir, { fetchImpl: first.fetch }),
      (error) => error instanceof SeedLoadError && error.status === 503
    );
    assert.equal(first.count('POST', '/batch'), 1);
    const cookie = await login(atom);
    assert.deepEqual((await api(atom, cookie, 'GET', '/tree')).json, [], 'the fake batch must not reach atom');
    assert.equal(readState(stateDir).phase, 'creating');

    const second = makeFetchWrapper();
    const result = await startSeedLoad(atom, stateDir, { fetchImpl: second.fetch });
    assert.equal(result.phase, 'completed');
    assert.equal(second.count('POST', '/batch'), 1);
  });
});
