import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFakeCommands } from './support/fake_commands.mjs';
import { copyCatalog } from './support/catalog.mjs';
const script = resolve('install/install.sh');
const ATOM_KEY = 'test-atom-api-key';
// Files the earlier installation steps leave for render_config: the seed map and the atom API key.
function prepareRoot(dir, root) {
 copyCatalog(root);
 mkdirSync(join(root,'config'),{recursive:true});
 writeFileSync(join(root,'config','.atom-seed-map.json'),JSON.stringify({skill_catalog:'11111111-2222-4333-8444-555555555555',domain_catalog:null}));
 writeFileSync(join(root,'.atom-api-key'),`${ATOM_KEY}\n`);
 return createFakeCommands(dir);
}
const env = (p) => Object.fromEntries(readFileSync(p, 'utf8').trim().split('\n').filter(x => /^[A-Z_]+=/.test(x)).map(x => { const i=x.indexOf('='); return [x.slice(0,i), x.slice(i+1).replace(/^"|"$/g,'')]; }));
function render(home, root, backends, fake) { return spawnSync('bash', ['-c', 'set -Eeuo pipefail; source "$1"; BACKENDS="$4"; setup_secrets "$3" "$2/atom"; render_config "$2" "$3"', 'bash', script, home, root, backends], {encoding:'utf8', env:fake.env()}); }
test('configuration rendering preserves secrets and unmanaged lines across backend changes', () => {
 const dir=mkdtempSync(join(tmpdir(),'install-render-')), home=join(dir,'home'), root=join(home,'soulstream');
 try {
  const fake=prepareRoot(dir,root);
  let run=render(home,root,'claude,codex,antigravity',fake); assert.equal(run.status,0,run.stderr);
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
    run=render(home,root,backends,fake); assert.equal(run.status,0,run.stderr);
    const orch=env(orchPath), worker=env(workerPath), agents=readFileSync(join(root,'config','agents.yaml'),'utf8');
    for (const k of keys) { assert.equal(orch[k],initial[k]); assert.ok(!(run.stdout+run.stderr).includes(initial[k])); }
    assert.equal(orch.GOOGLE_CLIENT_ID,'x'); assert.equal(readFileSync(passwordPath,'utf8').trim(),orch.DASHBOARD_ADMIN_PASSWORD);
    for (const k of keys) assert.equal(readFileSync(orchPath,'utf8').split('\n').filter(x=>x.startsWith(k+'=')).length,1);
    const selected=backends.split(','); assert.equal(orch.DEFAULT_PAS_AGENT_ID,'seosoyoung-pas'); assert.equal(worker.SOULSTREAM_BACKENDS,backends);
    assert.equal(Boolean(worker.CLAUDE_AUTH_TOKEN_PATH),selected.includes('claude')); assert.equal(worker.CODEX_ADAPTER_MODE,selected.includes('codex')?'app-server':undefined);
    assert.equal(worker.CLAUDE_CODE_EXECPATH,undefined); assert.equal(worker.CODEX_CLI_PATH,undefined);
    assert.deepEqual([...agents.matchAll(/^  - id: (.+)$/gm)].map(m=>m[1]),['seosoyoung','seosoyoung-pas',...(selected.includes('claude')?['card-orchestrator']:[]),...selected.map(name=>`${name}-default`)]);
  }
  const files=[orchPath,workerPath,passwordPath,...['agents.yaml','mcp-registry.yaml','mcp-profiles.yaml'].map(p=>join(root,'config',p)),join(home,'workspace','AGENTS.md')];
  const before=files.map(p=>readFileSync(p));
  run=render(home,root,'claude,codex,antigravity',fake); assert.equal(run.status,0,run.stderr);
  files.forEach((p,i)=>assert.ok(readFileSync(p).equals(before[i]),p));
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('the worker gets the orchestrator JWT secret and keeps it across renders', () => {
 const dir=mkdtempSync(join(tmpdir(),'install-worker-jwt-')), home=join(dir,'home'), root=join(home,'soulstream');
 try {
  const fake=prepareRoot(dir,root);
  let run=render(home,root,'claude,codex',fake); assert.equal(run.status,0,run.stderr);
  const secret=env(join(root,'.env.orch')).JWT_SECRET;
  assert.match(secret,/^[0-9a-f]{64}$/);
  assert.equal(env(join(root,'.env.soul-server-ts')).JWT_SECRET,secret);
  run=render(home,root,'codex',fake); assert.equal(run.status,0,run.stderr);
  assert.equal(env(join(root,'.env.orch')).JWT_SECRET,secret);
  assert.equal(env(join(root,'.env.soul-server-ts')).JWT_SECRET,secret);
  assert.equal(readFileSync(join(root,'.env.soul-server-ts'),'utf8').split('\n').filter(x=>x.startsWith('JWT_SECRET=')).length,1);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('database password prepared before rendering is retained', () => {
 const dir=mkdtempSync(join(tmpdir(),'install-db-password-')), home=join(dir,'home'), root=join(home,'soulstream');
 try {
  const fake=prepareRoot(dir,root);
  const run=spawnSync('bash',['-ec','source "$1"; BACKENDS=codex; setup_secrets "$3" "$2/atom"; previous=$DB_PASSWORD; render_config "$2" "$3"; grep -qx "DATABASE_URL=postgresql://soulstream:${previous}@127.0.0.1:5432/soulstream" "$3/.env.orch"','bash',script,home,root],{encoding:'utf8',env:fake.env()});
  assert.equal(run.status,0,run.stderr);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('repository reruns ignore untracked installer files, protect tracked changes and follow origin main', () => {
 const dir=mkdtempSync(join(tmpdir(),'install-clone-')), origin=join(dir,'origin.git'), source=join(dir,'source'), root=join(dir,'clone');
 // The remote is a local bare repository and git ignores the host configuration.
 const gitEnv={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:gitEnv}).trim();
 const run=(ref,refSet)=>spawnSync('bash',['-ec','source "$1"; as_soul() { "$@"; }; check_repository soulstream "$2" https://example.invalid/unused.git "$3" "$4"; checkout_repository soulstream','bash',script,root,ref,refSet],{encoding:'utf8',env:gitEnv});
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
  git('-C',root,'checkout','--','tracked.txt');
  writeFileSync(join(source,'tracked.txt'),'C\n');
  git('-C',source,'add','tracked.txt');
  git('-C',source,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','C');
  const c=git('-C',source,'rev-parse','HEAD');
  git('-C',source,'push','origin','main');
  const noRef=run('','false');
  assert.equal(noRef.status,0,noRef.stderr);
  assert.equal(git('-C',root,'rev-parse','HEAD'),c);
  assert.equal(git('-C',root,'rev-parse','--abbrev-ref','HEAD'),'main');
  for (const file of files) assert.equal(readFileSync(join(root,file),'utf8'),`preserve ${file}\n`);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('Tailscale identity selection handles personal and tagged devices', () => {
 const personal = JSON.stringify({Self:{DNSName:'node.tailnet.ts.net.',UserID:123,Tags:[]},User:{'123':{LoginName:'Owner@Example.com'}}});
 const tagged = JSON.stringify({Self:{DNSName:'node.tailnet.ts.net.',UserID:42,Tags:['tag:server']},User:{'42':{LoginName:'tagged-devices'}}});
 const select=(status,user='')=>spawnSync('bash',['-ec','source "$1"; TAILSCALE_USER="$2"; select_tailscale_identity; printf "%s %s" "$TAILSCALE_DNS" "$TAILSCALE_USER"','bash',script,user],{input:status,encoding:'utf8'});
 assert.equal(select(personal).stdout,'node.tailnet.ts.net owner@example.com');
 assert.notEqual(select(tagged).status,0);
 assert.equal(select(tagged,'allowed@example.com').stdout,'node.tailnet.ts.net allowed@example.com');
 assert.notEqual(select(JSON.stringify({Self:{DNSName:'',UserID:123},User:{'123':{LoginName:'x'}}})).status,0);
});

test('Tailscale rendering preserves secrets and password across mode changes', () => {
 const dir=mkdtempSync(join(tmpdir(),'install-tailscale-')), home=join(dir,'home'), root=join(home,'soulstream');
 let fake;
 const renderMode=(mode)=>spawnSync('bash',['-c','set -Eeuo pipefail; source "$1"; BACKENDS=codex; TAILSCALE="$4"; TAILSCALE_DNS=node.tailnet.ts.net; TAILSCALE_USER=owner@example.com; TAILSCALE_AUTH_KEY=secret-key; setup_secrets "$3" "$2/atom"; render_config "$2" "$3"','bash',script,home,root,mode],{encoding:'utf8',env:fake.env()});
 try {
  fake=prepareRoot(dir,root);
  let run=renderMode('true'); assert.equal(run.status,0,run.stderr);
  const orchPath=join(root,'.env.orch'), passwordPath=join(root,'.admin-password');
  assert.equal(statSync(orchPath).mode & 0o777,0o600);
  assert.equal(statSync(passwordPath).mode & 0o777,0o600);
  let orch=env(orchPath); assert.equal(orch.TAILSCALE_AUTH_ENABLED,'true'); assert.equal(orch.TAILSCALE_ALLOWED_LOGIN,'owner@example.com');
  assert.equal(orch.SOULSTREAM_PUBLIC_URL,'https://node.tailnet.ts.net'); assert.equal(orch.CORS_ALLOWED_ORIGINS,'https://node.tailnet.ts.net,http://127.0.0.1:5200');
  assert.equal(orch.ATOM_PUBLIC_URL,'https://node.tailnet.ts.net:8443'); assert.equal(orch.ATOM_SERVER_URL,'http://127.0.0.1:4200');
  assert.equal(orch.DASHBOARD_ADMIN_PASSWORD,undefined); assert.ok(!(run.stdout+run.stderr+readFileSync(orchPath,'utf8')).includes('secret-key'));
  const initial=orch;
  run=renderMode('false'); assert.equal(run.status,0,run.stderr); orch=env(orchPath);
  const password=orch.DASHBOARD_ADMIN_PASSWORD; assert.ok(password); assert.equal(orch.TAILSCALE_AUTH_ENABLED,undefined); assert.equal(orch.ATOM_PUBLIC_URL,'http://127.0.0.1:4200');
  run=renderMode('true'); assert.equal(run.status,0,run.stderr); assert.equal(readFileSync(passwordPath,'utf8').trim(),password);
  orch=env(orchPath); assert.equal(orch.DASHBOARD_ADMIN_PASSWORD,undefined); assert.equal(orch.ATOM_PUBLIC_URL,'https://node.tailnet.ts.net:8443');
  run=renderMode('false'); assert.equal(run.status,0,run.stderr); orch=env(orchPath);
  assert.equal(orch.DASHBOARD_ADMIN_PASSWORD,password); assert.equal(readFileSync(passwordPath,'utf8').trim(),password); assert.equal(orch.ATOM_PUBLIC_URL,'http://127.0.0.1:4200');
  for (const key of ['JWT_SECRET','AUTH_BEARER_TOKEN','DATABASE_URL']) assert.equal(orch[key],initial[key]);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('Tailscale auth key is passed through a private temporary file and removed', () => {
 const dir=mkdtempSync(join(tmpdir(),'install-tailscale-key-')), bin=join(dir,'tailscale'), log=join(dir,'log'), state=join(dir,'state');
 try {
  writeFileSync(bin, `#!/usr/bin/env bash
if [[ "$1" == status ]]; then
 if [[ -f "$TEST_STATE" ]]; then printf '%s' '{"BackendState":"Running","Self":{"DNSName":"node.tailnet.ts.net.","UserID":1},"User":{"1":{"LoginName":"owner@example.com"}}}'; else printf '%s' '{"BackendState":"Stopped"}'; fi
elif [[ "$1" == up ]]; then
 [[ "$2" == --auth-key=file:* ]] || exit 10
 file=\${2#--auth-key=file:}; [[ "$(stat -c %a "$file")" == 600 && "$(cat "$file")" == "$TEST_KEY" ]] || exit 11
 printf '%s' "$file" > "$TEST_STATE"; fi
`); chmodSync(bin,0o755);
  const run=spawnSync('bash',['-ec','source "$1"; LOG="$2"; TAILSCALE_USER=; TAILSCALE_AUTH_KEY="$TEST_KEY"; exec 3>&2; setup_tailscale','bash',script,log],{
   env:{...process.env,PATH:`${dir}:${process.env.PATH}`,TEST_STATE:state,TEST_KEY:'example-auth-key'},encoding:'utf8'
  });
  assert.equal(run.status,0,run.stderr); assert.ok(!(run.stdout+run.stderr+readFileSync(log,'utf8')).includes('example-auth-key'));
  assert.throws(()=>statSync(readFileSync(state,'utf8')));
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
