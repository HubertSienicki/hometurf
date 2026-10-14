// Zero-dependency dev server with live reload.
//   npm run dev            -> http://localhost:5174
// Saving a file pushes a reload event to every open tab. Tabs that are sitting
// in a room (hosting or racing) only show a "code updated" toast instead of
// reloading, so a code edit never kicks your friends out mid-race.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 5174;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const clients = new Set();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__livereload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);

let timer = null;
const pending = new Set();
fs.watch(root, { recursive: true }, (_ev, name) => {
  if (!name) return;
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('node_modules') || n.startsWith('.git') || n.startsWith('dist/') || n.startsWith('scripts/') || n.startsWith('.claude') || n.startsWith('.netlify') || n.endsWith('~')) return;
  if (!/\.(html|css|js|svg|json|png)$/.test(n) || /\.tmp\.|\.swp$/.test(n)) return;
  pending.add(n);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const files = [...pending]; pending.clear();
    const cssOnly = files.every(f => f.endsWith('.css'));
    for (const c of clients) c.write(cssOnly ? `event: css\ndata: ${files.join(',')}\n\n` : 'event: reload\ndata: 1\n\n');
    console.log(`[live] ${cssOnly ? 'css' : 'reload'} <- ${files.join(', ')}  (${clients.size} tab${clients.size === 1 ? '' : 's'})`);
  }, 150);
});

server.listen(port, () => {
  console.log(`\n  HOME TURF dev server\n  -> http://localhost:${port}\n  Live reload is on (tabs inside a room get a toast instead of a reload).\n`);
});
