// ticklist's web app: one page and a small JSON API over tasks.json.
import fs from 'node:fs';
import http from 'node:http';
import { add, load, save } from './store.js';

const page = fs.readFileSync(new URL('./index.html', import.meta.url));

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  if (req.url === '/api/tasks' && req.method === 'GET') return json(res, load());
  if (req.url === '/api/tasks' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let title = '';
      try { title = String(JSON.parse(body).title || '').trim(); } catch {}
      if (!title) return json(res, { error: 'a task needs a title' }, 400);
      const tasks = load();
      add(tasks, title);
      save(tasks);
      json(res, tasks, 201);
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(Number(process.env.PORT) || 3000, '127.0.0.1', () => {
  console.log(`ticklist on http://127.0.0.1:${server.address().port}/`);
});
