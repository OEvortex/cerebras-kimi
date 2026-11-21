'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from 'react'
import { closeHistory } from '@tiptap/pm/history'

import { autoMarkPage } from '@/lib/note-ai'
import { noteRequest, type NoteBlock, type NotePage } from '@/lib/notes-api'
import { notify } from '@/lib/notifications'
import { subscribeToThemeChanges } from '@/lib/theme'
import { insertNoteClips, type NoteClipInput } from '../../model/clip-editing'
import { spliceSelectedText } from '../../model/inline-edit'
import { parseNoteMarkdown } from '../../model/markdown'
import { noteMediaAccept, noteMediaType } from '../../model/media'
import { activeNoteUploads } from '../NoteUpload'
import { fitSchema, type NotesEditor } from './schema'
import type { NoteAsk, NoteEditorHandle } from './types'

interface UseNoteEditorLifecycleOptions {
  editor: NotesEditor
  page: NotePage
  onChange: (blocks: NoteBlock[]) => void
  onReady: (handle: NoteEditorHandle) => void
  onAI: (ask: NoteAsk) => void
  onFocusBlock?: (blockId: string) => void
  onRefreshSuggestions?: () => void
}

export default function useNoteEditorLifecycle({
  editor,
  page,
  onChange,
  onReady,
  onAI,
  onFocusBlock,
  onRefreshSuggestions,
}: UseNoteEditorLifecycleOptions) {
  
  const theme = useSyncExternalStore<'light' | 'dark'>(
    subscribeToThemeChanges,
    () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
    () => 'light'
  )

  const ready = useRef(false)
  const container = useRef<HTMLDivElement>(null)
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)
  const attachContainer = useCallback((el: HTMLDivElement | null) => {
    container.current = el
    setContainerEl(el)
  }, [])

  const uploadInput = useRef<HTMLInputElement>(null)
  const uploadAnchor = useRef<string | null>(null)
  const uploadRetry = useRef<string | null>(null)
  const initialized = useRef(false)
  const latest = useRef({ onChange, onReady, onAI, onFocusBlock })

  useLayoutEffect(() => {
    latest.current = { onChange, onReady, onAI, onFocusBlock }
  }, [onChange, onReady, onAI, onFocusBlock])

  // BlockNote hides the block handles whenever the page scrolls and shows
  // them again only on the next mouse move; once the scroll settles, show
  // them for the block under a pointer that has not moved.
  useEffect(() => {
    if (!containerEl) return
    let pointer: { x: number; y: number } | null = null
    let timer = 0
    const track = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') pointer = { x: event.clientX, y: event.clientY }
    }
    const settle = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (!pointer) return
        const box = containerEl.getBoundingClientRect()
        if (pointer.y < box.top || pointer.y > box.bottom) return
        document.elementFromPoint(pointer.x, pointer.y)?.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            clientX: pointer.x,
            clientY: pointer.y,
          })
        )
      }, 140)
    }
    window.addEventListener('pointermove', track, { passive: true })
    document.addEventListener('scroll', settle, { capture: true, passive: true })
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', track)
      document.removeEventListener('scroll', settle, { capture: true })
    }
  }, [containerEl])

  useEffect(() => {
    const retry = (event: Event) => {
      uploadRetry.current = (event as CustomEvent).detail.blockId
      if (uploadInput.current) {
        uploadInput.current.accept = noteMediaAccept
        uploadInput.current.click()
      }
    }
    const el = container.current
    el?.addEventListener('note-upload-retry', retry)
    return () => el?.removeEventListener('note-upload-retry', retry)
  }, [])

  const parseMarkdown = useCallback(
    (text: string) =>
      parseNoteMarkdown(text, value => editor.tryParseMarkdownToBlocks(value) as NoteBlock[]),
    [editor]
  )

  useEffect(() => {
    let cancelled = false
    // BlockNote mounts React node views synchronously; initialize after React commits.
    queueMicrotask(() => {
      if (cancelled || initialized.current) return
      initialized.current = true
      if (page.blocks === null && page.content)
        editor.replaceBlocks(editor.document, parseMarkdown(page.content) as typeof editor.document)
      const insertClips = (clips: NoteClipInput[]) => {
        insertNoteClips(editor, clips)
        // PickerShell restores focus when it closes. Return to the document
        // afterwards so immediate undo/redo works without an extra click.
        requestAnimationFrame(() => {
          if (container.current) editor.focus()
        })
      }
      latest.current.onReady({
        blocks: () => editor.document as NoteBlock[],
        setEditable: editable => {
          editor.isEditable = editable
        },
        replace: blocks => {
          // Each acceptance is one undo step, independent of nearby typing or
          // another approval, even when the responses arrive within 500 ms.
          editor.transact(tr => closeHistory(tr))
          editor.replaceBlocks(
            editor.document,
            blocks.length
              ? (fitSchema(blocks as NoteBlock[]) as typeof editor.document)
              : [{ type: 'paragraph' }]
          )
          editor.transact(tr => closeHistory(tr))
        },
        parse: parseMarkdown,
        insertClip: (title, markdown, sourceUrl, sourceId = '', favorite) =>
          insertClips([{ title, markdown, sourceUrl, sourceId, favorite }]),
        insertClips,
        insertLearningAfter: (blockId, kind, prompt) => {
          const anchor = editor.getBlock(blockId)
          if (!anchor) return null
          const [created] = editor.insertBlocks(
            [{ type: 'learning', props: { kind, prompt } }],
            anchor,
            'after'
          )
          return created?.id ?? null
        },
        updateLearningPrompt: (blockId, prompt) => {
          const target = editor.getBlock(blockId)
          if (target?.type === 'learning' && target.props.prompt !== prompt)
            editor.updateBlock(target, { props: { prompt } })
        },
        insertPageLink: (pageId, title) => {
          editor.focus()
          editor.insertInlineContent([
            { type: 'pageLink', props: { pageId, title } },
            ' ',
          ])
        },
        cursorBlockId: () => {
          try {
            return editor.getTextCursorPosition().block.id
          } catch {
            return (editor.document[0] as NoteBlock | undefined)?.id ?? null
          }
        },
        hasBlock: id => Boolean(editor.getBlock(id)),
        focusBlock: id => {
          if (editor.getBlock(id)) {
            editor.setTextCursorPosition(id, 'start')
            editor.focus()
            container.current
              ?.querySelector(`[data-id="${CSS.escape(id)}"]`)
              ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }
        },
      })
      ready.current = true
      const target = window.location.hash.slice(1)
      if (target && editor.getBlock(target)) {
        editor.setTextCursorPosition(target, 'start')
        container.current
          ?.querySelector(`[data-id="${CSS.escape(target)}"]`)
          ?.scrollIntoView({ block: 'center' })
      }
      // Persist the first conversion as a revisioned migration, even before typing.
      if (page.blocks === null) latest.current.onChange(editor.document as NoteBlock[])
    })
    return () => {
      cancelled = true
    }
  }, [editor, page.blocks, page.content, parseMarkdown])

  /** Open a conversation on the caret's line; with a selection, about it. */
  const ai = useCallback(
    (instruction: string) => {
      const quote = editor.getSelectedText().trim()
      const block = editor.getTextCursorPosition().block
      latest.current.onAI({
        blockId: block.id,
        quote: quote || undefined,
        prompt: instruction || undefined,
        autoSend: Boolean(instruction && quote),
      })
    },
    [editor]
  )

  /** Turn an AI rewrite of the selection into a reviewable page suggestion. */
  const proposeAiEdit = useCallback(
    async (edited: string) => {
      const block = editor.getTextCursorPosition().block as unknown as NoteBlock
      const selected = editor.getSelectedText()
      const spliced = spliceSelectedText(block, selected, edited)
      const replacement =
        spliced ?? (editor.tryParseMarkdownToBlocks(edited) as unknown as NoteBlock[])
      try {
        await noteRequest(`/${page.id}/suggestions`, {
          operation: 'replace',
          block_id: block.id,
          markdown: edited,
          blocks: replacement.length ? replacement : undefined,
          explanation: 'Dito',
        })
        onRefreshSuggestions?.()
        notify("Suggested an edit below your selection")
      } catch (err) {
        notify(err instanceof Error ? err.message : "Could not suggest the edit.", {
          tone: 'error',
        })
      }
    },
    [editor, onRefreshSuggestions, page.id]
  )

  const annotatePage = useCallback(async () => {
    const text = await editor.blocksToMarkdownLossy(editor.document)
    if (!text.trim()) {
      notify("Add some content before annotating.", { tone: 'error' })
      return false
    }
    try {
      const marked = await autoMarkPage(text)
      const blocks = parseMarkdown(marked)
      if (!blocks.length) return false
      editor.replaceBlocks(editor.document, blocks as never)
      notify("Annotated the page")
      return true
    } catch (err) {
      notify(err instanceof Error ? err.message : "Annotation failed.", { tone: 'error' })
      return false
    }
  }, [editor, parseMarkdown])

  const handleFileUpload = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      const retryId = uploadRetry.current
      uploadRetry.current = null
      const id = retryId || crypto.randomUUID()
      activeNoteUploads.add(id)
      const existing = retryId ? editor.getBlock(retryId) : undefined
      if (existing?.type === 'noteUpload') {
        editor.updateBlock(existing, { props: { name: file.name, error: '' } })
      } else {
        const anchor =
          editor.getBlock(uploadAnchor.current || '') || editor.getTextCursorPosition().block
        const placeholder = { id, type: 'noteUpload' as const, props: { name: file.name } }
        if (anchor.type === 'paragraph' && !anchor.content?.length)
          editor.replaceBlocks([anchor], [placeholder])
        else editor.insertBlocks([placeholder], anchor, 'after')
      }
      try {
        const type = noteMediaType(file)
        const url = await editor.uploadFile!(file)
        // The user may move the caret or delete the placeholder while uploading.
        const target = editor.getBlock(id)
        if (target?.type === 'noteUpload')
          editor.replaceBlocks(
            [target],
            [{ id, type, props: { url: typeof url === 'string' ? url : '', name: file.name } }]
          )
      } catch (err) {
        activeNoteUploads.delete(id)
        if (editor.getBlock(id)?.type === 'noteUpload')
          editor.updateBlock(id, {
            props: { error: (err instanceof Error ? err.message : 'Upload failed') },
          })
      } finally {
        activeNoteUploads.delete(id)
      }
    },
    [editor]
  )

  return {
    theme,
    ready,
    container,
    containerEl,
    attachContainer,
    uploadInput,
    uploadAnchor,
    uploadRetry,
    latest,
    ai,
    proposeAiEdit,
    annotatePage,
    handleFileUpload,
  }
}
