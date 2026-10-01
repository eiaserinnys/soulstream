import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SOURCE_SHA = '00ae51e6c99e7744a584810f326607374c8a1e44'
root = Path(__file__).resolve().parents[2]
artifact = root / 'soul-server-ts/test-artifacts/s4-ci-diagnostic'
mode = sys.argv[1]
assert mode in ['smoke', 's4']
tree = root
actual = subprocess.check_output(['git', '-C', str(tree), 'rev-parse', 'HEAD'], text=True).strip()
assert subprocess.check_output(['git', '-C', str(tree), 'rev-parse', 'HEAD^'], text=True).strip() == SOURCE_SHA
assert subprocess.check_output(['node', '--version'], text=True).strip() == 'v22.23.3'
assert os.environ.get('ImageOS') == 'ubuntu24'
assert os.environ.get('ImageVersion') == '20260927.320.1'
destination = artifact / mode
destination.mkdir(parents=True, exist_ok=True)
record_path = destination / 'execution.json'
assert not record_path.exists(), 'Exactly one execution per mode; repetition is forbidden'
if mode == 's4':
    smoke = json.loads((artifact / 'smoke/execution.json').read_text())
    assert smoke['exitCode'] == 0 and smoke['mode'] == 'smoke', 'Smoke must pass before S4'
    snapshot = json.loads((artifact / 'smoke/smoke.json').read_text())
    assert snapshot['errors'] == [] and all('error' not in f for f in snapshot['files'])
env = dict(os.environ) if mode == 's4' else {k:v for k,v in os.environ.items() if k in ['PATH','HOME','LANG','LC_ALL','TMPDIR','PNPM_HOME']} 
env.pop('TEST_DATABASE_URL', None)
env.pop('DATABASE_URL', None)
env.pop('ANTHROPIC_API_KEY', None)
env['RUNNER_DIAGNOSTIC_DIR'] = str(destination)
command = ['corepack', 'pnpm', '--dir', str(tree / 'soul-server-ts'), 'exec', 'vitest', 'run',
           'tests/runner/s4_new_session_full_slice_postgres.test.ts',
           '-t', 'S4 claude completes a fresh production execution',
           '--minWorkers=1', '--maxWorkers=1', '--no-file-parallelism']
if mode == 'smoke':
    command = ['corepack', 'pnpm', '--dir', str(tree / 'soul-server-ts'), 'exec', 'vitest', 'run',
               'tests/runner/collector_sqlite_smoke.test.ts', '--minWorkers=1', '--maxWorkers=1', '--no-file-parallelism']
secrets = [v for k, v in env.items() if re.search(r'token|password|secret|oauth|api.?key', k, re.I) and len(v) >= 8]
secrets.extend(['full-slice-service-token', 'full-slice-jwt-secret', 'container_browse_test'])
def sanitize(line):
    for secret in secrets:
        line = line.replace(secret, '[redacted]')
    line = re.sub(r'postgres(?:ql)?://[^\s"\']+', '[database-url-redacted]', line, flags=re.I)
    return re.sub(r'Bearer\s+[^\s"\']+', 'Bearer [redacted]', line, flags=re.I)

pnpm_version = subprocess.check_output(['corepack', 'pnpm', '--version'], cwd=tree / 'soul-server-ts', text=True).strip()
assert pnpm_version == '10.32.1'
record = {'mode': mode, 'sourceSha': SOURCE_SHA, 'diagnosticSha': actual, 'imageVersion': os.environ['ImageVersion'], 'nodeVersion': '22.23.3', 'cwd': str(tree / 'soul-server-ts'), 'pnpmVersion': pnpm_version, 'sha': actual, 'start': datetime.now(timezone.utc).isoformat(),
          'command': command, 'testTimeoutMs': 60000 if mode == 'smoke' else 120000, 'pollTimeoutMs': 60000,
          'repeatForbidden': True, 'status': 'running'}
record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
print(f'CI: authorized single {mode} execution started', flush=True)
with (destination / 'vitest.log').open('w') as output:
    child = subprocess.Popen(command, cwd=tree / "soul-server-ts", env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in child.stdout:
        output.write(sanitize(line))
        output.flush()
    code = child.wait()
record.update({'end': datetime.now(timezone.utc).isoformat(), 'exitCode': code, 'status': 'completed'})
record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
print(f'CI: exit={code}; sanitized log saved; snapshot presence must be checked separately', flush=True)
sys.exit(code)
