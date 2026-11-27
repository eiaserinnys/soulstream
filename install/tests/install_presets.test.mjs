import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('install/install.sh');
const bearer = 'test-private-bearer';
// UsageSummarySnapshot.nodes contains UsageSummaryNode; its providers record
// has four UsageSummaryProvider values with status, stale and quota fields.
const provider = (status = 'not_configured', stale = false) => ({
  status, stale, fetchedAt: '2026-11-22T00:00:00Z', quotas: [],
  weeklyRemainingPercent: null, weeklyResetAt: null,
  shortRemainingPercent: null, shortResetAt: null,
});
const snapshot = (overrides = {}) => JSON.stringify({
  generatedAt: '2026-11-22T00:00:00Z', collectedAt: '2026-11-22T00:00:00Z',
  nodes: [{ nodeId: 'local', fetchedAt: '2026-11-22T00:00:00Z', stale: false, staleSince: null,
    providers: { claude: provider(), codex: provider(), antigravity: provider(), opencode_go: provider() },
    ...overrides }],
});
const ready = snapshot();
const error = snapshot({ providers: { claude: provider('error'), codex: provider(), antigravity: provider(), opencode_go: provider() } });
const missing = JSON.stringify({ generatedAt: '2026-11-22T00:00:00Z', collectedAt: null, nodes: [] });
const warning = 'Model preset status is not confirmed yet; it updates within five minutes.';

function run(responses, rejectPresets = false) {
  const dir = mkdtempSync(join(tmpdir(), 'install-presets-'));
  try {
    const root = join(dir, 'root'), tmp = join(dir, 'tmp');
    mkdirSync(root); mkdirSync(tmp);
    writeFileSync(join(root, '.env.orch'), `AUTH_BEARER_TOKEN=${bearer}\n`);
    writeFileSync(join(root, '.admin-password'), 'password\n');
    responses.forEach((value, i) => writeFileSync(join(dir, `response-${i + 1}`), value));
    writeFileSync(join(dir, 'presets'), JSON.stringify({ model_presets: [
      { backend: 'claude', available: false, reason: 'not_authenticated' },
      { backend: 'claude', available: false, reason: 'not_authenticated' },
      { backend: 'codex', available: true, reason: null },
    ] }));
    const shell = `
      set -Eeuo pipefail
      source "$1"
      trap 'printf "ERR trap invoked\\n" >&2; exit 91' ERR
      curl() {
        printf '%s\\n' CALL "$@" >> "$TEST_DIR/args"
        local arg header= count=0
        for arg in "$@"; do [[ "$arg" == @* ]] && header=\${arg#@}; done
        [[ -n "$header" && "$(stat -c %a "$header")" == 600 ]] || return 12
        [[ "$(cat "$header")" == "Authorization: Bearer $TEST_BEARER" ]] || return 13
        printf '%s\\n' "$header" >> "$TEST_DIR/headers"
        if [[ " $* " == *'/api/usage/refresh'* ]]; then
          [[ ! -f "$TEST_DIR/count" ]] || count=$(cat "$TEST_DIR/count")
          count=$((count+1)); printf '%s' "$count" > "$TEST_DIR/count"
          [[ "$(cat "$TEST_DIR/response-$count")" != CURL_FAIL ]] || return 7
          cat "$TEST_DIR/response-$count"
        else
          [[ "$TEST_REJECT_PRESETS" != true ]] || return 22
          cat "$TEST_DIR/presets"
        fi
      }
      sleep() { printf '%s\\n' "$1" >> "$TEST_DIR/sleeps"; }
      as_soul() { printf abc; }
      BACKENDS=codex; TAILSCALE=false; LOG="$TEST_DIR/install.log"
      run_step 'Checking model presets' refresh_model_presets "$2"
      printf 'PENDING=%s\\n' "\${PRESET_REFRESH_PENDING-unset}"
      finish_message "$2"
    `;
    const result = spawnSync('bash', ['-c', shell, 'bash', script, root], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, TEST_DIR: dir, TEST_BEARER: bearer, TEST_REJECT_PRESETS: String(rejectPresets), TMPDIR: tmp },
    });
    const args = existsSync(join(dir, 'args')) ? readFileSync(join(dir, 'args'), 'utf8') : '';
    const headers = existsSync(join(dir, 'headers')) ? readFileSync(join(dir, 'headers'), 'utf8').trim().split('\n') : [];
    const log = readFileSync(join(dir, 'install.log'), 'utf8');
    const sleeps = existsSync(join(dir, 'sleeps')) ? readFileSync(join(dir, 'sleeps'), 'utf8').trim().split('\n') : [];
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!`${result.stdout}${result.stderr}${log}`.includes(bearer));
    assert.ok(!args.includes(bearer));
    assert.ok(headers.length > 0);
    for (const header of headers) { assert.ok(args.includes(`@${header}`)); assert.ok(!existsSync(header)); }
    assert.ok(!result.stderr.includes('ERR trap invoked'));
    return { output: result.stdout + log, args, sleeps };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const [name, responses, refreshes, pending] of [
  ['retries a provider error', [error, ready], 2, false],
  ['retries when the local node is absent', [missing, ready], 2, false],
  ['warns after six unconfirmed snapshots', Array(6).fill(error), 6, true],
  ['retries a failed curl without invoking ERR', ['CURL_FAIL', ready], 2, false],
  ['confirms the first fresh snapshot', [ready], 1, false],
  ['does not require an Antigravity provider', [snapshot({ providers: { claude: provider(), codex: provider(), antigravity: null, opencode_go: provider() } })], 1, false],
  ['retries stale and malformed responses', [snapshot({ stale: true }), 'not JSON', ready], 3, false],
  ['retries a stale provider and a missing provider', [snapshot({ providers: { claude: provider('auto', true), codex: provider(), antigravity: provider(), opencode_go: provider() } }), snapshot({ providers: { claude: null, codex: provider(), antigravity: provider(), opencode_go: provider() } }), ready], 3, false],
]) {
  test(name, () => {
    const { output, args, sleeps } = run(responses);
    if (name === 'retries when the local node is absent') assert.match(output, /^Preset refresh attempt 1: local unavailable$/m);
    assert.equal((args.match(/\/api\/usage\/refresh/g) ?? []).length, refreshes);
    assert.equal((output.match(/Preset refresh attempt /g) ?? []).length, refreshes);
    assert.deepEqual(sleeps, Array(refreshes - 1).fill('10'));
    assert.equal((args.match(/\/api\/nodes\/local\/model-presets/g) ?? []).length, pending ? 0 : 1);
    assert.equal((args.match(/--max-time\n60/g) ?? []).length, refreshes + (pending ? 0 : 1));
    assert.match(output, new RegExp(`PENDING=${pending ? 'true' : 'unset'}`));
    assert.equal(output.includes(warning), pending);
    if (!pending) assert.match(output, /claude.*false.*not_authenticated.*2/);
  });
}

test('a rejected preset listing does not undo confirmation', () => {
  const { output, args } = run([ready], true);
  assert.match(output, /PENDING=unset/);
  assert.match(output, /Model preset counts unavailable; skipping\./);
  assert.ok(!output.includes(warning));
  assert.equal((args.match(/\/api\/nodes\/local\/model-presets/g) ?? []).length, 1);
});
