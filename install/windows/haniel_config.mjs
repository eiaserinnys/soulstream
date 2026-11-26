// haniel.yaml: atom, orchestrator and worker as three services started in that order.
import { join } from 'node:path';

const yamlString = (value) => `'${value.replaceAll("'", "''")}'`;
const forward = (path) => path.replaceAll('\\', '/');

export function renderHanielConfig(ctx) {
  const node = `"${process.execPath}"`;
  const envFile = (dir, name) => forward(join(dir === ctx.atomDir ? 'atom' : 'soulstream', name));
  const ready = (port, path) => `http:127.0.0.1:${port}${path}`;
  return `# Written by install-windows.ps1; a rerun rewrites it.
poll_interval: 60
auto_apply: false

services:
  atom:
    run: ${yamlString(`${node} dist/api/index.js`)}
    cwd: ${yamlString(ctx.atomDir)}
    release_env_file: ${yamlString(envFile(ctx.atomDir, '.env'))}
    ready: ${yamlString(ready(ctx.ports.atom, '/api/health'))}
    ready_timeout: 120
    restart_delay: 3
  orch:
    run: ${yamlString(`${node} dist/production_main.js`)}
    cwd: ${yamlString(join(ctx.soulDir, 'orch-server-ts'))}
    release_env_file: ${yamlString(envFile(ctx.soulDir, '.env.orch'))}
    after: [atom]
    ready: ${yamlString(ready(ctx.ports.orch, '/api/health'))}
    ready_timeout: 120
    restart_delay: 3
  worker:
    run: ${yamlString(`${node} soul-server-ts/dist/main.js`)}
    cwd: ${yamlString(ctx.soulDir)}
    after: [orch]
    ready: ${yamlString(ready(ctx.ports.worker, '/health'))}
    ready_timeout: 120
    restart_delay: 3
`;
}
