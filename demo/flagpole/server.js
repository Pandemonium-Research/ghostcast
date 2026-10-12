// flagpole's dashboard and the Roastery shop that reads its flags, on one small server.
import fs from 'node:fs';
import http from 'node:http';
import { enabled, history, load } from './flags.js';

const pages = { '/': 'dashboard.html', '/shop': 'shop.html' };
// The shop has no accounts; every request is this one visitor, so a rollout either reaches them or not.
const VISITOR = 'guest-0012';

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (pages[url.pathname]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(new URL(`./${pages[url.pathname]}`, import.meta.url)));
  }
  if (url.pathname === '/api/flags') return json(res, { flags: load(), history: history() });
  if (url.pathname === '/api/shop') {
    const flags = Object.fromEntries(load().map((f) => [f.name, enabled(f, VISITOR)]));
    return json(res, { express: flags['new-checkout'], dark: flags['dark-mode'] });
  }
  res.writeHead(404);
  res.end();
});

server.listen(Number(process.env.PORT) || 4000, '127.0.0.1', () => {
  console.log(`flagpole on http://127.0.0.1:${server.address().port}/ (shop: /shop)`);
});
