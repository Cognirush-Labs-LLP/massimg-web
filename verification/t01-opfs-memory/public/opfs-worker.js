// Fallback write path: FileSystemSyncAccessHandle is restricted to dedicated
// workers by spec (not just a WebKit quirk), so when the main-thread
// `createWritable()` stream is unavailable/unusable we route the chunked write
// through this worker instead, using createSyncAccessHandle.
const CHUNK_BYTES = 32 * 1024 * 1024;
const FILE_NAME = 't01-payload.bin';

let chunkBuffer = null;
function getChunk() {
  if (!chunkBuffer) {
    chunkBuffer = new Uint8Array(CHUNK_BYTES);
    for (let i = 0; i < chunkBuffer.length; i += 4096) chunkBuffer[i] = 1;
  }
  return chunkBuffer;
}

self.onmessage = async (event) => {
  const { totalBytes } = event.data;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(FILE_NAME, { create: true });
    const accessHandle = await handle.createSyncAccessHandle();
    accessHandle.truncate(0);
    let written = 0;
    const chunk = getChunk();
    while (written < totalBytes) {
      const remaining = totalBytes - written;
      const piece = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
      accessHandle.write(piece, { at: written });
      written += piece.length;
    }
    accessHandle.flush();
    accessHandle.close();
    self.postMessage({ ok: true, written });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.stack ? err.stack : err) });
  }
};
