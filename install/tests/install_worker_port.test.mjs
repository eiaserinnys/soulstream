import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFakeCommands } from './support/fake_commands.mjs';
import { copyCatalog, copyCommonFiles } from './support/catalog.mjs';

const script = resolve('install/install.sh');
const parse = (...args) => spawnSync('bash', ['-c', 'source "$1"; shift; parse_args "$@"; printf "port=%s set=%s\\n" "$WORKER_PORT" "$WORKER_PORT_SET"', 'bash', script, ...args], { encoding: 'utf8' });

function prepare() {
  const dir = mkdtempSync(join(tmpdir(), 'install-worker-port-')), home = join(dir, 'home'), root = join(home, 'soulstream');
  copyCatalog(root);
  copyCommonFiles(root);
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', '.atom-seed-map.json'), JSON.stringify({ skill_catalog: '11111111-2222-4333-8444-555555555555', domain_catalog: null }));
  writeFileSync(join(root, '.atom-api-key'), 'test-atom-api-key\n');
  return { dir, home, root, fake: createFakeCommands(dir) };
}
// parse_args with the given options, then the steps the installer runs before the wait for the services.
const run = (t, tail, args, path = '') => spawnSync('bash', ['-c', `set -Eeuo pipefail; source "$1"; home=$2; root=$3; shift 3; parse_args --backends codex "$@"; setup_secrets "$root" "$home/atom"; render_config "$home" "$root"; ${tail}`, 'bash', script, t.home, t.root, ...args], { encoding: 'utf8', env: { ...t.fake.env(), PATH: `${path}${path ? ':' : ''}${t.fake.env().PATH}` } });
const workerEnv = (t) => readFileSync(join(t.root, '.env.soul-server-ts'), 'utf8').split('\n');
const registry = (t) => readFileSync(join(t.root, 'config', 'mcp-registry.yaml'), 'utf8').match(/url: http:\/\/127\.0\.0\.1:\d+\/mcp/g);

test('--worker-port takes a port from 1024 to 65534 and defaults to 4205', () => {
  assert.equal(parse().stdout, 'port=4205 set=false\n');
  const given = parse('--worker-port', '4305');
  assert.equal(given.status, 0, given.stderr);
  assert.equal(given.stdout, 'port=4305 set=true\n');
  assert.equal(parse('--worker-port', '1024').status, 0);
  assert.equal(parse('--worker-port', '65534').status, 0);
  for (const args of [['--worker-port', 'abc'], ['--worker-port', '80'], ['--worker-port', '65535'], ['--worker-port']]) {
    const result = parse(...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /Usage: install\.sh/);
  }
});

test('--worker-port moves the worker, its MCP port and both registry urls', () => {
  const t = prepare();
  try {
    const result = run(t, ':', ['--worker-port', '4305']);
    assert.equal(result.status, 0, result.stderr);
    const worker = workerEnv(t);
    assert.ok(worker.includes('PORT=4305') && worker.includes('MCP_INTERNAL_PORT=4306'));
    assert.ok(!worker.includes('PORT=4205') && !worker.includes('MCP_INTERNAL_PORT=4206'));
    assert.deepEqual(registry(t), ['url: http://127.0.0.1:4305/mcp', 'url: http://127.0.0.1:4200/mcp']);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('the readiness wait asks the worker on the chosen port', () => {
  const t = prepare();
  try {
    const bin = join(t.dir, 'curl-bin'), log = join(t.dir, 'curl-urls.log');
    mkdirSync(bin);
    // Answers the readiness probes and records every url; the login after them fails, which ends the call.
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
url=
for arg in "$@"; do
  case "$arg" in http://*) printf '%s\\n' "$arg" >> "${log}"; url=$arg ;; esac
done
case "$url" in
  */api/nodes) printf '{"nodes":[{"nodeId":"local","connected":true}]}' ;;
  */api/health|*/health) ;;
  *) exit 22 ;;
esac
`);
    chmodSync(join(bin, 'curl'), 0o755);
    const result = run(t, 'wait_and_create_workspace "$root" || true', ['--worker-port', '4305'], bin);
    assert.equal(result.status, 0, result.stderr);
    const urls = readFileSync(log, 'utf8').split('\n');
    assert.ok(urls.includes('http://127.0.0.1:4305/health'), urls.join(' '));
    assert.ok(!urls.includes('http://127.0.0.1:4205/health'));
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('a rerun without the option keeps the port of the previous install', () => {
  const t = prepare();
  try {
    assert.equal(run(t, ':', ['--worker-port', '4305']).status, 0);
    const again = run(t, ':', []);
    assert.equal(again.status, 0, again.stderr);
    const worker = workerEnv(t);
    assert.ok(worker.includes('PORT=4305') && worker.includes('MCP_INTERNAL_PORT=4306'));
    assert.deepEqual(registry(t), ['url: http://127.0.0.1:4305/mcp', 'url: http://127.0.0.1:4200/mcp']);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});
