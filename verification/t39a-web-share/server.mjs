import http from 'node:http';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveFixture, SUPPORTED_FORMATS } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const RESULTS_PATH = path.join(__dirname, 'results.json');
const PORT = Number(process.env.PORT) || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function withCommonHeaders(res, extra = {}) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  for (const [key, value] of Object.entries(extra)) {
    res.setHeader(key, value);
  }
}

function readResults() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function appendResult(record) {
  const results = readResults();
  results.push({ ...record, recordedAt: new Date().toISOString() });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2) + '\n');
  return results.length;
}

async function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC_DIR, decodeURIComponent(urlPath.split('?')[0]));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    withCommonHeaders(res, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.writeHead(200);
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

function serveFixture(req, res, format) {
  if (!SUPPORTED_FORMATS.includes(format)) {
    res.writeHead(404);
    res.end(`unsupported format: ${format}`);
    return;
  }
  let fixture;
  try {
    fixture = resolveFixture(format);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err.message || err));
    return;
  }
  withCommonHeaders(res, {
    'Content-Type': fixture.mime,
    'Content-Length': String(fixture.size),
    'Cache-Control': 'no-store',
  });
  res.writeHead(200);
  fs.createReadStream(fixture.path).pipe(res);
}

function handleResultsPost(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on('end', () => {
    try {
      const record = JSON.parse(body);
      const count = appendResult(record);
      withCommonHeaders(res, { 'Content-Type': 'application/json' });
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, count }));
    } catch (err) {
      res.writeHead(400);
      res.end(String(err.message || err));
    }
  });
}

export function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const [urlPath] = req.url.split('?');
      if (req.method === 'POST' && urlPath === '/results') {
        handleResultsPost(req, res);
        return;
      }
      const fixtureMatch = /^\/fixture\/([a-z0-9]+)$/.exec(urlPath);
      if (req.method === 'GET' && fixtureMatch) {
        serveFixture(req, res, fixtureMatch[1]);
        return;
      }
      serveStatic(req, res);
    });
    server.listen(PORT, '0.0.0.0', () => {
      resolve({ server, port: PORT, url: `http://127.0.0.1:${PORT}` });
    });
  });
}

// A plain `file://${process.argv[1]}` comparison breaks on Windows: argv[1] is a backslash path
// (`C:\...`) but import.meta.url is a proper `file:///C:/...` URL, so they never match, this block
// silently never runs, and the process exits with no output at all — which is exactly what happened.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startServer();
  console.log(`T39-A harness running at ${url}`);
  console.log('Android: adb reverse tcp:8787 tcp:8787, then open http://localhost:8787 on the phone.');
  console.log('Windows/macOS: copy this folder onto that machine, run `node server.mjs` there, open http://localhost:8787.');
}
