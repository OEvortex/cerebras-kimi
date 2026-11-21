import { activeWorkspaceId } from './workspace-scope'

export type WorkspaceDraft = {
  text: string
  attachments: { filename: string; base64?: string; mimeType?: string }[]
}

export type WorkspaceDraftLocation = {
  workspaceId: string
  pathname: string
}

/**
 * Snapshot the scope a composer is writing into. Callers capture this at
 * typing time: by the time a deferred save or an unmount cleanup runs, the
 * URL may already point at the destination page, and the draft would land
 * under the wrong key.
 */
export function currentWorkspaceDraftLocation(): WorkspaceDraftLocation {
  return {
    workspaceId: activeWorkspaceId(),
    pathname: window.location.pathname,
  }
}

function key(workspaceId = activeWorkspaceId(), pathname = window.location.pathname): string {
  return `local-admin:${workspaceId}:${pathname}`
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('deeptutor-workspace-drafts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveWorkspaceDraft(draft: WorkspaceDraft, workspaceId?: string, pathname?: string): Promise<void> {
  const draftKey = key(workspaceId, pathname)
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite')
      const store = tx.objectStore('drafts')
      if (draft.text || draft.attachments.length) store.put(draft, draftKey)
      else store.delete(draftKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export async function readWorkspaceDraft(workspaceId?: string, pathname?: string): Promise<WorkspaceDraft | undefined> {
  const draftKey = key(workspaceId, pathname)
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readonly')
      const store = tx.objectStore('drafts')
      const request = store.get(draftKey)
      tx.oncomplete = () => resolve(request.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

/** Move the current unsent message with an explicit composer assignment. */

