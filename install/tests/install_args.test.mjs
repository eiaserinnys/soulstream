import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFakeCommands } from './support/fake_commands.mjs';

const script = resolve('install/install.sh');
function parse(...args) {
  return spawnSync('bash', ['-c', 'source "$1"; shift; parse_args "$@"; printf "backends=%s ref=%s atom_ref=%s\\n" "$BACKENDS" "$REF" "$ATOM_REF"', 'bash', script, ...args], { encoding: 'utf8' });
}
test('backend defaults, ordering, deduplication, ref and help', () => {
  for (const [args, expected] of [ [[], 'backends=claude,codex ref='], [['--backends','codex'], 'backends=codex ref='], [['--backends','claude,antigravity'], 'backends=claude,antigravity ref='], [['--backends','codex,codex'], 'backends=codex ref='], [['--ref','abc'], 'backends=claude,codex ref=abc'], [['--atom-ref','def'], 'backends=claude,codex ref= atom_ref=def'] ]) {
    const result = parse(...args); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, new RegExp(expected));
  }
  assert.equal(parse('--help').status, 0);
});
test('rejects invalid or missing options with usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-key-file-'));
  try {
    const keyFile = join(dir, 'key'); writeFileSync(keyFile, 'k');
    for (const args of [['--backends',''], ['--backends','foo'], ['--backends','claude,foo'], ['--foo'], ['--ref'], ['--atom-ref'], ['--tailscale-user','a'], ['--tailscale-auth-key','k'], ['--tailscale','--tailscale-user'], ['--tailscale','--tailscale-auth-key'],
      ['--tailscale','--tailscale-auth-key-file'], ['--tailscale','--tailscale-auth-key-file','--tailscale-user'], ['--tailscale-auth-key-file',keyFile], ['--tailscale','--tailscale-auth-key','k','--tailscale-auth-key-file',keyFile]]) {
      const result = parse(...args); assert.equal(result.status, 2, JSON.stringify(args)); assert.match(result.stdout + result.stderr, /usage|사용법/i);
    }
    const missing = parse('--tailscale', '--tailscale-auth-key-file', join(dir, 'missing'));
    assert.equal(missing.status, 2); assert.equal(missing.stderr, 'Tailscale auth key file is not readable.\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('accepts Tailscale mode and optional identity', () => {
  assert.equal(parse('--tailscale').status, 0);
  const result = spawnSync('bash', ['-c', 'source "$1"; shift; parse_args "$@"; printf "%s" "$TAILSCALE_USER"', 'bash', script, '--tailscale', '--tailscale-auth-key', 'k', '--tailscale-user', 'U@x'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'u@x');
});
test('sourcing has no side effects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-source-'));
  try { const result = spawnSync('bash', ['-c', 'source "$1"', 'bash', script], { cwd: dir, encoding: 'utf8' }); assert.equal(result.status, 0); assert.equal(result.stdout + result.stderr, ''); assert.deepEqual(readdirSync(dir), []); } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('installation commands start in a directory accessible to service users', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-cwd-'));
  try {
    const result = spawnSync('bash', ['-ec', 'source "$1"; prepare_install_cwd; pwd -P', 'bash', script], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '/');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('login guidance points to the dashboard and keeps the SSH alternative for Codex and Antigravity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-finish-'));
  try {
    writeFileSync(join(dir, '.admin-password'), 'test-password\n');
    const message = (backends) => spawnSync('bash', ['-c', 'source "$1"; as_soul() { printf abc; }; BACKENDS="$3"; finish_message "$2"', 'bash', script, dir, backends], { encoding: 'utf8' });
    const result = message('claude,codex,antigravity');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Login: connect Claude, Codex, and Antigravity in the dashboard under Settings → 코딩 에이전트.\n'));
    assert.match(result.stdout, /SSH alternative: Codex with "sudo -Hu soulstream \/usr\/local\/bin\/codex login --device-auth".*Antigravity by running ~\/\.local\/bin\/agy/);
    // Claude SSH login guidance is gone; only the dashboard connects Claude.
    assert.ok(!result.stdout.includes('claude auth login'));
    assert.ok(!result.stdout.includes('BROWSER=/bin/false'));
    assert.ok(!result.stdout.includes('test-password'));
    assert.ok(result.stdout.includes(`Password for both: sudo cat ${dir}/.admin-password\n`));
    const claudeOnly = message('claude');
    assert.equal(claudeOnly.status, 0, claudeOnly.stderr);
    assert.ok(claudeOnly.stdout.includes('Login: connect Claude, Codex, and Antigravity in the dashboard'));
    assert.ok(!claudeOnly.stdout.includes('SSH alternative'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('an auth key file reaches tailscale up by path only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-tailscale-key-file-'));
  try {
    const fake = createFakeCommands(dir), keyFile = join(dir, 'auth-key'), log = join(dir, 'install.log');
    writeFileSync(keyFile, 'SynthTsKeyContent7c1d', { mode: 0o600 });
    const result = spawnSync('bash', ['-ec', 'source "$1"; LOG="$2"; parse_args --tailscale --tailscale-auth-key-file "$3"; exec 3>&2; setup_tailscale; printf "%s" "$TAILSCALE_DNS"', 'bash', script, log, keyFile], { env: fake.env(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'node.tailnet.ts.net');
    const argv = fake.argv();
    assert.ok(argv.includes(`== tailscale\nup\n--auth-key=file:${keyFile}\n`));
    assert.ok(!(argv + result.stdout + result.stderr + readFileSync(log, 'utf8')).includes('SynthTsKeyContent7c1d'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
