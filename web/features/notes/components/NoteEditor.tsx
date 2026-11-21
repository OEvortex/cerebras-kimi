'use client'

import { useCallback } from 'react'
import type { PartialBlock } from '@blocknote/core'
import { en } from '@blocknote/core/locales'
import {
  MathBlockInputRulesExtension,
  MathInlineInputRulesExtension,
  locales as mathLocales,
} from '@blocknote/math-block'
import {
  BlockNoteViewRaw,
  FormattingToolbarController,
  SideMenuController,
  SuggestionMenuController,
  useCreateBlockNote,
} from '@blocknote/react'
import '@blocknote/core/style.css'

import type { NoteBlock } from '@/lib/notes-api'
import { apiFetch, apiUrl } from '@/shared/api/client'
import { noteMediaAccept } from '../model/media'
import NoteInlineReviews from './NoteInlineReviews'
import type { NoteMenuItem } from './NoteInsertMenu'
import NoteInsertMenu from './NoteInsertMenu'
import NoteThreadMarkers from './NoteThreadMarkers'
import './notes.css'
import NoteEditorHandles, { SIDE_MENU_FLOATING } from './editor/NoteEditorHandles'
import NoteFormattingToolbar from './editor/NoteFormattingToolbar'
import NoteTableControls from './editor/NoteTableControls'
import { fitSchema, parseLegacyNoteContent, schema, type NotesEditor } from './editor/schema'
import type { NoteAsk, NoteEditorHandle, NoteEditorProps } from './editor/types'
import useNoteEditorLifecycle from './editor/useNoteEditorLifecycle'
import useNoteSlashItems from './editor/useNoteSlashItems'

export { fitSchema, parseLegacyNoteContent, type NotesEditor }
export type { NoteAsk, NoteEditorHandle, NoteEditorProps }


/** Coarse-imported pages keep markdown as literal text inside blocks; when the
 *  stored markdown still carries syntax the blocks never parsed, rebuild them
 *  through the real markdown parser instead of showing raw `**`/`$`. */
function blocksNeedMarkdownParse(blocks: NoteBlock[] | null, content: string): boolean {
  if (!blocks?.length || !content) return false
  // ```noteui programs are compiled to blocks server-side; the client parser
  // does not know the DSL and would reduce them to literal code blocks.
  if (/^\s*`{3,}(noteui|nb|note)\b/m.test(content)) return false
  const hasMarkdown = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|\$\$?|\*\*|__)/.test(content)
  if (!hasMarkdown) return false
  const raw = JSON.stringify(blocks)
  return raw.includes('**') || raw.includes('$')
}

export default function NoteEditor({
  page,
  onChange,
  onReady,
  onAI,
  suggestions,
  reviewBusy,
  reviewErrors,
  onReview,
  onDiscuss,
  onContinueResearch,
  threads,
  activeThread,
  threadsInteractive,
  onOpenThread,
  onDeleteThread,
  onFocusBlock,
  onRefreshSuggestions,
}: NoteEditorProps) {
  

  const editor = useCreateBlockNote(
    {
      schema,
      tables: { headers: true },
      extensions: [MathBlockInputRulesExtension, MathInlineInputRulesExtension],
      dictionary: (() => {
        const base = en
        const math = mathLocales.en
        return {
          ...base,
          ...math,
          slash_menu: { ...base.slash_menu, ...math.slash_menu },
          placeholders: {
            ...base.placeholders,
            default: "Write, press / to insert, or Space to ask Co-writer",
          },
        } as unknown as typeof base
      })(),
      initialContent: (() => {
        if (blocksNeedMarkdownParse(page.blocks, page.content)) {
          return parseLegacyNoteContent(page.content) as PartialBlock<
            typeof schema.blockSchema,
            typeof schema.inlineContentSchema,
            typeof schema.styleSchema
          >[]
        }
        return page.blocks?.length
          ? (fitSchema(page.blocks) as PartialBlock<
              typeof schema.blockSchema,
              typeof schema.inlineContentSchema,
              typeof schema.styleSchema
            >[])
          : undefined
      })(),
      uploadFile: async file => {
        const body = new FormData()
        body.append('file', file)
        const res = await apiFetch(apiUrl(`/api/documents/${page.id}/assets`), {
          method: 'POST',
          body,
        })
        if (!res.ok) {
          const error = await res.json().catch(() => ({}))
          throw new Error((error.detail || 'Upload failed'))
        }
        return (await res.json()).url as string
      },
    },
    [page.id]
  )

  const {
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
  } = useNoteEditorLifecycle({
    editor,
    page,
    onChange,
    onReady,
    onAI,
    onFocusBlock,
    onRefreshSuggestions,
  })

  const { getItems, pageItems } = useNoteSlashItems({
    editor,
    pageId: page.id,
    containerRef: container,
    uploadInputRef: uploadInput,
    uploadAnchorRef: uploadAnchor,
    uploadRetryRef: uploadRetry,
    onAI: ai,
  })

  const renderToolbar = useCallback(
    () => (
      <NoteFormattingToolbar
        editor={editor}
        onAI={ai}
        onProposeAiEdit={proposeAiEdit}
        onAnnotatePage={annotatePage}
      />
    ),
    [ai, annotatePage, editor, proposeAiEdit]
  )

  return (
    <div
      ref={attachContainer}
      className="dt-note-editor"
      onPointerDownCapture={e => {
        // Cards (learning blocks, embeds) take no text cursor, so a click on
        // one is the only sign the learner is looking at it.
        const target = e.target as HTMLElement
        if (target.closest('.bn-side-menu, .dt-note-orbs, .dt-note-ask-orb')) return
        const id = target.closest<HTMLElement>('.bn-block[data-id]')?.dataset.id
        if (id) latest.current.onFocusBlock?.(id)
      }}
      onKeyDownCapture={e => {
        // Read-only card controls stop ProseMirror's key handling. Keep the
        // document history accessible while a card button or source has focus.
        const target = e.target as HTMLElement
        if (
          target.closest('.dt-note-favorite') &&
          !target.closest('input, textarea, [contenteditable="true"]:not(.bn-editor)') &&
          !e.nativeEvent.isComposing &&
          !e.altKey &&
          (e.metaKey || e.ctrlKey) &&
          ['z', 'y'].includes(e.key.toLowerCase())
        ) {
          e.preventDefault()
          e.stopPropagation()
          if (e.shiftKey || e.key.toLowerCase() === 'y') editor.redo()
          else editor.undo()
          editor.focus()
        }
      }}
      onKeyDown={e => {
        if (
          !(
            e.target instanceof HTMLElement &&
            e.target.closest('input, textarea, button, [contenteditable="false"]')
          ) &&
          !e.nativeEvent.isComposing &&
          e.key === ' ' &&
          editor.getTextCursorPosition().block.type === 'paragraph' &&
          editor.getSelectedText() === ''
        ) {
          const content = editor.getTextCursorPosition().block.content
          if (Array.isArray(content) && content.length === 0) {
            e.preventDefault()
            ai('')
          }
        }
      }}
    >
      <input
        ref={uploadInput}
        type="file"
        accept={noteMediaAccept}
        className="hidden"
        onChange={handleFileUpload}
      />
      <BlockNoteViewRaw
        editor={editor}
        theme={theme}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        filePanel={false}
        tableHandles={false}
        emojiPicker={false}
        comments={false}
        onChange={() => {
          if (ready.current) latest.current.onChange(editor.document as NoteBlock[])
        }}
        onSelectionChange={() => {
          if (!ready.current || !latest.current.onFocusBlock) return
          try {
            latest.current.onFocusBlock(editor.getTextCursorPosition().block.id)
          } catch {
            // No text cursor (a node selection on a card).
          }
        }}
      >
        <NoteThreadMarkers
          editor={editor}
          container={containerEl}
          threads={threads}
          activeSessionId={activeThread?.sessionId ?? null}
          activeBlockId={activeThread?.blockId ?? null}
          interactive={threadsInteractive}
          onOpen={onOpenThread}
          onDelete={onDeleteThread}
          onAsk={blockId => latest.current.onAI({ blockId })}
        />
        {activeThread && (
          // The line the open conversation is about stays marked while it is open.
          <style>{`.dt-note-editor .bn-block[data-id="${CSS.escape(activeThread.blockId)}"] .bn-block-content { background: var(--dt-note-anchor-bg); box-shadow: -6px 0 0 var(--dt-note-anchor-bg), 6px 0 0 var(--dt-note-anchor-bg); border-radius: 4px; }`}</style>
        )}
        <NoteInlineReviews
          editor={editor}
          suggestions={suggestions}
          busy={reviewBusy}
          errors={reviewErrors}
          onReview={onReview}
          onDiscuss={onDiscuss}
          onContinueResearch={onContinueResearch}
        />
        <FormattingToolbarController formattingToolbar={renderToolbar} />
        <SideMenuController
          sideMenu={() => <NoteEditorHandles editor={editor} />}
          floatingUIOptions={SIDE_MENU_FLOATING}
        />
        {['/', ', '].map(trigger => (
          <SuggestionMenuController
            key={trigger}
            triggerCharacter={trigger}
            shouldOpen={tr => {
              const parent = tr.selection.$from.parent
              return (
                !parent.type.spec.code &&
                !parent.type.isInGroup('tableContent') &&
                (trigger !== ', ' || parent.textContent.length === 0)
              )
            }}
            getItems={getItems}
            suggestionMenuComponent={NoteInsertMenu}
          />
        ))}
        {['[[', '@'].map(trigger => (
          <SuggestionMenuController
            key={trigger}
            triggerCharacter={trigger}
            getItems={async (query: string): Promise<NoteMenuItem[]> =>
              trigger === '[['
                ? pageItems(query)
                : [
                    {
                      title: "Reference a source",
                      preview: 'source' as const,
                      onItemClick: () =>
                        container.current?.dispatchEvent(
                          new CustomEvent('note-sources', { bubbles: true })
                        ),
                    },
                    {
                      title: "Insert favorite",
                      preview: 'favorite' as const,
                      onItemClick: () =>
                        container.current?.dispatchEvent(
                          new CustomEvent('note-favorites', { bubbles: true })
                        ),
                    },
                    ...(await pageItems(query)),
                  ]
            }
            suggestionMenuComponent={NoteInsertMenu}
          />
        ))}
      </BlockNoteViewRaw>
      <NoteTableControls editor={editor} />
    </div>
  )
}
