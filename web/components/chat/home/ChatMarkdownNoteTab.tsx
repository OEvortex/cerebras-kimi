'use client'
import dynamic from '@/shared/router/dynamic'
import { useEffect, useState } from 'react'

import { createNote } from '@/lib/notes-api'
import { loadChatMarkdownNoteDraft, saveChatMarkdownNoteDraft } from '@/lib/chat-markdown-note'
const NoteWorkspace = dynamic(() => import('@/features/notes/components/NoteWorkspace'), {
  ssr: false,
})
export default function ChatMarkdownNoteTab({ sessionId }: { sessionId: string | null }) {
  
  const owner = 'local'
  const [recoverable, setRecoverable] = useState(false)
  const [docId, setDocId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!owner) return
    const draft = loadChatMarkdownNoteDraft(owner, sessionId)
    setDocId(draft.saved?.id || null)
    setRecoverable(
      !!draft.saved && (draft.content !== draft.saved.content || draft.title !== draft.saved.title)
    )
  }, [owner, sessionId])
  const create = async () => {
    if (!owner || busy) return
    setBusy(true)
    try {
      const draft = loadChatMarkdownNoteDraft(owner, sessionId)
      const doc = await createNote(draft.title || "Conversation notes", null, draft.content)
      saveChatMarkdownNoteDraft(owner, sessionId, {
        title: doc.title,
        content: doc.content,
        saved: { id: doc.id, title: doc.title, content: doc.content },
      })
      setDocId(doc.id)
      setRecoverable(false)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  if (recoverable)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
        <p>{"An earlier conversation draft has unsaved changes."}</p>
        <button className="dt-note-button" disabled={busy} onClick={() => void create()}>
          {"Save draft as a new page"}
        </button>
        <button className="dt-note-button" onClick={() => setRecoverable(false)}>
          {"Open saved page"}
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    )
  return docId ? (
    <NoteWorkspace key={`${owner}:${docId}`} docId={docId} embedded />
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
      <p>{"Keep your ideas beside the conversation."}</p>
      <button
        disabled={!owner || busy}
        onClick={() => void create()}
        className="rounded-md bg-[var(--secondary)] px-3 py-2"
      >
        {(busy ? 'Creating…' : 'Create a note')}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
