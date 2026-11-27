import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFakeCommands } from './support/fake_commands.mjs';
import { copyCatalog, copyCommonFiles } from './support/catalog.mjs';

const script = resolve('install/install.sh');
const PUBLIC = 'http://127.0.0.1:15200', ATOM_PUBLIC = 'http://127.0.0.1:14200';
const parse = (...args) => spawnSync('bash', ['-c', 'source "$1"; shift; parse_args "$@"; printf "public=%s atom=%s\\n" "$PUBLIC_URL" "$ATOM_PUBLIC_URL_OPT"', 'bash', script, ...args], { encoding: 'utf8' });
const env = (p) => Object.fromEntries(readFileSync(p, 'utf8').trim().split('\n').filter((x) => /^[A-Z_]+=/.test(x)).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));

function prepare() {
  const dir = mkdtempSync(join(tmpdir(), 'install-public-url-')), home = join(dir, 'home'), root = join(home, 'soulstream'), atomRoot = join(home, 'atom');
  copyCatalog(root);
  copyCommonFiles(root);
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(atomRoot, { recursive: true });
  writeFileSync(join(root, 'config', '.atom-seed-map.json'), JSON.stringify({ skill_catalog: '11111111-2222-4333-8444-555555555555', domain_catalog: null }));
  writeFileSync(join(root, '.atom-api-key'), 'test-atom-api-key\n');
  return { dir, home, root, atomRoot, orch: join(root, '.env.orch'), atomEnv: join(atomRoot, '.env'), fake: createFakeCommands(dir) };
}
// The order of run_install: init_atom, then render_config. tail runs afterwards in the same shell.
const render = (t, { tailscale = false, dns = 'node.tailnet.ts.net', args = [], tail = ':' } = {}) => spawnSync('bash', ['-c', `set -Eeuo pipefail; source "$1"; home=$2; root=$3; atom=$4; tailscale=$5; shift 5
as_soul() { if [[ "$1" == git ]]; then printf abc; else "$@"; fi; }
parse_args --backends codex "$@"
TAILSCALE=$tailscale; TAILSCALE_DNS=$DNS; TAILSCALE_USER=owner@example.com
INSTALL_ROOT=$root
setup_secrets "$root" "$atom"
init_atom "$atom" > /dev/null
render_config "$home" "$root"
${tail}`, 'bash', script, t.home, t.root, t.atomRoot, String(tailscale), ...args], { encoding: 'utf8', env: t.fake.env({ DNS: dns }) });

test('--public-url and --atom-public-url take an http(s) origin and are refused otherwise', () => {
  const given = parse('--public-url', PUBLIC, '--atom-public-url', ATOM_PUBLIC);
  assert.equal(given.status, 0, given.stderr);
  assert.equal(given.stdout, `public=${PUBLIC} atom=${ATOM_PUBLIC}\n`);
  assert.equal(parse('--public-url', 'https://soul.example.com').status, 0);
  for (const args of [['--public-url', 'ftp://x'], ['--public-url', `${PUBLIC}/path`], ['--public-url', `${PUBLIC}/`], ['--public-url'], ['--atom-public-url', ATOM_PUBLIC, '--tailscale']]) {
    const result = parse(...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /Usage: install\.sh/);
  }
});

test('a password-mode render with both options writes them to the orchestrator and atom env files', () => {
  const t = prepare();
  try {
    const result = render(t, { args: ['--public-url', PUBLIC, '--atom-public-url', ATOM_PUBLIC] });
    assert.equal(result.status, 0, result.stderr);
    const orch = env(t.orch);
    assert.equal(orch.SOULSTREAM_PUBLIC_URL, PUBLIC);
    assert.equal(orch.ATOM_PUBLIC_URL, ATOM_PUBLIC);
    const origins = orch.CORS_ALLOWED_ORIGINS.split(',');
    assert.ok(origins.includes(PUBLIC) && origins.includes('http://127.0.0.1:5200'), orch.CORS_ALLOWED_ORIGINS);
    assert.equal(new Set(origins).size, origins.length);
    assert.equal(env(t.atomEnv).FRONTEND_URL, ATOM_PUBLIC);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('a rerun without the options keeps the addresses a person edited', () => {
  const t = prepare();
  try {
    assert.equal(render(t).status, 0);
    const edited = readFileSync(t.orch, 'utf8')
      .replace(/^SOULSTREAM_PUBLIC_URL=.*$/m, 'SOULSTREAM_PUBLIC_URL=https://soul.example.com')
      .replace(/^CORS_ALLOWED_ORIGINS=.*$/m, 'CORS_ALLOWED_ORIGINS=https://soul.example.com')
      .replace(/^ATOM_PUBLIC_URL=.*$/m, 'ATOM_PUBLIC_URL=https://atom.example.com');
    writeFileSync(t.orch, edited);
    writeFileSync(t.atomEnv, readFileSync(t.atomEnv, 'utf8').replace(/^FRONTEND_URL=.*$/m, 'FRONTEND_URL=https://atom.example.com'));
    const result = render(t);
    assert.equal(result.status, 0, result.stderr);
    const orch = env(t.orch);
    assert.equal(orch.SOULSTREAM_PUBLIC_URL, 'https://soul.example.com');
    assert.equal(orch.CORS_ALLOWED_ORIGINS, 'https://soul.example.com');
    assert.equal(orch.ATOM_PUBLIC_URL, 'https://atom.example.com');
    assert.equal(env(t.atomEnv).FRONTEND_URL, 'https://atom.example.com');
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('switching to Tailscale mode replaces the kept addresses with the Tailscale defaults', () => {
  const t = prepare();
  try {
    assert.equal(render(t, { args: ['--public-url', PUBLIC, '--atom-public-url', ATOM_PUBLIC] }).status, 0);
    const result = render(t, { tailscale: true });
    assert.equal(result.status, 0, result.stderr);
    const orch = env(t.orch);
    assert.equal(orch.SOULSTREAM_PUBLIC_URL, 'https://node.tailnet.ts.net');
    assert.equal(orch.CORS_ALLOWED_ORIGINS, 'https://node.tailnet.ts.net,http://127.0.0.1:5200');
    assert.equal(orch.ATOM_PUBLIC_URL, 'https://node.tailnet.ts.net:8443');
    assert.equal(env(t.atomEnv).FRONTEND_URL, 'https://node.tailnet.ts.net:8443');
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('the closing message shows the written addresses and tunnels to their local ports', () => {
  const t = prepare();
  try {
    const result = render(t, { args: ['--public-url', PUBLIC, '--atom-public-url', ATOM_PUBLIC], tail: 'finish_message "$root"' });
    assert.equal(result.status, 0, result.stderr);
    for (const line of ['-L 127.0.0.1:15200:127.0.0.1:5200', '-L 127.0.0.1:14200:127.0.0.1:4200', `Soulstream: ${PUBLIC}\n`, `Atom: ${ATOM_PUBLIC}\n`]) {
      assert.ok(result.stdout.includes(line), `${line}\n${result.stdout}`);
    }
    const plain = prepare();
    try {
      const fallback = render(plain, { tail: 'finish_message "$root"' });
      assert.equal(fallback.status, 0, fallback.stderr);
      assert.ok(fallback.stdout.includes('-L 127.0.0.1:5200:127.0.0.1:5200 -L 127.0.0.1:4200:127.0.0.1:4200'), fallback.stdout);
    } finally { rmSync(plain.dir, { recursive: true, force: true }); }
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('a Tailscale rerun writes the addresses of the current tailnet name over edited ones', () => {
  const t = prepare();
  try {
    assert.equal(render(t, { tailscale: true, dns: 'old-name.example.ts.net' }).status, 0);
    writeFileSync(t.orch, readFileSync(t.orch, 'utf8')
      .replace(/^SOULSTREAM_PUBLIC_URL=.*$/m, 'SOULSTREAM_PUBLIC_URL=https://hand.example.com')
      .replace(/^CORS_ALLOWED_ORIGINS=.*$/m, 'CORS_ALLOWED_ORIGINS=https://hand.example.com')
      .replace(/^ATOM_PUBLIC_URL=.*$/m, 'ATOM_PUBLIC_URL=https://hand.example.com:8443'));
    writeFileSync(t.atomEnv, readFileSync(t.atomEnv, 'utf8').replace(/^FRONTEND_URL=.*$/m, 'FRONTEND_URL=https://hand.example.com:8443'));
    const result = render(t, { tailscale: true, dns: 'new-name.example.ts.net' });
    assert.equal(result.status, 0, result.stderr);
    const orch = env(t.orch);
    assert.equal(orch.SOULSTREAM_PUBLIC_URL, 'https://new-name.example.ts.net');
    assert.equal(orch.CORS_ALLOWED_ORIGINS, 'https://new-name.example.ts.net,http://127.0.0.1:5200');
    assert.equal(orch.ATOM_PUBLIC_URL, 'https://new-name.example.ts.net:8443');
    assert.equal(env(t.atomEnv).FRONTEND_URL, 'https://new-name.example.ts.net:8443');
    const text = readFileSync(t.orch, 'utf8') + readFileSync(t.atomEnv, 'utf8');
    assert.ok(!text.includes('hand.example.com') && !text.includes('old-name'));
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});
