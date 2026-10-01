import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const dist = resolve('dist');
let release = 'current';
let revision = 0;
const seed = `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));`;
// The deployed previous client approved immediately, before the worker activated.
const legacy = `<!doctype html><html><body><p id="legacy">Previous client</p><script>
localStorage.setItem('ls.webglGlass','0');
navigator.serviceWorker.addEventListener('message',e=>{if(e.data?.type==='SOULSTREAM_SW_ACTIVATED')e.source.postMessage({type:'SOULSTREAM_SW_APPROVE_RELOAD',token:e.data.token});});
navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(()=>document.body.dataset.ready='true');
</script></body></html>`;
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('Cache-Control', 'no-store');
  if (path === '/__test/release') {
    let body = ''; for await (const chunk of request) body += chunk;
    release = body; revision++; response.end('ready'); return;
  }
  if (path.startsWith('/api/')) {
    response.setHeader('Content-Type', 'application/json');
    const data = path === '/api/auth/config' ? { authEnabled: true, devModeEnabled: false }
      : path === '/api/auth/status' ? { authenticated: true, user: { email: 'sw-fixture@example.test', name: 'SW fixture', isAdmin: true } }
      : path === '/api/user/preferences' ? { preferences: { chatFontSize: 17, glass: { enabled: false } }, hasBackground: false }
      : {};
    response.end(JSON.stringify(data)); return;
  }
  try {
    if (path === '/components' && release === 'seed') {
      response.setHeader('Content-Type', 'text/html'); response.end(legacy); return;
    }
    if (path === '/sw.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end((release === 'seed' ? seed : await readFile(resolve(dist, 'sw.js'), 'utf8')) + `\n// fixture revision ${revision}`); return;
    }
    const file = path === '/' || path === '/components' ? 'index.html' : path.slice(1);
    const target = resolve(dist, file);
    if (!target.startsWith(dist + '/')) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(target));
  } catch { response.writeHead(404).end('not found'); }
}).listen(4199, '127.0.0.1');
