// Mirrors the primitive in src/platform/thumbnail-render.ts: a bounded-resize createImageBitmap
// decode, then an OffscreenCanvas encode. Reimplemented in plain JS rather than imported because
// this harness is a static page with no TypeScript transform, and because C5 measures the platform
// primitive itself, not the service's queueing around it. Kept deliberately small so the two cannot
// drift in any way that matters to the numbers.

function fitWithin(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / width, maxEdge / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function thumbnail({ index, width, height, maxEdge, format, quality }) {
  const target = fitWithin(width, height, maxEdge);

  const fetchStart = performance.now();
  const blob = await fetch(`/fixture/${index}`).then((response) => response.blob());
  const fetchMs = performance.now() - fetchStart;

  const decodeStart = performance.now();
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      resizeWidth: target.width,
      resizeHeight: target.height,
      resizeQuality: 'high',
    });
  } catch (error) {
    return {
      index,
      ok: false,
      // The ImageMagick fallback's trigger: a supported input this engine cannot decode natively.
      reason: error instanceof DOMException ? 'unsupported' : 'failed',
      fetchMs,
      sourceBytes: blob.size,
    };
  }
  const decodeMs = performance.now() - decodeStart;

  const encodeStart = performance.now();
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const encoded = await canvas.convertToBlob({ type: format, quality });
  const encodeMs = performance.now() - encodeStart;
  bitmap.close();

  return {
    index,
    ok: true,
    fetchMs,
    decodeMs,
    encodeMs,
    totalMs: fetchMs + decodeMs + encodeMs,
    sourceBytes: blob.size,
    thumbBytes: encoded.size,
    width: bitmap.width,
    height: bitmap.height,
    blob: encoded,
  };
}

self.addEventListener('message', (event) => {
  const message = event.data;

  if (message.kind === 'job') {
    thumbnail(message).then(
      (result) => self.postMessage({ kind: 'result', result }),
      (error) => self.postMessage({ kind: 'result', result: { index: message.index, ok: false, reason: 'failed', error: String(error) } }),
    );
    return;
  }

  if (message.kind === 'loop') {
    // The cancellation probe: keep generating until terminated, never returning to idle. This is
    // what the driver kills mid-flight to show that CPU and memory growth actually stop.
    const run = async () => {
      for (let i = 0; ; i = (i + 1) % message.jobs.length) {
        await thumbnail({ ...message.jobs[i], ...message.options });
        self.postMessage({ kind: 'tick' });
      }
    };
    void run();
  }
});
