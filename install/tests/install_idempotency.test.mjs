import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const script = resolve('install/install.sh');
const env = (p) => Object.fromEntries(readFileSync(p, 'utf8').trim().split('\n').filter(x => /^[A-Z_]+=/.test(x)).map(x => { const i=x.indexOf('='); return [x.slice(0,i), x.slice(i+1).replace(/^"|"$/g,'')]; }));
function render(home, root, backends) { return spawnSync('bash', ['-c', 'source "$1"; BACKENDS="$4"; render_config "$2" "$3"', 'bash', script, home, root, backends], {encoding:'utf8'}); }
test('configuration rendering preserves secrets and unmanaged lines across backend changes', () => {
 const dir=mkdtempSync(join(tmpdir(),'install-render-')), home=join(dir,'home'), root=join(home,'soulstream');
 try {
  let run=render(home,root,'claude,codex,antigravity'); assert.equal(run.status,0,run.stderr);
  const orchPath=join(root,'.env.orch'), workerPath=join(root,'.env.soul-server-ts'), passwordPath=join(root,'.admin-password');
  for (const p of [orchPath,workerPath,passwordPath]) assert.equal(statSync(p).mode & 0o777,0o600);
  for (const p of ['agents.yaml','mcp-registry.yaml','mcp-profiles.yaml']) assert.ok(statSync(join(root,'config',p)).isFile());
  assert.ok(statSync(join(home,'workspace','AGENTS.md')).isFile()); assert.ok(lstatSync(join(home,'workspace','CLAUDE.md')).isSymbolicLink());
  const initial=env(orchPath), keys=['AUTH_BEARER_TOKEN','JWT_SECRET','DASHBOARD_ADMIN_PASSWORD','DATABASE_URL'];
  for (const k of keys) assert.ok(initial[k]);
  assert.match(initial.AUTH_BEARER_TOKEN,/^[0-9a-f]{64}$/); assert.match(initial.JWT_SECRET,/^[0-9a-f]{64}$/);
  assert.equal(readFileSync(passwordPath,'utf8').trim(),initial.DASHBOARD_ADMIN_PASSWORD);
  appendFileSync(orchPath,'GOOGLE_CLIENT_ID=x\n');
  for (const backends of ['claude,codex,antigravity','codex','claude','antigravity','claude,codex,antigravity']) {
    run=render(home,root,backends); assert.equal(run.status,0,run.stderr);
    const orch=env(orchPath), worker=env(workerPath), agents=readFileSync(join(root,'config','agents.yaml'),'utf8');
    for (const k of keys) { assert.equal(orch[k],initial[k]); assert.ok(!(run.stdout+run.stderr).includes(initial[k])); }
    assert.equal(orch.GOOGLE_CLIENT_ID,'x'); assert.equal(readFileSync(passwordPath,'utf8').trim(),orch.DASHBOARD_ADMIN_PASSWORD);
    for (const k of keys) assert.equal(readFileSync(orchPath,'utf8').split('\n').filter(x=>x.startsWith(k+'=')).length,1);
    const selected=backends.split(','); assert.equal(orch.DEFAULT_PAS_AGENT_ID,selected[0]+'-default'); assert.equal(worker.SOULSTREAM_BACKENDS,backends);
    assert.equal(Boolean(worker.CLAUDE_AUTH_TOKEN_PATH),selected.includes('claude')); assert.equal(worker.CODEX_ADAPTER_MODE,selected.includes('codex')?'app-server':undefined);
    assert.equal(worker.CLAUDE_CODE_EXECPATH,undefined); assert.equal(worker.CODEX_CLI_PATH,undefined);
    for (const name of ['claude','codex','antigravity']) assert.equal(agents.includes(`id: ${name}-default`),selected.includes(name));
  }
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('database password prepared before rendering is retained', () => {
 const dir=mkdtempSync(join(tmpdir(),'install-db-password-')), home=join(dir,'home'), root=join(home,'soulstream');
 try {
  const run=spawnSync('bash',['-c','source "$1"; BACKENDS=codex; prepare_secrets "$3"; previous=$DB_PASSWORD; render_config "$2" "$3" "$previous"; [[ "$previous" == "$DB_PASSWORD" ]]','bash',script,home,root],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('clone reruns ignore untracked installer files and protect tracked changes', () => {
 const dir=mkdtempSync(join(tmpdir(),'install-clone-')), origin=join(dir,'origin.git'), source=join(dir,'source'), root=join(dir,'clone');
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const run=(ref,refSet)=>spawnSync('bash',['-ec','source "$1"; as_soul() { "$@"; }; REF="$3"; REF_SET="$4"; clone_repository "$2"','bash',script,root,ref,refSet],{encoding:'utf8'});
 try {
  git('init','--bare','--initial-branch=main',origin);
  git('init','--initial-branch=main',source);
  writeFileSync(join(source,'tracked.txt'),'A\n');
  git('-C',source,'add','tracked.txt');
  git('-C',source,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','A');
  const a=git('-C',source,'rev-parse','HEAD');
  writeFileSync(join(source,'tracked.txt'),'B\n');
  git('-C',source,'add','tracked.txt');
  git('-C',source,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','B');
  const b=git('-C',source,'rev-parse','HEAD');
  git('-C',source,'remote','add','origin',origin);
  git('-C',source,'push','origin','main');
  git('clone',origin,root);
  git('-C',root,'checkout',a);
  const files=['.admin-password','.env.orch','.env.soul-server-ts','.haniel/x','config/agents.yaml'];
  for (const file of files) {
   const path=join(root,file);
   if (file.includes('/')) mkdirSync(join(root,file.split('/')[0]),{recursive:true});
   writeFileSync(path,`preserve ${file}\n`);
  }
  const clean=run(b,'true');
  assert.equal(clean.status,0,clean.stderr);
  assert.equal(git('-C',root,'rev-parse','HEAD'),b);
  for (const file of files) assert.equal(readFileSync(join(root,file),'utf8'),`preserve ${file}\n`);
  writeFileSync(join(root,'tracked.txt'),'modified\n');
  const dirty=run(b,'true');
  assert.notEqual(dirty.status,0);
  assert.match(dirty.stderr,/Repository has uncommitted changes\./);
  assert.equal(git('-C',root,'rev-parse','HEAD'),b);
  const noRef=run(a,'false');
  assert.equal(noRef.status,0,noRef.stderr);
  assert.equal(git('-C',root,'rev-parse','HEAD'),b);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
