import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const CLIENT_ZIP_PATH = path.join(__dirname, 'node_modules', 'client-zip', 'index.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// OPFS needs a secure context. http://localhost is treated as a secure context by every engine, so
// plain HTTP on 127.0.0.1/localhost is sufficient here — no TLS needed for this throwaway harness.
export function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const urlPath = req.url === '/' ? '/index.html' : req.url;

        if (urlPath === '/client-zip.js') {
          const body = await readFile(CLIENT_ZIP_PATH);
          res.writeHead(200, { 'Content-Type': MIME['.js'] });
          res.end(body);
          return;
        }

        const filePath = path.join(PUBLIC_DIR, decodeURIComponent(urlPath.split('?')[0]));
        if (!filePath.startsWith(PUBLIC_DIR)) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }
        const body = await readFile(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}
