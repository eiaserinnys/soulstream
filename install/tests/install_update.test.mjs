// Rerunning the installer on an installed server: repository checks, maintenance stop, the state file,
// and the configuration files the installer manages.
//
// Nothing here reaches the network or the host's services: git remotes are bare repositories in a
// temporary directory, systemctl, chown and the other system commands are the fakes from
// support/fake_commands.mjs, and every path (home, units, log) is temporary.
//
// fixtures/stage1/<backends>/ holds what the first-stage installer (d785f798, before atom support)
// wrote to agents.yaml, mcp-registry.yaml, mcp-profiles.yaml and AGENTS.md. CI checkouts are shallow,
// so the files are kept here instead of being read with git show. They were made by running that
// installer's render_config in a temporary home and replacing the home prefix with /home/soulstream:
//
//   tmp=$(mktemp -d)
//   git show d785f79826b137d9870e8e96c4dbd1d9e14c13b9:install/install.sh > "$tmp/stage1-install.sh"
//   for backends in claude,codex codex claude,codex,antigravity; do
//     home=$tmp/${backends//,/-}/home
//     bash -c 'set -Eeuo pipefail; source "$1"; BACKENDS=$2; render_config "$3" "$3/soulstream"' bash "$tmp/stage1-install.sh" "$backends" "$home"
//     out=install/tests/fixtures/stage1/${backends//,/-}
//     mkdir -p "$out"
//     for file in soulstream/config/agents.yaml soulstream/config/mcp-registry.yaml soulstream/config/mcp-profiles.yaml workspace/AGENTS.md; do
//       sed "s#$home#/home/soulstream#g" "$home/$file" > "$out/${file##*/}"
//     done
//   done
//   rm -rf "$tmp"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { completeLanguages } from '../seed/locales/languages.mjs';
import { createFakeCommands, runBash } from './support/fake_commands.mjs';
import { copyCatalog, copyCommonFiles } from './support/catalog.mjs';

const script = resolve('install/install.sh');
const fixtures = resolve('install/tests/fixtures/stage1');
const stage1Presets = resolve('install/stage1-managed-presets.json');
// Git ignores the host configuration, so no URL rewrite or credential helper applies.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } }).trim();
// The fake installer is what the soulstream origin carries as install/install.sh; setup() writes the same bytes as the running installer.
const FAKE_INSTALLER = '#!/usr/bin/env bash\n# installer under test\n';
const localeFiles = ['installer-language.mjs', 'languages.mjs', 'languages.json', ...completeLanguages.map((lang) => `${lang}/installer.json`)]
  .map((name) => `install/seed/locales/${name}`);
const SEED = {
  'install/seed/load_atom_seed.mjs': '// atom seed loader\n',
  'install/install.sh': FAKE_INSTALLER,
  ...Object.fromEntries(localeFiles.map((file) => [file, readFileSync(file)])),
};
const UNITS = ['soulstream-worker.service', 'soulstream-orch.service', 'soulstream-atom.service'];

// A bare origin and a working copy that pushes to it. A commit on main moves the default channel (beta) with it,
// unless { beta: false } leaves beta behind, as when main has commits that were not verified yet.
function remote(dir, name) {
  const origin = join(dir, `${name}.git`), work = join(dir, `${name}-work`);
  git('init', '-q', '--bare', '--initial-branch=main', origin);
  git('init', '-q', '--initial-branch=main', work);
  git('-C', work, 'remote', 'add', 'origin', origin);
  let count = 0;
  const commit = (files = {}, branch = 'main', { beta = branch === 'main' } = {}) => {
    if (branch !== 'main') git('-C', work, 'checkout', '-q', '-B', branch);
    for (const [path, body] of Object.entries({ ...files, [`${name}.txt`]: `${name} ${++count}\n` })) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), body);
    }
    git('-C', work, 'add', '-A');
    git('-C', work, 'commit', '-q', '-m', `${name} ${count}`);
    git('-C', work, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
    if (beta) git('-C', work, 'push', '-q', 'origin', 'HEAD:refs/heads/beta');
    const sha = git('-C', work, 'rev-parse', 'HEAD');
    if (branch !== 'main') git('-C', work, 'checkout', '-q', 'main');
    return sha;
  };
  const tag = (label, sha) => {
    git('-C', work, 'tag', '-a', label, '-m', label, sha);
    git('-C', work, 'push', '-q', 'origin', `refs/tags/${label}`);
  };
  return { origin, commit, tag };
}

const PRELUDE = `set -Eeuo pipefail
source "$INSTALL_SH"
as_soul() { "$@"; }
SOULSTREAM_REPO_URL=$S_URL
ATOM_REPO_URL=$A_URL
SYSTEMD_DIR=$UNITS
RUNNING_INSTALLER=$INSTALLER_COPY
LOG=$FAKE_DIR/install.log
: >> "$LOG"
exec 3>>"$FAKE_DIR/fd3.log"
`;
const PRINT_REPOS = `for name in soulstream atom; do printf '%s %s previous=%s target=%s mode=%s\\n' "$name" "\${REPO_PATH[$name]-}" "\${REPO_PREVIOUS[$name]-}" "\${REPO_TARGET[$name]-}" "\${REPO_MODE[$name]-}"; done\n`;

function setup({ units = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'install-update-'));
  const home = join(dir, 'home'), root = join(home, 'soulstream'), atomRoot = join(home, 'atom'), unitDir = join(dir, 'units');
  mkdirSync(home); mkdirSync(unitDir);
  if (units) for (const unit of UNITS) writeFileSync(join(unitDir, unit), '[Unit]\n');
  const soul = remote(dir, 'soulstream'), atom = remote(dir, 'atom');
  const fake = createFakeCommands(dir);
  const installerCopy = join(dir, 'running-install.sh');
  writeFileSync(installerCopy, FAKE_INSTALLER);
  const run = async (body, extra = {}) => {
    const result = await runBash(PRELUDE + body, [], { env: fake.env({ ...GIT_ENV, INSTALL_SH: script, INSTALLER_COPY: installerCopy, HOME_DIR: home, ROOT: root, ATOM_ROOT: atomRoot, UNITS: unitDir, S_URL: soul.origin, A_URL: atom.origin, ...extra }) });
    fake.assertNoProtectedRequests();
    return result;
  };
  const head = (path) => git('-C', path, 'rev-parse', 'HEAD');
  const branch = (path) => git('-C', path, 'rev-parse', '--abbrev-ref', 'HEAD');
  const fd3 = () => (existsSync(join(dir, 'fd3.log')) ? readFileSync(join(dir, 'fd3.log'), 'utf8') : '');
  const statePath = join(root, '.local', 'install-state.json');
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const systemctl = () => fake.argv().includes('== systemctl\n');
  return { dir, home, root, atomRoot, unitDir, soul, atom, fake, run, head, branch, fd3, statePath, state, systemctl, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const repos = (stdout) => Object.fromEntries(stdout.split('\n').filter((line) => /^(soulstream|atom) /.test(line)).map((line) => {
  const [name, path, ...fields] = line.split(' ');
  return [name, { path, ...Object.fromEntries(fields.map((field) => field.split('='))) }];
}));
const CHECK = `parse_args "$@"\ncheck_repositories "$ROOT" "$ATOM_ROOT"\n${PRINT_REPOS}`;
const check = (t, ...args) => t.run(`set -- ${args.map((arg) => `'${arg}'`).join(' ')}\n${CHECK}`);
const checkAndCheckout = (t, ...args) => t.run(`set -- ${args.map((arg) => `'${arg}'`).join(' ')}\n${CHECK}checkout_revisions\n`);

test('a missing atom checkout is cloned while checking, with no previous commit and no service stopped', async () => {
  const t = setup();
  try {
    const s1 = t.soul.commit(SEED), a1 = t.atom.commit();
    git('clone', '-q', t.soul.origin, t.root);
    const result = await check(t);
    assert.equal(result.status, 0, result.stderr);
    const r = repos(result.stdout);
    assert.ok(existsSync(join(t.atomRoot, '.git')));
    assert.deepEqual(r.atom, { path: t.atomRoot, previous: '', target: a1, mode: 'branch' });
    assert.deepEqual(r.soulstream, { path: t.root, previous: s1, target: s1, mode: 'branch' });
    assert.equal(t.systemctl(), false);
  } finally { t.cleanup(); }
});

test('a repository path that is not a git checkout stops the check and is left alone', async () => {
  const t = setup();
  try {
    t.soul.commit(SEED); t.atom.commit();
    git('clone', '-q', t.soul.origin, t.root);
    mkdirSync(t.atomRoot);
    writeFileSync(join(t.atomRoot, 'notes.txt'), 'keep\n');
    const result = await check(t);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${t.atomRoot}: Exists and is not a git checkout\\.`));
    assert.deepEqual(readdirSync(t.atomRoot), ['notes.txt']);
    assert.equal(readFileSync(join(t.atomRoot, 'notes.txt'), 'utf8'), 'keep\n');
    assert.equal(t.systemctl(), false);
  } finally { t.cleanup(); }
});

test('tracked changes stop the check and untracked installer files do not', async () => {
  const t = setup();
  try {
    t.soul.commit(SEED); t.atom.commit();
    git('clone', '-q', t.soul.origin, t.root);
    git('clone', '-q', t.atom.origin, t.atomRoot);
    writeFileSync(join(t.root, 'soulstream.txt'), 'edited\n');
    const dirty = await check(t);
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, new RegExp(`${t.root}: Repository has uncommitted changes\\.`));
    assert.equal(t.systemctl(), false);
    git('-C', t.root, 'checkout', '--', 'soulstream.txt');
    mkdirSync(join(t.root, 'config'));
    for (const file of ['config/agents.yaml', '.env.orch', '.admin-password']) writeFileSync(join(t.root, file), `${file}\n`);
    writeFileSync(join(t.atomRoot, '.env'), 'API_PORT=4200\n');
    const clean = await check(t);
    assert.equal(clean.status, 0, clean.stderr);
  } finally { t.cleanup(); }
});

test('a revision that cannot be resolved stops the check', async () => {
  const t = setup();
  try {
    t.soul.commit(SEED); t.atom.commit();
    git('clone', '-q', t.soul.origin, t.root);
    git('clone', '-q', t.atom.origin, t.atomRoot);
    const soulRef = await check(t, '--ref', 'no-such-ref');
    assert.notEqual(soulRef.status, 0);
    assert.match(soulRef.stderr, new RegExp(`${t.root}: Cannot resolve revision no-such-ref\\.`));
    const atomRef = await check(t, '--atom-ref', 'no-such-atom-ref');
    assert.notEqual(atomRef.status, 0);
    assert.match(atomRef.stderr, new RegExp(`${t.atomRoot}: Cannot resolve revision no-such-atom-ref\\.`));
    assert.equal(t.systemctl(), false);
  } finally { t.cleanup(); }
});

test('without a ref both repositories move to the newest origin beta', async () => {
  const t = setup();
  try {
    const s1 = t.soul.commit(SEED), a1 = t.atom.commit();
    git('clone', '-q', t.soul.origin, t.root);
    git('clone', '-q', t.atom.origin, t.atomRoot);
    const s2 = t.soul.commit(), a2 = t.atom.commit();
    const result = await checkAndCheckout(t);
    assert.equal(result.status, 0, result.stderr);
    const r = repos(result.stdout);
    assert.deepEqual([r.soulstream.previous, r.soulstream.target, r.atom.previous, r.atom.target], [s1, s2, a1, a2]);
    assert.deepEqual([t.head(t.root), t.branch(t.root), t.head(t.atomRoot), t.branch(t.atomRoot)], [s2, 'beta', a2, 'beta']);
  } finally { t.cleanup(); }
});

test('a branch ref checks out the branch; tag and commit refs detach at their commit', async () => {
  const t = setup();
  try {
    const s1 = t.soul.commit(SEED), s2 = t.soul.commit(), s3 = t.soul.commit();
    const a1 = t.atom.commit(), a2 = t.atom.commit();
    const feature = t.soul.commit({}, 'feature');
    t.soul.tag('v1', s1);
    git('clone', '-q', t.soul.origin, t.root);
    assert.equal(t.head(t.root), s3);

    const onBranch = await checkAndCheckout(t, '--ref', 'feature');
    assert.equal(onBranch.status, 0, onBranch.stderr);
    assert.equal(repos(onBranch.stdout).soulstream.mode, 'branch');
    assert.deepEqual([t.head(t.root), t.branch(t.root)], [feature, 'feature']);
    assert.deepEqual([t.head(t.atomRoot), t.branch(t.atomRoot)], [a2, 'beta']);

    const onTag = await checkAndCheckout(t, '--ref', 'v1');
    assert.equal(onTag.status, 0, onTag.stderr);
    assert.deepEqual([repos(onTag.stdout).soulstream.target, repos(onTag.stdout).soulstream.mode], [s1, 'detach']);
    assert.deepEqual([t.head(t.root), t.branch(t.root)], [s1, 'HEAD']);

    const onCommit = await checkAndCheckout(t, '--ref', s2, '--atom-ref', a1);
    assert.equal(onCommit.status, 0, onCommit.stderr);
    assert.deepEqual([t.head(t.root), t.branch(t.root), t.head(t.atomRoot), t.branch(t.atomRoot)], [s2, 'HEAD', a1, 'HEAD']);
    assert.equal(t.systemctl(), false);
  } finally { t.cleanup(); }
});

test('a first-stage checkout updates when the target has atom support, and an older target stops', async () => {
  const t = setup();
  try {
    const stageOne = t.soul.commit();
    t.atom.commit();
    git('clone', '-q', t.soul.origin, t.root);
    const withAtom = t.soul.commit(SEED);

    const old = await check(t, '--ref', stageOne);
    assert.notEqual(old.status, 0);
    assert.match(old.stderr, /The selected Soulstream revision predates atom support\./);
    assert.ok(!existsSync(t.atomRoot));
    assert.equal(t.head(t.root), stageOne);
    assert.equal(t.systemctl(), false);

    const promoted = await checkAndCheckout(t);
    assert.equal(promoted.status, 0, promoted.stderr);
    assert.ok(existsSync(join(t.atomRoot, '.git')));
    assert.deepEqual([t.head(t.root), t.branch(t.root)], [withAtom, 'beta']);
  } finally { t.cleanup(); }
});

test('local commits that are not on origin stop the check', async () => {
  const t = setup();
  try {
    t.soul.commit(SEED); t.atom.commit();
    git('clone', '-q', '--branch', 'beta', t.soul.origin, t.root);
    git('clone', '-q', t.atom.origin, t.atomRoot);
    git('-C', t.root, 'commit', '-q', '--allow-empty', '-m', 'local only');
    const local = t.head(t.root);
    const result = await check(t);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${t.root}: Local branch beta has commits that are not on origin\\.`));
    assert.equal(t.head(t.root), local);
    assert.equal(t.systemctl(), false);
    // An explicit ref keeps the same protection on its own branch.
    const onMain = await check(t, '--ref', 'main');
    assert.equal(onMain.status, 0, onMain.stderr);
    git('-C', t.root, 'checkout', '-q', '-B', 'main', 'origin/main');
    git('-C', t.root, 'commit', '-q', '--allow-empty', '-m', 'local only on main');
    const explicit = await check(t, '--ref', 'main');
    assert.notEqual(explicit.status, 0);
    assert.match(explicit.stderr, new RegExp(`${t.root}: Local branch main has commits that are not on origin\\.`));
  } finally { t.cleanup(); }
});

test('a failed clone leaves no directory behind', async () => {
  const t = setup();
  try {
    t.soul.commit(SEED);
    git('clone', '-q', t.soul.origin, t.root);
    const result = await t.run(CHECK, { A_URL: join(t.dir, 'missing.git') });
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(t.atomRoot));
    assert.equal(t.systemctl(), false);
  } finally { t.cleanup(); }
});

// run_install with every heavy step replaced by a fake that records its name; the repository
// checks, the maintenance stop, the state file and on_error are the real functions.
const FAKE_STEPS = ['install_packages', 'setup_account', 'install_node', 'install_clis', 'setup_secrets', 'setup_database',
  'build_atom', 'init_atom', 'start_atom', 'issue_atom_api_key', 'load_atom_instructions', 'write_configuration',
  'build_project', 'setup_schema', 'install_units', 'setup_tailscale_serve', 'wait_and_create_workspace', 'refresh_model_presets'];
const FLOW = `fake_step() { printf '== step\\n%s\\n' "$1" >> "$FAKE_ARGV_LOG"; [[ "$1" != "\${FAIL_STEP:-}" ]]; }
${FAKE_STEPS.map((name) => `${name}() { fake_step ${name}; }`).join('\n')}
parse_args
trap on_error ERR
run_install "$HOME_DIR" "$ROOT" "$ATOM_ROOT"
`;
const stopAt = (argv, unit, from = 0) => argv.indexOf(`== systemctl\nstop\n${unit}\n`, from);
const stepAt = (argv, name) => argv.indexOf(`== step\n${name}\n`);
// Clones both repositories and moves both origins one commit ahead.
function installed(t) {
  const s1 = t.soul.commit(SEED), a1 = t.atom.commit();
  git('clone', '-q', t.soul.origin, t.root);
  git('clone', '-q', t.atom.origin, t.atomRoot);
  return { s1, a1, s2: t.soul.commit(), a2: t.atom.commit() };
}
function assertStoppedAfterFailure(t, result, fakeName, step, shas) {
  assert.equal(result.status, 1);
  const argv = t.fake.argv(), failedAt = stepAt(argv, fakeName);
  assert.ok(failedAt > stepAt(argv, 'start_atom'));
  const again = UNITS.map((unit) => stopAt(argv, unit, failedAt));
  assert.ok(again[0] > failedAt && again[0] < again[1] && again[1] < again[2], argv);
  const state = t.state();
  assert.equal(state.status, 'failed');
  assert.equal(state.step, step);
  assert.deepEqual(state.repositories.soulstream, { path: t.root, previous_sha: shas.s1, target_sha: shas.s2, current_sha: shas.s2 });
  assert.deepEqual(state.repositories.atom, { path: t.atomRoot, previous_sha: shas.a1, target_sha: shas.a2, current_sha: shas.a2 });
  assert.deepEqual(state.units, Object.fromEntries(UNITS.map((unit) => [unit, 'inactive'])));
  assert.ok(t.fd3().includes(`Installation failed at: ${step}\n`));
  assert.ok(t.fd3().endsWith(`Services stopped: soulstream-worker=inactive soulstream-orch=inactive soulstream-atom=inactive
State: ${t.root}/.local/install-state.json
Fix the cause, then run the same command again.
`), t.fd3());
}

test('an unavailable install language stops the update before stopping services', async () => {
  const t = setup();
  try {
    installed(t);
    const result = await t.run(FLOW.replace('\nparse_args\n', '\nparse_args --lang ja\n'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Language ja is not available yet\. Available languages: ko/);
    assert.equal(t.systemctl(), false);
  } finally {
    t.cleanup();
  }
});

test('an update stops the services before changing anything and ends completed', async () => {
  const t = setup();
  try {
    const shas = installed(t);
    const result = await t.run(FLOW);
    assert.equal(result.status, 0, t.fd3());
    const argv = t.fake.argv();
    const stops = UNITS.map((unit) => stopAt(argv, unit));
    assert.ok(stops[0] >= 0 && stops[0] < stops[1] && stops[1] < stops[2] && stops[2] < stepAt(argv, 'setup_secrets'), argv);
    assert.deepEqual([...argv.matchAll(/== step\n(.+)\n/g)].map((m) => m[1]), FAKE_STEPS.filter((name) => name !== 'setup_tailscale_serve'));
    const state = t.state();
    assert.equal(state.status, 'completed');
    assert.equal(state.step, 'Checking services and workspace');
    assert.match(state.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(state.repositories.soulstream, { path: t.root, previous_sha: shas.s1, target_sha: shas.s2, current_sha: shas.s2 });
    assert.deepEqual(state.repositories.atom, { path: t.atomRoot, previous_sha: shas.a1, target_sha: shas.a2, current_sha: shas.a2 });
    assert.equal(state.units, undefined);
    assert.equal(statSync(t.statePath).mode & 0o777, 0o600);
    assert.ok(result.stdout.includes(`\nSoulstream revision: ${shas.s1.slice(0, 12)} -> ${shas.s2.slice(0, 12)}\nAtom revision: ${shas.a1.slice(0, 12)} -> ${shas.a2.slice(0, 12)}\n`), result.stdout);
  } finally { t.cleanup(); }
});

test('a build failure after atom started stops all three services and records the failure', async () => {
  const t = setup();
  try {
    const shas = installed(t);
    assertStoppedAfterFailure(t, await t.run(FLOW, { FAIL_STEP: 'build_project' }), 'build_project', 'Building Soulstream', shas);
  } finally { t.cleanup(); }
});

test('a failed final health check stops all three services and records the failure', async () => {
  const t = setup();
  try {
    const shas = installed(t);
    const result = await t.run(FLOW, { FAIL_STEP: 'wait_and_create_workspace' });
    assert.ok(stepAt(t.fake.argv(), 'install_units') >= 0);
    assertStoppedAfterFailure(t, result, 'wait_and_create_workspace', 'Checking services and workspace', shas);
  } finally { t.cleanup(); }
});

test('running the same command again after fixing the cause completes', async () => {
  const t = setup();
  try {
    const shas = installed(t);
    assert.equal((await t.run(FLOW, { FAIL_STEP: 'build_project' })).status, 1);
    assert.equal(t.state().status, 'failed');
    const rerun = await t.run(FLOW);
    assert.equal(rerun.status, 0, t.fd3());
    const state = t.state();
    assert.equal(state.status, 'completed');
    assert.equal(state.units, undefined);
    assert.deepEqual(state.repositories.soulstream, { path: t.root, previous_sha: shas.s2, target_sha: shas.s2, current_sha: shas.s2 });
  } finally { t.cleanup(); }
});

test('a failed repository check stops no service and writes no state file', async () => {
  const t = setup();
  try {
    installed(t);
    writeFileSync(join(t.root, 'soulstream.txt'), 'edited\n');
    const result = await t.run(FLOW);
    assert.equal(result.status, 1);
    assert.ok(t.fd3().includes('Installation failed at: Checking repositories\n'));
    assert.ok(!t.fd3().includes('Services stopped:'));
    assert.equal(t.systemctl(), false);
    assert.ok(!existsSync(t.statePath));
    assert.equal(stepAt(t.fake.argv(), 'setup_secrets'), -1);
  } finally { t.cleanup(); }
});

test('a first installation without unit files stops nothing and still writes the state file', async () => {
  const t = setup({ units: false });
  try {
    const s1 = t.soul.commit(SEED), a1 = t.atom.commit();
    const result = await t.run(FLOW);
    assert.equal(result.status, 0, t.fd3());
    assert.equal(t.systemctl(), false);
    const state = t.state();
    assert.equal(state.status, 'completed');
    assert.deepEqual(state.repositories.soulstream, { path: t.root, previous_sha: null, target_sha: s1, current_sha: s1 });
    assert.deepEqual(state.repositories.atom, { path: t.atomRoot, previous_sha: null, target_sha: a1, current_sha: a1 });
    assert.ok(result.stdout.includes(`\nSoulstream revision: none -> ${s1.slice(0, 12)}\nAtom revision: none -> ${a1.slice(0, 12)}\n`), result.stdout);
  } finally { t.cleanup(); }
});

// The default channel: without --ref and --atom-ref both repositories follow origin/beta.
const EXPLICIT_MAIN = FLOW.replace('parse_args\n', 'parse_args --ref main --atom-ref main\n');
const notAncestor = (dir, head, beta) => `${dir}: current HEAD ${head.slice(0, 12)} is not an ancestor of origin/beta ${beta.slice(0, 12)}. Pass --ref main --atom-ref main to keep tracking main.`;
const DOWNLOAD = 'Download install.sh from https://raw.githubusercontent.com/eiaserinnys/soulstream/beta/install/install.sh and run it again, or pass --ref main --atom-ref main with the installer from main.';
const didNotStart = (t) => {
  const argv = t.fake.argv();
  assert.equal(t.systemctl(), false);
  assert.equal(stepAt(argv, 'install_packages'), -1);
  assert.equal(stepAt(argv, 'install_node'), -1);
  assert.ok(!existsSync(t.statePath));
};

test('with main ahead of beta, no arguments check out origin/beta and --ref main --atom-ref main check out origin/main', async () => {
  const t = setup();
  try {
    t.soul.commit(SEED); t.atom.commit();
    git('clone', '-q', t.soul.origin, t.root);
    git('clone', '-q', t.atom.origin, t.atomRoot);
    const s2 = t.soul.commit(), a2 = t.atom.commit();
    const s3 = t.soul.commit({}, 'main', { beta: false }), a3 = t.atom.commit({}, 'main', { beta: false });
    const channel = await checkAndCheckout(t);
    assert.equal(channel.status, 0, channel.stderr);
    assert.deepEqual([t.head(t.root), t.branch(t.root), t.head(t.atomRoot), t.branch(t.atomRoot)], [s2, 'beta', a2, 'beta']);
    const latest = await checkAndCheckout(t, '--ref', 'main', '--atom-ref', 'main');
    assert.equal(latest.status, 0, latest.stderr);
    assert.deepEqual([t.head(t.root), t.branch(t.root), t.head(t.atomRoot), t.branch(t.atomRoot)], [s3, 'main', a3, 'main']);
    assert.equal(t.systemctl(), false);
  } finally { t.cleanup(); }
});

for (const side of ['soulstream', 'atom']) {
  test(`a ${side} checkout on main ahead of beta stops with no systemctl call and before Node.js is touched`, async () => {
    const t = setup();
    try {
      const s1 = t.soul.commit(SEED), a1 = t.atom.commit();
      git('clone', '-q', t.soul.origin, t.root);
      git('clone', '-q', t.atom.origin, t.atomRoot);
      const aheadOf = side === 'soulstream' ? { dir: t.root, beta: s1, ahead: t.soul.commit({}, 'main', { beta: false }) } : { dir: t.atomRoot, beta: a1, ahead: t.atom.commit({}, 'main', { beta: false }) };
      git('-C', aheadOf.dir, 'pull', '-q', '--ff-only', 'origin', 'main');
      const message = notAncestor(aheadOf.dir, aheadOf.ahead, aheadOf.beta);

      const direct = await check(t);
      assert.notEqual(direct.status, 0);
      assert.ok(direct.stderr.includes(message), direct.stderr);
      assert.equal(t.systemctl(), false);

      // Both checkouts exist, so the check runs before the first step: no package, Node.js or CLI step is reached.
      const result = await t.run(FLOW);
      assert.equal(result.status, 1);
      assert.ok(t.fd3().includes('Installation failed at: Checking repositories\n'), t.fd3());
      assert.ok(t.fd3().includes(message), t.fd3());
      assert.ok(!t.fd3().includes('Services stopped:'));
      didNotStart(t);
      assert.equal(t.head(aheadOf.dir), aheadOf.ahead);

      // --ref main --atom-ref main keeps tracking main and is not blocked.
      const tracking = await t.run(EXPLICIT_MAIN);
      assert.equal(tracking.status, 0, t.fd3());
      assert.equal(t.state().status, 'completed');
    } finally { t.cleanup(); }
  });
}

test('a main checkout that is behind beta moves forward to beta', async () => {
  const t = setup();
  try {
    const s1 = t.soul.commit(SEED), a1 = t.atom.commit();
    git('clone', '-q', t.soul.origin, t.root);
    git('clone', '-q', t.atom.origin, t.atomRoot);
    const s2 = t.soul.commit(), a2 = t.atom.commit();
    t.soul.commit({}, 'main', { beta: false });
    const result = await t.run(FLOW);
    assert.equal(result.status, 0, t.fd3());
    assert.deepEqual([t.head(t.root), t.branch(t.root), t.head(t.atomRoot), t.branch(t.atomRoot)], [s2, 'beta', a2, 'beta']);
    assert.deepEqual([t.state().repositories.soulstream.previous_sha, t.state().repositories.atom.previous_sha], [s1, a1]);
  } finally { t.cleanup(); }
});

test('a running installer that differs from install/install.sh of the target stops a default run before anything changes', async () => {
  const t = setup();
  try {
    installed(t);
    const older = join(t.dir, 'older-install.sh');
    writeFileSync(older, '#!/usr/bin/env bash\n# an older installer\n');
    for (const copy of [older, join(t.dir, 'does-not-exist.sh')]) {
      const result = await t.run(FLOW, { INSTALLER_COPY: copy });
      assert.equal(result.status, 1);
      assert.ok(t.fd3().includes(DOWNLOAD), t.fd3());
      didNotStart(t);
    }
    // The same stop in the repository check of a new server, which has no checkout to look at first.
    const fresh = setup({ units: false });
    try {
      fresh.soul.commit(SEED); fresh.atom.commit();
      const result = await fresh.run(FLOW, { INSTALLER_COPY: older });
      assert.equal(result.status, 1);
      assert.ok(fresh.fd3().includes(DOWNLOAD), fresh.fd3());
      assert.equal(fresh.systemctl(), false);
      assert.ok(!existsSync(fresh.atomRoot));
    } finally { fresh.cleanup(); }
    // An explicit --ref is the administrator's choice: neither this check nor the ancestor check applies.
    const explicit = await t.run(EXPLICIT_MAIN, { INSTALLER_COPY: older });
    assert.equal(explicit.status, 0, t.fd3());
  } finally { t.cleanup(); }
});

test('without origin/beta a run ends with Cannot resolve revision origin/beta. and does not fall back to main', async () => {
  const t = setup();
  try {
    t.soul.commit(SEED, 'main', { beta: false }); t.atom.commit({}, 'main', { beta: false });
    git('clone', '-q', t.soul.origin, t.root);
    git('clone', '-q', t.atom.origin, t.atomRoot);
    const direct = await check(t);
    assert.notEqual(direct.status, 0);
    assert.match(direct.stderr, new RegExp(`${t.root}: Cannot resolve revision origin/beta\\.`));
    assert.equal(t.systemctl(), false);
    const result = await t.run(FLOW);
    assert.equal(result.status, 1);
    assert.ok(t.fd3().includes(`${t.root}: Cannot resolve revision origin/beta.`), t.fd3());
    didNotStart(t);
  } finally { t.cleanup(); }
  // A new server: the clone of the missing branch fails and leaves no directory.
  const fresh = setup({ units: false });
  try {
    fresh.soul.commit(SEED, 'main', { beta: false }); fresh.atom.commit({}, 'main', { beta: false });
    const result = await fresh.run(FLOW);
    assert.equal(result.status, 1);
    assert.ok(!existsSync(fresh.root));
    assert.ok(!existsSync(fresh.atomRoot));
    assert.equal(fresh.systemctl(), false);
  } finally { fresh.cleanup(); }
});

test('after a new server fails before the services stop, the same command runs again without being blocked', async () => {
  const t = setup({ units: false });
  try {
    const s1 = t.soul.commit(SEED);
    // main is ahead of beta: a clone that kept the end of main would be refused on the next run.
    t.soul.commit({}, 'main', { beta: false });
    const failed = await t.run(FLOW, { A_URL: join(t.dir, 'missing-atom.git') });
    assert.equal(failed.status, 1);
    assert.deepEqual([t.head(t.root), t.branch(t.root)], [s1, 'beta']);
    assert.ok(!existsSync(t.atomRoot));
    assert.equal(t.systemctl(), false);
    const a1 = t.atom.commit();
    const rerun = await t.run(FLOW);
    assert.equal(rerun.status, 0, t.fd3());
    assert.equal(t.state().status, 'completed');
    assert.deepEqual([t.state().repositories.soulstream.target_sha, t.state().repositories.atom.target_sha], [s1, a1]);
  } finally { t.cleanup(); }
});

test('the running installer is found through a relative path after the directory changes', async () => {
  const t = setup();
  try {
    const installer = readFileSync(script, 'utf8');
    t.soul.commit({ ...SEED, 'install/install.sh': installer }); t.atom.commit();
    const work = join(t.dir, 'work');
    mkdirSync(join(work, 'install'), { recursive: true });
    writeFileSync(join(work, 'install', 'install.sh'), installer);
    const result = await t.run(`cd "$WORK"
source install/install.sh
as_soul() { "$@"; }
SOULSTREAM_REPO_URL=$S_URL; ATOM_REPO_URL=$A_URL; SYSTEMD_DIR=$UNITS
pin_running_installer
prepare_install_cwd
printf 'cwd=%s\\npinned=%s\\n' "$PWD" "$RUNNING_INSTALLER"
parse_args
check_repositories "$ROOT" "$ATOM_ROOT"
`, { WORK: work });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`cwd=/\npinned=${join(work, 'install', 'install.sh')}\n`), result.stdout);
    // A different file under the same relative name is refused.
    writeFileSync(join(work, 'install', 'install.sh'), `${installer}# edited\n`);
    const edited = await t.run(`cd "$WORK"
source install/install.sh
as_soul() { "$@"; }
SOULSTREAM_REPO_URL=$S_URL; ATOM_REPO_URL=$A_URL; SYSTEMD_DIR=$UNITS
pin_running_installer
prepare_install_cwd
parse_args
check_repositories "$ROOT" "$ATOM_ROOT"
`, { WORK: work });
    assert.notEqual(edited.status, 0);
    assert.ok(edited.stderr.includes(DOWNLOAD), edited.stderr);
  } finally { t.cleanup(); }
});

// The four managed configuration files, rendered as in the PR-1 tests (prepare_secrets, seed map, fake key).
const API_KEY = 'test-atom-key_0123456789abcdef';
const MAP = { common_rules: '00000000-aaaa-4bbb-8ccc-000000000001', seosoyoung_rules: '00000000-aaaa-4bbb-8ccc-000000000002' };
const EXPECTED_REGISTRY = `servers:
  - id: soulstream
    type: streamable_http
    url: http://127.0.0.1:4205/mcp
    headers:
      Authorization:
        env: PORTABLE_LOCAL_MCP_AUTHORIZATION
  - id: atom
    type: streamable_http
    url: http://127.0.0.1:4200/mcp
    headers:
      x-api-key:
        env: ATOM_API_KEY
`;
const EXPECTED_PROFILES = `profiles:
  - id: default
    name: Default
    mcp_servers: [soulstream, atom]
  - id: pas
    name: PAS
    mcp_servers: [soulstream, atom]
`;
const EXPECTED_AGENTS_MD = `# Soulstream workspace

Use this shared workspace for your work. Create project worktrees under \`.projects/<repository>--<branch>\`.
Keep temporary scripts in \`.local/tmp\` and work products in \`.local/artifacts\`.
Scripts of shared and custom skills live under \`$AGENT_COMMON_FILES_DIR/skills/<skill>/\`.
The \`soulstream\` MCP server provides session and workspace tools.
The \`atom\` MCP server holds your instructions and skills. Rules live under \`에이전트 > 공통 > rules\` and skills under \`에이전트 > 공통 > skills\`.
Find skills with \`search_skills\` and read them with \`load_skill\`. Read any other atom node with \`compile_subtree\`.
`;
const KINDS = { agents: 'agents.yaml', 'mcp-registry': 'mcp-registry.yaml', 'mcp-profiles': 'mcp-profiles.yaml', 'agents-md': 'AGENTS.md' };
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const ids = (text) => [...text.matchAll(/^ {2}- id: (.+)$/gm)].map((m) => m[1]);

function configSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'install-managed-'));
  const home = join(dir, 'home'), root = join(home, 'soulstream'), atomRoot = join(home, 'atom');
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(atomRoot);
  copyCatalog(root);
  mkdirSync(join(root, 'install'), { recursive: true });
  copyCommonFiles(root);
  copyFileSync(stage1Presets, join(root, 'install/stage1-managed-presets.json'));
  writeFileSync(join(root, 'config', '.atom-seed-map.json'), JSON.stringify(MAP));
  writeFileSync(join(root, '.atom-api-key'), `${API_KEY}\n`);
  const fake = createFakeCommands(dir);
  const files = {
    agents: join(root, 'config', 'agents.yaml'), 'mcp-registry': join(root, 'config', 'mcp-registry.yaml'),
    'mcp-profiles': join(root, 'config', 'mcp-profiles.yaml'), 'agents-md': join(home, 'workspace', 'AGENTS.md'),
  };
  const record = join(root, 'config', '.installer-managed.sha256');
  const render = async (backends, tail = '', expectFailure = false) => {
    const result = await runBash(`set -Eeuo pipefail
source "$INSTALL_SH"
as_soul() { if [[ "$1" == git ]]; then printf abc; else "$@"; fi; }
exec 3>&2
parse_args --backends ${backends}
setup_secrets "$ROOT" "$ATOM_ROOT"
render_config "$HOME_DIR" "$ROOT"
printf 'WARNINGS<%s>\\n' "$MANAGED_CONFIG_WARNINGS"
${tail}`, [], { env: fake.env({ INSTALL_SH: script, HOME_DIR: home, ROOT: root, ATOM_ROOT: atomRoot }) });
    fake.assertNoProtectedRequests();
    if (expectFailure) {
      assert.notEqual(result.status, 0, result.stderr);
      return result;
    }
    assert.equal(result.status, 0, result.stderr);
    const start = result.stdout.indexOf('WARNINGS<') + 9;
    return { ...result, warnings: result.stdout.slice(start, result.stdout.indexOf('>\n', start)) };
  };
  // Record lines by path.
  const recorded = () => Object.fromEntries(readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(66), line.slice(0, 64)]));
  const verifyRecord = () => execFileSync('sha256sum', ['-c', record], { encoding: 'utf8' });
  const read = (kind) => readFileSync(files[kind], 'utf8');
  // Places the first-stage output for a home of this test, as d785f798 left it.
  const placeStage1 = (backends) => {
    mkdirSync(join(home, 'workspace'), { recursive: true });
    for (const [kind, name] of Object.entries(KINDS)) {
      writeFileSync(files[kind], readFileSync(join(fixtures, backends.replaceAll(',', '-'), name), 'utf8').replaceAll('/home/soulstream', home));
    }
    symlinkSync('AGENTS.md', join(home, 'workspace', 'CLAUDE.md'));
    writeFileSync(join(root, '.env.soul-server-ts'), `SOULSTREAM_BACKENDS=${backends}\n`);
  };
  const kept = (file) => `Kept your ${file}; the installer's version is in ${file}.installer-new.`;
  return { dir, home, root, files, record, render, recorded, verifyRecord, read, placeStage1, kept, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a first render writes the four files and a record that sha256sum accepts', async () => {
  const t = configSetup();
  try {
    const result = await t.render('claude,codex');
    assert.equal(result.warnings, '');
    for (const file of Object.values(t.files)) assert.ok(statSync(file).isFile(), file);
    assert.equal(statSync(t.record).mode & 0o777, 0o644);
    assert.deepEqual(Object.keys(t.recorded()), Object.values(t.files));
    assert.equal(t.verifyRecord().split('\n').filter((line) => line.endsWith(': OK')).length, 4);
    assert.equal(readlinkSync(join(t.home, 'workspace', 'CLAUDE.md')), 'AGENTS.md');
  } finally { t.cleanup(); }
});

test('files the installer wrote follow a backend change and their record lines change', async () => {
  const t = configSetup();
  try {
    await t.render('claude,codex');
    const before = t.recorded();
    const result = await t.render('codex');
    assert.equal(result.warnings, '');
    assert.deepEqual(ids(t.read('agents')), ['seosoyoung', 'seosoyoung-pas', 'codex-default']);
    const after = t.recorded();
    assert.notEqual(after[t.files.agents], before[t.files.agents]);
    assert.equal(after[t.files.agents], sha256(t.files.agents));
    t.verifyRecord();
    assert.ok(!existsSync(`${t.files.agents}.installer-new`));
  } finally { t.cleanup(); }
});

test('an edited agents.yaml is kept, the new version goes beside it, and its record line stays', async () => {
  const t = configSetup();
  try {
    await t.render('claude,codex');
    appendFileSync(t.files.agents, '# my own profile notes\n');
    const edited = readFileSync(t.files.agents);
    // An earlier installer version wrote this mcp-profiles.yaml; its record line matches, so it is updated.
    writeFileSync(t.files['mcp-profiles'], 'profiles:\n  - id: default\n    name: Default\n    mcp_servers: [soulstream]\n');
    writeFileSync(t.record, readFileSync(t.record, 'utf8').replace(/^[0-9a-f]{64}(?=  .*mcp-profiles\.yaml$)/m, sha256(t.files['mcp-profiles'])));
    const before = t.recorded();
    const result = await t.render('codex', 'finish_message "$ROOT"\n');
    assert.ok(readFileSync(t.files.agents).equals(edited));
    assert.deepEqual(ids(readFileSync(`${t.files.agents}.installer-new`, 'utf8')), ['seosoyoung', 'seosoyoung-pas', 'codex-default']);
    assert.equal(result.warnings, `${t.kept(t.files.agents)}\n`);
    assert.ok(result.stdout.includes(`\nConfiguration:\n  ${t.kept(t.files.agents)}\n`), result.stdout);
    const after = t.recorded();
    assert.equal(after[t.files.agents], before[t.files.agents]);
    assert.equal(t.read('mcp-profiles'), EXPECTED_PROFILES);
    assert.equal(t.read('mcp-registry'), EXPECTED_REGISTRY);
    assert.equal(t.read('agents-md'), EXPECTED_AGENTS_MD);
    for (const kind of ['mcp-registry', 'mcp-profiles', 'agents-md']) assert.equal(after[t.files[kind]], sha256(t.files[kind]), kind);

    const again = await t.render('codex');
    assert.ok(readFileSync(t.files.agents).equals(edited));
    assert.equal(again.warnings, `${t.kept(t.files.agents)}\n`);
    assert.equal(t.recorded()[t.files.agents], before[t.files.agents]);
  } finally { t.cleanup(); }
});

test('the unedited first-stage files are replaced using the backends of the existing installation', async () => {
  const t = configSetup();
  try {
    t.placeStage1('claude,codex');
    const result = await t.render('codex');
    assert.equal(result.warnings, '');
    assert.deepEqual(ids(t.read('agents')), ['seosoyoung', 'seosoyoung-pas', 'codex-default']);
    assert.equal(t.read('mcp-registry'), EXPECTED_REGISTRY);
    assert.equal(t.read('mcp-profiles'), EXPECTED_PROFILES);
    assert.equal(t.read('agents-md'), EXPECTED_AGENTS_MD);
    assert.ok(lstatSync(join(t.home, 'workspace', 'CLAUDE.md')).isSymbolicLink());
    assert.equal(readlinkSync(join(t.home, 'workspace', 'CLAUDE.md')), 'AGENTS.md');
    t.verifyRecord();
  } finally { t.cleanup(); }
});

test('first-stage files are recognized after the current catalog defaults change', async () => {
  const t = configSetup();
  try {
    t.placeStage1('claude,codex');
    const catalog = join(t.root, 'packages/model-catalog/data/model-catalog.yaml');
    const raw = readFileSync(catalog, 'utf8');
    const defaults = { backends: { claude: 'new-claude', codex: 'new-codex', antigravity: 'new-antigravity' }, profiles: { 'card-orchestrator': 'new-orchestrator' } };
    writeFileSync(catalog, raw.replace(/^install_defaults: .*$/m, `install_defaults: ${JSON.stringify(defaults)}`));
    const result = await t.render('claude,codex');
    assert.equal(result.warnings, '');
    assert.ok(t.read('agents').includes('default_preset: new-claude'));
    assert.ok(t.read('agents').includes('default_preset: new-codex'));
    assert.ok(!existsSync(`${t.files.agents}.installer-new`));
    t.verifyRecord();
  } finally { t.cleanup(); }
});

test('a missing first-stage preset record stops configuration instead of treating it as an edit', async () => {
  const t = configSetup();
  try {
    t.placeStage1('claude,codex');
    const original = readFileSync(t.files.agents);
    unlinkSync(join(t.root, 'install/stage1-managed-presets.json'));
    await t.render('claude,codex', '', true);
    assert.ok(readFileSync(t.files.agents).equals(original));
    assert.ok(!existsSync(`${t.files.agents}.installer-new`));
  } finally { t.cleanup(); }
});

test('an edited first-stage AGENTS.md is kept while the other three are replaced', async () => {
  const t = configSetup();
  try {
    t.placeStage1('claude,codex');
    appendFileSync(t.files['agents-md'], 'Always answer in Korean.\n');
    const edited = readFileSync(t.files['agents-md']);
    const result = await t.render('claude,codex');
    assert.ok(readFileSync(t.files['agents-md']).equals(edited));
    assert.equal(readFileSync(`${t.files['agents-md']}.installer-new`, 'utf8'), EXPECTED_AGENTS_MD);
    assert.equal(result.warnings, `${t.kept(t.files['agents-md'])}\n`);
    assert.deepEqual(ids(t.read('agents')), ['seosoyoung', 'seosoyoung-pas', 'card-orchestrator', 'claude-default', 'codex-default']);
    assert.equal(t.read('mcp-registry'), EXPECTED_REGISTRY);
    assert.equal(t.read('mcp-profiles'), EXPECTED_PROFILES);
    assert.deepEqual(Object.keys(t.recorded()), [t.files.agents, t.files['mcp-registry'], t.files['mcp-profiles']]);
  } finally { t.cleanup(); }
});

test('files that already match the current output are left as they are and get a record', async () => {
  const t = configSetup();
  try {
    await t.render('claude,codex');
    unlinkSync(t.record);
    const before = Object.values(t.files).map((file) => [readFileSync(file), statSync(file).mtimeMs]);
    const result = await t.render('claude,codex');
    assert.equal(result.warnings, '');
    Object.values(t.files).forEach((file, i) => {
      assert.ok(readFileSync(file).equals(before[i][0]), file);
      assert.equal(statSync(file).mtimeMs, before[i][1], file);
      assert.ok(!existsSync(`${file}.installer-new`), file);
    });
    assert.deepEqual(Object.keys(t.recorded()), Object.values(t.files));
    t.verifyRecord();
  } finally { t.cleanup(); }
});

test('a regular CLAUDE.md file is kept', async () => {
  const t = configSetup();
  try {
    await t.render('claude,codex');
    const claude = join(t.home, 'workspace', 'CLAUDE.md');
    unlinkSync(claude);
    writeFileSync(claude, 'my Claude notes\n');
    const result = await t.render('claude,codex');
    assert.ok(!lstatSync(claude).isSymbolicLink());
    assert.equal(readFileSync(claude, 'utf8'), 'my Claude notes\n');
    assert.equal(result.warnings, `Kept your ${claude}.\n`);
  } finally { t.cleanup(); }
});

test('edited mcp-registry.yaml and mcp-profiles.yaml and a CLAUDE.md link to another file survive a rerun', async () => {
  const t = configSetup();
  try {
    await t.render('claude,codex');
    appendFileSync(t.files['mcp-registry'], '# my own server\n');
    appendFileSync(t.files['mcp-profiles'], '# my own profile\n');
    const claude = join(t.home, 'workspace', 'CLAUDE.md');
    unlinkSync(claude);
    symlinkSync('my-notes.md', claude);
    const edited = { registry: readFileSync(t.files['mcp-registry']), profiles: readFileSync(t.files['mcp-profiles']) };
    const before = t.recorded();
    const result = await t.render('claude,codex');
    assert.ok(readFileSync(t.files['mcp-registry']).equals(edited.registry));
    assert.ok(readFileSync(t.files['mcp-profiles']).equals(edited.profiles));
    assert.equal(readFileSync(`${t.files['mcp-registry']}.installer-new`, 'utf8'), EXPECTED_REGISTRY);
    assert.equal(readFileSync(`${t.files['mcp-profiles']}.installer-new`, 'utf8'), EXPECTED_PROFILES);
    assert.equal(readlinkSync(claude), 'my-notes.md');
    assert.equal(result.warnings, `${t.kept(t.files['mcp-registry'])}\n${t.kept(t.files['mcp-profiles'])}\nKept your ${claude}.\n`);
    const after = t.recorded();
    for (const kind of ['mcp-registry', 'mcp-profiles']) assert.equal(after[t.files[kind]], before[t.files[kind]], kind);
  } finally { t.cleanup(); }
});

test('the first-stage output function matches the files the first-stage installer wrote', () => {
  for (const backends of ['claude,codex', 'codex', 'claude,codex,antigravity']) {
    for (const [kind, name] of Object.entries(KINDS)) {
      const output = execFileSync('bash', ['-c', 'source "$1"; stage1_managed_output "$2" /home/soulstream "$3" "$4"', 'bash', script, kind, backends, stage1Presets]);
      assert.ok(output.equals(readFileSync(join(fixtures, backends.replaceAll(',', '-'), name))), `${backends} ${kind}`);
    }
  }
});

// The schema step and the database dumps with fake release results, a fake pg_dump and a fake pg_restore.
// schema-bin comes before support/fake_commands.mjs on PATH, so no PostgreSQL client or executor really runs.
const realDate = execFileSync('bash', ['-c', 'command -v date'], { encoding: 'utf8' }).trim();
const SCHEMA_FAKES = {
  // Answers the three executor phases and migrate.mjs verify; release.log records each phase's identity.
  node: `printf '%s\\n' "== node" "$@" >> "$FAKE_ARGV_LOG"
case "$1" in
  packages/db-schema/scripts/release-executor.mjs)
    printf '%s %s\\n' "$2" "head=$HANIEL_TARGET_HEAD previous=$HANIEL_PREVIOUS_HEAD release=$HANIEL_RELEASE_ID soulstream_release=$SOULSTREAM_RELEASE_ID request=$HANIEL_REQUEST_ID repo=$HANIEL_DEPLOY_REPO backup=$HANIEL_BACKUP_DIR env=$HANIEL_SERVICE_ENV_FILE journal=\${HANIEL_DEPLOYMENT_JOURNAL-unset} $3 $4 $5 $6 cwd=$PWD" >> "$FAKE_DIR/release.log"
    if [[ "$2" == "\${FAKE_RELEASE_FAIL:-}" ]]; then printf '{"ok":false,"phase":"%s","error":{"code":"APPLY_FAILED","message":"fake failure"}}\\n' "$2" >&2; exit 1; fi
    if [[ "$2" == preflight ]]; then printf '[dotenv] injecting env\\n%s\\n' "$FAKE_PREFLIGHT"; else printf '{"ok":true,"phase":"%s","status":"verified"}\\n' "$2"; fi ;;
  packages/db-schema/scripts/migrate.mjs) printf 'migrate-%s\\n' "$2" >> "$FAKE_DIR/release.log"; printf '{"status":"ok"}\\n' ;;
  *) exit 99 ;;
esac`,
  pg_dump: `printf '%s\\n' "== pg_dump" "$@" >> "$FAKE_ARGV_LOG"
if [[ "\${FAKE_PG_DUMP_FAIL:-0}" == 1 ]]; then printf 'pg_dump: error: connection failed\\n' >&2; exit 1; fi
printf 'PGDMP %s\\n' "\${!#}"`,
  pg_restore: `printf '%s\\n' "== pg_restore" "$@" >> "$FAKE_ARGV_LOG"
[[ "$1" == --list && "$(head -c 5 "$2")" == PGDMP ]]`,
  // The dump stamp counts up, so names differ without waiting a second; other formats are the real date.
  date: `if [[ "$*" == '-u +%Y%m%dT%H%M%SZ' ]]; then
  n=$(( $(cat "$FAKE_DIR/date-count" 2>/dev/null || printf 0) + 1 )); printf '%s' "$n" > "$FAKE_DIR/date-count"
  printf '20261124T0000%02dZ\\n' "$n"
else exec ${realDate} "$@"; fi`,
  // The atom emptiness query arrives on stdin and is answered with FAKE_ATOM_POPULATED.
  psql: `printf '%s\\n' "== psql" "$@" >> "$FAKE_ARGV_LOG"
if [[ " $* " == *to_regclass* ]]; then printf 't\\n'; exit 0; fi
input=$(cat)
if [[ "$input" == *"to_regclass('public.cards')"* ]]; then printf '%s\\n' "\${FAKE_ATOM_POPULATED:-f}"; fi`,
};
const SCHEMA_PRELUDE = `set -Eeuo pipefail
source "$INSTALL_SH"
as_soul() { "$@"; }
LOG=$FAKE_DIR/install.log
: >> "$LOG"
exec 3>>"$FAKE_DIR/fd3.log"
parse_args
INSTALL_ROOT=$ROOT
REPO_PATH[soulstream]=$ROOT; REPO_PREVIOUS[soulstream]=\${PREVIOUS-}; REPO_TARGET[soulstream]=$TARGET
REPO_PREVIOUS[atom]=\${PREVIOUS-}; REPO_TARGET[atom]=$TARGET
`;
const PREVIOUS = '1234567890abcdef1234567890abcdef12345678';

function schemaSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'install-schema-'));
  const root = join(dir, 'soulstream'), atomRoot = join(dir, 'atom'), bin = join(dir, 'schema-bin');
  mkdirSync(root); mkdirSync(atomRoot); mkdirSync(bin);
  git('init', '-q', '--initial-branch=main', root);
  git('-C', root, 'commit', '-q', '--allow-empty', '-m', 'target');
  const head = git('-C', root, 'rev-parse', 'HEAD');
  const fake = createFakeCommands(dir);
  for (const [name, body] of Object.entries(SCHEMA_FAKES)) writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  const run = async (body, extra = {}) => {
    const result = await runBash(SCHEMA_PRELUDE + body, [], {
      env: fake.env({ ...GIT_ENV, INSTALL_SH: script, ROOT: root, ATOM_ROOT: atomRoot, TARGET: head, PREVIOUS, PATH: `${bin}:${fake.bin}:${process.env.PATH}`, ...extra }),
    });
    fake.assertNoProtectedRequests();
    return result;
  };
  const backups = join(root, '.local', 'backups');
  const dumps = (db = 'soulstream') => (existsSync(backups) ? readdirSync(backups).filter((name) => name.startsWith(`${db}-`)).sort() : []);
  const releaseLog = () => (existsSync(join(dir, 'release.log')) ? readFileSync(join(dir, 'release.log'), 'utf8') : '');
  const fd3 = () => (existsSync(join(dir, 'fd3.log')) ? readFileSync(join(dir, 'fd3.log'), 'utf8') : '');
  const state = () => JSON.parse(readFileSync(join(root, '.local', 'install-state.json'), 'utf8'));
  return { dir, root, head, fake, run, backups, dumps, releaseLog, fd3, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const preflightResult = (operation, status, pending, additive) => JSON.stringify({ ok: true, phase: 'preflight', operation, status, pending_count: pending, pending_additive_only: additive });
const dumpName = (db, n, head, previous = PREVIOUS.slice(0, 12)) => `${db}-20261124T0000${String(n).padStart(2, '0')}Z-${previous}-to-${head.slice(0, 12)}.pgdump`;
const restoreLine = (path) => `sudo -u postgres pg_restore --exit-on-error --no-owner --role=soulstream -d <empty_database> < '${path}'`;

test('the schema step dumps soulstream only before an uncommitted non-additive upgrade, then applies and verifies', async () => {
  const rows = [
    ['upgrade', 'preflight_complete', 2, false, true],
    ['upgrade', 'apply_started', 2, false, true],
    ['upgrade', 'apply_failed', 2, false, true],
    ['upgrade', 'verified', 2, false, false],
    ['upgrade', 'applied_reconciled', 2, false, false],
    ['upgrade', 'preflight_complete', 2, true, false],
    ['upgrade', 'preflight_complete', 0, false, false],
    ['fresh_install', 'preflight_complete', 173, false, false],
  ];
  for (const [operation, status, pending, additive, dumped] of rows) {
    const t = schemaSetup();
    const label = `${operation} ${status} ${pending} additive=${additive}`;
    try {
      const result = await t.run('setup_schema "$ROOT"\n', { FAKE_PREFLIGHT: preflightResult(operation, status, pending, additive) });
      assert.equal(result.status, 0, `${label}\n${result.stderr}`);
      assert.deepEqual(t.dumps(), dumped ? [dumpName('soulstream', 1, t.head)] : [], label);
      const release = `clean-${t.head.slice(0, 12)}`;
      const identity = `head=${t.head} previous=${t.head} release=${release} soulstream_release=${release} request=installer-${t.head} repo=soulstream`
        + ` backup=${t.root}/.local/database-release/${release} env=${t.root}/.env.orch journal=unset`
        + ` --manifest install/release-manifest-installer.json --database-contract install/database-release-installer.json cwd=${t.root}`;
      assert.equal(t.releaseLog(), ['preflight', 'apply', 'verify'].map((phase) => `${phase} ${identity}\n`).join('') + 'migrate-verify\n', label);
      const argv = t.fake.argv();
      if (dumped) assert.ok(argv.indexOf('== pg_dump\n') < argv.indexOf('== node\npackages/db-schema/scripts/release-executor.mjs\napply\n'), label);
      else assert.ok(!argv.includes('== pg_dump\n'), label);
    } finally { t.cleanup(); }
  }
});

test('a failed dump stops the schema step before apply, and a failed phase reports its error code', async () => {
  const t = schemaSetup();
  try {
    const nonAdditive = preflightResult('upgrade', 'preflight_complete', 2, false);
    const dump = await t.run('setup_schema "$ROOT"\n', { FAKE_PREFLIGHT: nonAdditive, FAKE_PG_DUMP_FAIL: '1' });
    assert.notEqual(dump.status, 0);
    assert.equal(t.releaseLog().split('\n')[0].split(' ')[0], 'preflight');
    assert.ok(!t.releaseLog().includes('\napply '), t.releaseLog());
    assert.deepEqual(readdirSync(t.backups), []);
    assert.match(dump.stderr, /Backup of database soulstream failed\./);

    const apply = await t.run('setup_schema "$ROOT"\n', { FAKE_PREFLIGHT: nonAdditive, FAKE_RELEASE_FAIL: 'apply' });
    assert.notEqual(apply.status, 0);
    assert.match(apply.stderr, /\nDatabase release apply failed: APPLY_FAILED\n/);
    assert.ok(!t.releaseLog().includes('\nverify '), t.releaseLog());
    assert.deepEqual(t.dumps(), [dumpName('soulstream', 1, t.head)]);

    const preflight = await t.run('setup_schema "$ROOT"\n', { FAKE_PREFLIGHT: '{"ok":true,"operation":"upgrade"}' });
    assert.notEqual(preflight.status, 0);
    assert.match(preflight.stderr, /Database release preflight returned an unexpected result\./);
  } finally { t.cleanup(); }
});

test('backups keep the newest three per database, and a failed dump leaves the existing ones', async () => {
  const t = schemaSetup();
  try {
    const three = await t.run('for i in 1 2 3; do backup_database "$ROOT" soulstream; done\nbackup_database "$ROOT" atom\n');
    assert.equal(three.status, 0, three.stderr);
    const first = [1, 2, 3].map((n) => dumpName('soulstream', n, t.head));
    assert.deepEqual(t.dumps(), first);
    assert.equal(statSync(t.backups).mode & 0o777, 0o700);
    for (const name of readdirSync(t.backups)) assert.equal(statSync(join(t.backups, name)).mode & 0o777, 0o600, name);
    assert.match(t.fake.argv(), /== pg_dump\n--format=custom\n--no-password\n-d\nsoulstream\n/);
    assert.ok(t.fake.argv().includes(`== chown\nsoulstream:soulstream\n${t.backups}\n`));

    const failed = await t.run('backup_database "$ROOT" soulstream\n', { FAKE_PG_DUMP_FAIL: '1' });
    assert.notEqual(failed.status, 0);
    assert.deepEqual(readdirSync(t.backups).sort(), [dumpName('atom', 4, t.head), ...first]);

    const fourth = await t.run('backup_database "$ROOT" soulstream\nprintf "path=%s\\n" "${BACKUP_PATHS[soulstream]}"\n', { PREVIOUS: '' });
    assert.equal(fourth.status, 0, fourth.stderr);
    const latest = dumpName('soulstream', 5, t.head, 'none');
    assert.deepEqual(t.dumps(), [...first.slice(1), latest]);
    assert.deepEqual(t.dumps('atom'), [dumpName('atom', 4, t.head)]);
    assert.ok(fourth.stdout.includes(`path=${join(t.backups, latest)}\n`), fourth.stdout);
  } finally { t.cleanup(); }
});

test('a failure after a dump reports its path and restore command; without a dump there is no such line', async () => {
  const body = `MAINTENANCE_ENTERED=true; SYSTEMD_DIR=$FAKE_DIR/units; STEP='Initializing schema'
trap on_error ERR
if [[ "$WITH_BACKUP" == 1 ]]; then backup_database "$ROOT" soulstream; fi
false
`;
  const t = schemaSetup();
  try {
    const result = await t.run(body, { WITH_BACKUP: '1' });
    assert.equal(result.status, 1);
    const path = join(t.backups, dumpName('soulstream', 1, t.head));
    assert.ok(t.fd3().endsWith(`State: ${t.root}/.local/install-state.json
Database backup (soulstream): ${path}
Restore it only to give up the new revision: with the services stopped and a compatible revision checked out, as root restore into an empty database: ${restoreLine(path)}
Fix the cause, then run the same command again.
`), t.fd3());
    assert.deepEqual(t.state().backups, { soulstream: { path, restore_command: restoreLine(path) } });
    assert.equal(t.state().status, 'failed');
  } finally { t.cleanup(); }
  const none = schemaSetup();
  try {
    const result = await none.run(body, { WITH_BACKUP: '0' });
    assert.equal(result.status, 1);
    assert.ok(!none.fd3().includes('Database backup'), none.fd3());
    assert.ok(none.fd3().endsWith(`State: ${none.root}/.local/install-state.json\nFix the cause, then run the same command again.\n`), none.fd3());
    assert.deepEqual(none.state().backups, {});
  } finally { none.cleanup(); }
});

test('a non-empty atom database is dumped right before migrate, and an empty one is not', async () => {
  for (const populated of ['t', 'f']) {
    const t = schemaSetup();
    try {
      const result = await t.run('setup_secrets "$ROOT" "$ATOM_ROOT"\ninit_atom "$ATOM_ROOT"\n', { FAKE_ATOM_POPULATED: populated });
      assert.equal(result.status, 0, result.stderr);
      const argv = t.fake.argv(), migrate = argv.indexOf('== npm\n--prefix\n');
      assert.ok(migrate >= 0, argv);
      if (populated === 't') {
        assert.deepEqual(t.dumps('atom'), [dumpName('atom', 1, t.head)]);
        assert.ok(argv.lastIndexOf('== pg_dump\n--format=custom\n--no-password\n-d\natom\n', migrate) >= 0, argv);
      } else {
        assert.ok(!argv.includes('== pg_dump\n'), argv);
        assert.deepEqual(t.dumps('atom'), []);
      }
    } finally { t.cleanup(); }
  }
});

// A retry of a failed update keeps that update's first atom dump (card 1815): the dump taken before the first
// migrate is the only copy of the old atom schema, and later runs would otherwise dump the migrated database.
// One run as install.sh runs it: read the previous state, then init_atom, then fail after atom was initialized.
const RERUN = (status) => `setup_secrets "$ROOT" "$ATOM_ROOT"
protect_atom_backup "$ROOT"
MAINTENANCE_ENTERED=true; STEP='Initializing atom'
init_atom "$ATOM_ROOT"
printf 'atom=%s\\n' "\${BACKUP_PATHS[atom]-}"
write_install_state "$ROOT" ${status} 'Building Soulstream'
`;
const atomPath = (result) => /^atom=(.*)$/m.exec(result.stdout)[1];
// The first attempt of an update: the services were stopped, atom was dumped, then a later step failed.
async function firstAttempt(t, status = 'failed') {
  const result = await t.run(`setup_secrets "$ROOT" "$ATOM_ROOT"
MAINTENANCE_ENTERED=true; STEP='Initializing atom'
init_atom "$ATOM_ROOT"
printf 'atom=%s\\n' "\${BACKUP_PATHS[atom]-}"
write_install_state "$ROOT" ${status} 'Building Soulstream'
`, { FAKE_ATOM_POPULATED: 't' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(t.dumps('atom'), [dumpName('atom', 1, t.head)]);
  return atomPath(result);
}

test('retrying a failed update keeps its first atom dump and takes no new one', async () => {
  const t = schemaSetup();
  try {
    const first = await firstAttempt(t);
    assert.equal(t.state().backups.atom.path, first);
    for (let i = 0; i < 3; i++) {
      const retry = await t.run(RERUN('failed'), { FAKE_ATOM_POPULATED: 't', PREVIOUS: t.head });
      assert.equal(retry.status, 0, retry.stderr);
      assert.deepEqual(t.dumps('atom'), [dumpName('atom', 1, t.head)]);
      assert.equal(atomPath(retry), first);
      assert.deepEqual(t.state().backups.atom, { path: first, restore_command: restoreLine(first) });
      assert.ok(retry.stdout.includes(`Keeping the first atom backup of this update: ${first}`), retry.stdout);
    }
    assert.equal((t.fake.argv().match(/== pg_dump\n/g) ?? []).length, 1);
  } finally { t.cleanup(); }
});

test('a run after a completed update dumps atom again', async () => {
  const t = schemaSetup();
  try {
    const first = await firstAttempt(t, 'completed');
    const next = await t.run(RERUN('completed'), { FAKE_ATOM_POPULATED: 't', PREVIOUS: t.head });
    assert.equal(next.status, 0, next.stderr);
    assert.deepEqual(t.dumps('atom'), [dumpName('atom', 1, t.head), dumpName('atom', 2, t.head, t.head.slice(0, 12))]);
    assert.notEqual(atomPath(next), first);
  } finally { t.cleanup(); }
});

test('a run after the protected dump was deleted dumps atom again', async () => {
  const t = schemaSetup();
  try {
    const first = await firstAttempt(t);
    rmSync(first);
    const next = await t.run(RERUN('failed'), { FAKE_ATOM_POPULATED: 't', PREVIOUS: t.head });
    assert.equal(next.status, 0, next.stderr);
    assert.deepEqual(t.dumps('atom'), [dumpName('atom', 2, t.head, t.head.slice(0, 12))]);
    assert.equal(atomPath(next), join(t.backups, dumpName('atom', 2, t.head, t.head.slice(0, 12))));
    assert.ok(!next.stdout.includes('Keeping the first atom backup'), next.stdout);
  } finally { t.cleanup(); }
});

test('the protected atom dump reaches the state file and the failure notice even when a step before atom fails', async () => {
  const t = setup();
  try {
    installed(t);
    const dump = join(t.root, '.local', 'backups', 'atom-20261124T000001Z-aaaaaaaaaaaa-to-bbbbbbbbbbbb.pgdump');
    mkdirSync(dirname(dump), { recursive: true });
    writeFileSync(dump, 'PGDMP\n');
    writeFileSync(t.statePath, JSON.stringify({ status: 'failed', step: 'Building Soulstream', backups: { atom: { path: dump, restore_command: 'x' } } }));
    const result = await t.run(`parse_args
INSTALL_ROOT=$ROOT; STEP='Stopping services'
check_repositories "$ROOT" "$ATOM_ROOT"
stop_services "$ROOT"
printf 'atom=%s\\n' "\${BACKUP_PATHS[atom]-}"
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(atomPath(result), dump);
    assert.equal(t.state().status, 'updating');
    assert.equal(t.state().backups.atom.path, dump);
  } finally { t.cleanup(); }
});
