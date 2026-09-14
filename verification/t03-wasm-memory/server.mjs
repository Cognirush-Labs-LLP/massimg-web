// Minimal static file server for the harness page. The task needs the page
// served over http (not file://) so WASM streaming instantiation and module
// imports behave the way they do in the real app.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';
      const filePath = normalize(join(root, path));
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const data = await readFile(filePath);
      const type = types[extname(filePath)] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': data.length,
        // Needed for WebAssembly.instantiateStreaming with a non-wasm
        // Content-Type fallback path some servers hit; harmless here since
        // we set the correct type above, but keeps things permissive.
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
