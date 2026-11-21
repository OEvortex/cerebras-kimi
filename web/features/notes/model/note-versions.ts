import { noteRequest, type NoteBlock, type NotePage } from '@/lib/notes-api'

/** One restorable snapshot of a notebook page. */
export interface NoteVersion {
  id: string
  doc_id: string
  revision: number
  created_at: number
  source: string
  title: string
  char_count: number
  word_count: number
  content?: string
  blocks?: NoteBlock[] | null
}

export const listNoteVersions = (docId: string) =>
  noteRequest<{ versions: NoteVersion[]; total: number }>(
    `/${docId}/versions`
  )

export const getNoteVersion = (docId: string, versionId: string) =>
  noteRequest<NoteVersion>(`/${docId}/versions/${versionId}`)

export const createNoteVersion = (docId: string) =>
  noteRequest<NoteVersion>(`/${docId}/versions`, { source: 'manual' })

export const restoreNoteVersion = (
  docId: string,
  versionId: string,
  expectedRevision: number
) =>
  noteRequest<NotePage>(`/${docId}/versions/${versionId}/restore`, {
    expected_revision: expectedRevision,
  })

const SOURCE_LABELS: Record<string, string> = {
  create: 'Created',
  save: 'Saved',
  edit: 'Edited',
  suggestion: 'Suggestion',
  clip: 'Source added',
  migrate: 'Converted',
  restore: 'Restored',
  'before-restore': 'Before restore',
  manual: 'Manual',
  move: 'Moved',
}

export function versionSourceLabel(source: string): string {
  return SOURCE_LABELS[source] || source || 'Edit'
}
