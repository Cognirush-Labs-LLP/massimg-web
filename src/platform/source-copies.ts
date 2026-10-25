const DATABASE_NAME = 'icompress-sources'
const STORE_NAME = 'sources'

interface StoredSource {
  session: string
  id: string
  name: string
  type: string
  lastModified: number
  blob?: Blob
  bytes?: Uint8Array<ArrayBuffer>
}

let database: Promise<IDBDatabase> | undefined
let session: string | undefined
let lease: Promise<void> | undefined
let storeBlobs = true

function sessionId(): string {
  return (session ??= crypto.randomUUID())
}

function lockName(owner: string): string {
  return `${DATABASE_NAME}:${owner}`
}

function holdSessionLease(): Promise<void> {
  return (lease ??= new Promise<void>((resolve, reject) => {
    if (!navigator.locks) {
      reject(new Error('Temporary source storage requires Web Locks'))
      return
    }

    const owner = sessionId()
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted && database) {
        void database.then((db) => deleteSession(db, owner)).catch(() => {})
      }
    })

    // A live tab holds its lease until the browser destroys it. Another tab can then distinguish
    // abandoned copies from sources that are still in use, including across a crash or reload.
    void navigator.locks
      .request(lockName(owner), async () => {
        resolve()
        await new Promise<void>(() => {})
      })
      .catch(reject)
  }))
}

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: ['session', 'id'] })
      store.createIndex('session', 'session')
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
  })
  database = opening
  void opening.catch(() => {
    if (database === opening) database = undefined
  })
  return opening
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('Source storage aborted'))
  })
}

export async function writeSourceCopy(
  id: string,
  source: File,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<File> {
  await holdSessionLease()
  const db = await openDatabase()
  const owner = sessionId()
  const metadata = {
    session: owner,
    id,
    name: source.name,
    type: source.type,
    lastModified: source.lastModified,
  }

  async function store(value: StoredSource): Promise<void> {
    const write = db.transaction(STORE_NAME, 'readwrite')
    const written = transactionDone(write)
    write.objectStore(STORE_NAME).put(value)
    await written
  }

  if (storeBlobs) {
    try {
      await store({ ...metadata, blob: new Blob([bytes], { type: source.type }) })
    } catch (error) {
      if (
        !(error instanceof DOMException) ||
        !['UnknownError', 'DataCloneError', 'NotSupportedError'].includes(error.name)
      ) {
        throw error
      }
      // WebKit's ephemeral storage accepts byte arrays but rejects Blob/File values. Keep the
      // bytes in the database and materialize a File only for the consumer currently reading it.
      await store({ ...metadata, bytes })
      storeBlobs = false
    }
  } else {
    await store({ ...metadata, bytes })
  }

  const copy = await readSourceCopy(id)
  if (!copy) throw new Error('Temporary source copy is missing')
  return copy
}

export async function readSourceCopy(id: string): Promise<File | undefined> {
  const db = await openDatabase()
  // Read the committed Blob back from the database. Wrapping the picker's File in another File
  // or Blob merely preserves its failing backing reference; these bytes must be independent.
  const read = db.transaction(STORE_NAME, 'readonly')
  const finished = transactionDone(read)
  const request = read.objectStore(STORE_NAME).get([sessionId(), id])
  const stored = new Promise<StoredSource | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as StoredSource | undefined)
    request.onerror = () => reject(request.error)
  })
  const [copy] = await Promise.all([stored, finished])
  if (!copy) return undefined
  const content = copy.blob ?? copy.bytes
  if (!content) throw new Error('Temporary source copy has no bytes')
  return new File([content], copy.name, {
    type: copy.type,
    lastModified: copy.lastModified,
  })
}

export async function deleteSourceCopies(ids: readonly string[]): Promise<void> {
  if (ids.length === 0 || !database) return

  const db = await database
  const transaction = db.transaction(STORE_NAME, 'readwrite')
  const finished = transactionDone(transaction)
  const store = transaction.objectStore(STORE_NAME)
  for (const id of ids) store.delete([sessionId(), id])
  await finished
}

async function deleteSession(db: IDBDatabase, owner: string): Promise<void> {
  const transaction = db.transaction(STORE_NAME, 'readwrite')
  const finished = transactionDone(transaction)
  const store = transaction.objectStore(STORE_NAME)
  const request = store.index('session').openKeyCursor(IDBKeyRange.only(owner))
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) return
    store.delete(cursor.primaryKey)
    cursor.continue()
  }
  await finished
}

export async function cleanupAbandonedSourceCopies(): Promise<void> {
  if (typeof indexedDB === 'undefined' || !navigator.locks) return

  const db = await openDatabase()
  const transaction = db.transaction(STORE_NAME, 'readonly')
  const finished = transactionDone(transaction)
  const owners: string[] = []
  const request = transaction
    .objectStore(STORE_NAME)
    .index('session')
    .openKeyCursor(null, 'nextunique')
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) return
    if (typeof cursor.key === 'string') owners.push(cursor.key)
    cursor.continue()
  }
  await finished

  for (const owner of owners) {
    await navigator.locks.request(lockName(owner), { ifAvailable: true }, async (lock) => {
      if (lock) await deleteSession(db, owner)
    })
  }
}
