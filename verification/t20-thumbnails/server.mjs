// Minimal static server for the harness page, plus a /fixture/<index> endpoint that streams a
// selected photograph's bytes from the machine-local fixtures directory. Fixtures are served by
// index and never copied into the repo (AGENTS.md).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
};

const fixtureTypes = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  gif: 'image/gif',
  tiff: 'image/tiff',
};

export function startServer(fixtures, port = 0) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let path = decodeURIComponent(url.pathname);

      const fixtureMatch = /^\/fixture\/(\d+)$/.exec(path);
      if (fixtureMatch) {
        const fixture = fixtures[Number(fixtureMatch[1])];
        if (!fixture) {
          res.writeHead(404);
          res.end('no such fixture');
          return;
        }
        const data = await readFile(fixture.path);
        res.writeHead(200, {
          'Content-Type': fixtureTypes[fixture.format] || 'application/octet-stream',
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
        });
        res.end(data);
        return;
      }

      if (path === '/manifest.json') {
        // Deliberately excludes the on-disk path: the page addresses fixtures by index only.
        const body = JSON.stringify(
          fixtures.map(({ index, format, bytes, width, height }) => ({
            index,
            format,
            bytes,
            width,
            height,
          })),
        );
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(body);
        return;
      }

      if (path === '/') path = '/index.html';
      const filePath = normalize(join(root, path));
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const data = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': types[extname(filePath)] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch (err) {
      res.writeHead(404);
      res.end('not found: ' + err.message);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actualPort } = server.address();
      resolve({ server, port: actualPort, url: `http://127.0.0.1:${actualPort}/` });
    });
  });
}
