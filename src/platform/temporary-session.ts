let session: string | undefined
let lease: Promise<void> | undefined

export function temporarySessionId(): string {
  return (session ??= crypto.randomUUID())
}

function lockName(owner: string): string {
  // Retain the source-storage lock name so tabs running the earlier source-copy implementation
  // participate in the same ownership protocol.
  return `icompress-sources:${owner}`
}

export function holdTemporarySessionLease(): Promise<void> {
  return (lease ??= new Promise<void>((resolve, reject) => {
    if (!navigator.locks) {
      reject(new Error('Temporary storage requires Web Locks'))
      return
    }

    // The unresolved callback holds ownership until document destruction, including while idle.
    void navigator.locks
      .request(lockName(temporarySessionId()), async () => {
        resolve()
        await new Promise<void>(() => {})
      })
      .catch(reject)
  }))
}

export async function cleanupIfAbandoned(
  owner: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  if (!navigator.locks) return
  await navigator.locks.request(lockName(owner), { ifAvailable: true }, async (lock) => {
    if (lock) await cleanup()
  })
}
