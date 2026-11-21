import type { FavoriteSnapshot } from '@/lib/favorite-content'
import type { NoteBlock, NotePage, NoteSuggestion } from '@/lib/notes-api'
import type { NoteClipInput } from '../../model/clip-editing'
import type { NoteThreadView } from '../../model/threads'
import type { NotesEditor } from './schema'

export type { NotesEditor }

export interface NoteEditorHandle {
  blocks: () => NoteBlock[]
  setEditable: (editable: boolean) => void
  replace: (blocks: NoteBlock[]) => void
  parse: (markdown: string) => NoteBlock[]
  insertClip: (
    title: string,
    markdown: string,
    sourceUrl: string,
    sourceId?: string,
    favorite?: FavoriteSnapshot
  ) => void
  insertClips: (clips: NoteClipInput[]) => void
  focusBlock: (id: string) => void
  /** A learning block of ``kind`` right after ``blockId``; its id, or null. */
  insertLearningAfter: (blockId: string, kind: string, prompt: string) => string | null
  /** Keep the request a learning block is regenerated from as its prompt. */
  updateLearningPrompt: (blockId: string, prompt: string) => void
  /** Drop/insert a `pageLink` mention at the caret (Notion-style page drop). */
  insertPageLink: (pageId: string, title: string) => void
  /** The block the caret is in, for "ask Dito" from outside the page. */
  cursorBlockId: () => string | null
  hasBlock: (id: string) => boolean
}

/** Where a conversation is opened from, and what it starts with. */
export interface NoteAsk {
  blockId: string
  quote?: string
  prompt?: string
  /** Send the prompt straight away (a toolbar action) instead of drafting it. */
  autoSend?: boolean
  /** A knowledge base to search in this conversation. */
  knowledgeRef?: string
}

export interface NoteEditorProps {
  page: NotePage
  suggestions: NoteSuggestion[]
  reviewBusy: boolean
  reviewErrors?: Record<string, string>
  onContinueResearch: (suggestion: NoteSuggestion) => void
  onReview: (suggestion: NoteSuggestion, accept: boolean) => void
  onDiscuss: (suggestion: NoteSuggestion) => void
  onChange: (blocks: NoteBlock[]) => void
  onReady: (handle: NoteEditorHandle) => void
  onAI: (ask: NoteAsk) => void
  threads: NoteThreadView[]
  activeThread: { sessionId: string | null; blockId: string } | null
  threadsInteractive: boolean
  onOpenThread: (sessionId: string) => void
  onDeleteThread: (sessionId: string) => Promise<void>
  /** The block the learner clicked or moved the cursor into. */
  onFocusBlock?: (blockId: string) => void
  /** Reload the review queue after the editor proposes an AI edit itself. */
  onRefreshSuggestions?: () => void
}
