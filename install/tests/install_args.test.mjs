import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('install/install.sh');
function parse(...args) {
  return spawnSync('bash', ['-c', 'source "$1"; shift; parse_args "$@"; printf "backends=%s ref=%s\\n" "$BACKENDS" "$REF"', 'bash', script, ...args], { encoding: 'utf8' });
}
test('backend defaults, ordering, deduplication, ref and help', () => {
  for (const [args, expected] of [ [[], 'backends=claude,codex ref='], [['--backends','codex'], 'backends=codex ref='], [['--backends','claude,antigravity'], 'backends=claude,antigravity ref='], [['--backends','codex,codex'], 'backends=codex ref='], [['--ref','abc'], 'backends=claude,codex ref=abc'] ]) {
    const result = parse(...args); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, new RegExp(expected));
  }
  assert.equal(parse('--help').status, 0);
});
test('rejects invalid or missing options with usage', () => {
  for (const args of [['--backends',''], ['--backends','foo'], ['--backends','claude,foo'], ['--foo'], ['--ref'], ['--tailscale-user','a'], ['--tailscale-auth-key','k'], ['--tailscale','--tailscale-user'], ['--tailscale','--tailscale-auth-key']]) {
    const result = parse(...args); assert.equal(result.status, 2, JSON.stringify(args)); assert.match(result.stdout + result.stderr, /usage|사용법/i);
  }
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
test('Claude login guidance works without a local browser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-finish-'));
  try {
    writeFileSync(join(dir, '.admin-password'), 'test-password\n');
    const result = spawnSync('bash', ['-c', 'source "$1"; as_soul() { printf abc; }; BACKENDS=claude; finish_message "$2"', 'bash', script, dir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sudo -Hu soulstream env BROWSER=\/bin\/false \/home\/soulstream\/\.local\/bin\/claude auth login/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
