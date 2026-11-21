'use client'

import { useCallback, type MutableRefObject, type RefObject } from 'react'
import type { PartialBlock } from '@blocknote/core'
import { SuggestionMenu } from '@blocknote/core/extensions'
import { getDefaultReactSlashMenuItems } from '@blocknote/react'
import {
  BookOpen,
  Bookmark,
  CalendarDays,
  Columns2,
  FileCode,
  FileText,
  Film,
  Globe,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Info,
  ListTree,
  Music,
  Sigma,
  Sparkles,
  Table2,
  Upload,
} from 'lucide-react'

import { createNote, listNotes } from '@/lib/notes-api'
import {
  basicPreviewKinds,
  isBasicPreviewKind,
  type BlockPreviewKind,
} from '../../model/block-previews'
import { LEARNING_KINDS } from '../../model/learning-kinds'
import { noteMediaAccept } from '../../model/media'
import type { NoteMenuItem } from '../NoteInsertMenu'
import type { NotesEditor, schema } from './schema'

const SHORTCUTS: Record<string, string> = {
  heading: '#',
  heading_2: '##',
  heading_3: '###',
  heading_4: '####',
  bullet_list: '-',
  numbered_list: '1.',
  check_list: '[]',
  toggle_list: '>',
  quote: '"',
  code_block: '```',
  divider: '---',
}

interface UseNoteSlashItemsOptions {
  editor: NotesEditor
  pageId: string
  containerRef: RefObject<HTMLDivElement | null>
  uploadInputRef: RefObject<HTMLInputElement | null>
  uploadAnchorRef: MutableRefObject<string | null>
  uploadRetryRef: MutableRefObject<string | null>
  onAI: (instruction: string) => void
}

export default function useNoteSlashItems({
  editor,
  pageId,
  containerRef,
  uploadInputRef,
  uploadAnchorRef,
  uploadRetryRef,
  onAI,
}: UseNoteSlashItemsOptions) {
  

  const getItems = useCallback(
    async (query: string): Promise<NoteMenuItem[]> => {
      const insert = (block: Record<string, unknown>) => {
        const current = editor.getTextCursorPosition().block
        const empty =
          current.type === 'paragraph' && (!current.content || current.content.length === 0)
        const [created] = empty
          ? editor.replaceBlocks(
              [current],
              [
                block as PartialBlock<
                  typeof schema.blockSchema,
                  typeof schema.inlineContentSchema,
                  typeof schema.styleSchema
                >,
              ]
            ).insertedBlocks
          : editor.insertBlocks(
              [
                block as PartialBlock<
                  typeof schema.blockSchema,
                  typeof schema.inlineContentSchema,
                  typeof schema.styleSchema
                >,
              ],
              current,
              'after'
            )
        if (created) {
          // Form blocks own focus. Focusing the editor here immediately blurs an
          // auto-focused formula input and closes it before the user can type.
          if (['math', 'webCard', 'htmlEmbed', 'learning'].includes(created.type)) {
            // SuggestionMenu restores editor focus after the insertion callback.
            // Hand it to the new form after that transaction and React commit.
            requestAnimationFrame(() => {
              containerRef.current
                ?.querySelector<HTMLElement>(
                  `[data-id="${CSS.escape(created.id)}"] input, [data-id="${CSS.escape(created.id)}"] textarea`
                )
                ?.focus()
            })
          } else {
            const target =
              created.type === 'noteColumns'
                ? created.children?.[0]?.children?.[0]?.id || created.id
                : created.id
            editor.setTextCursorPosition(target, 'start')
            editor.focus()
          }
        }
        return created
      }

      const item = (
        title: string,
        group: string,
        subtext: string,
        aliases: string[],
        Icon: typeof Info,
        action: () => void,
        preview: BlockPreviewKind,
        shortcut?: string
      ): NoteMenuItem => ({
        title: (title),
        group: (group),
        subtext: (subtext),
        aliases,
        icon: <Icon size={19} strokeWidth={1.6} />,
        onItemClick: action,
        preview,
        shortcut,
      })

      const defaults = getDefaultReactSlashMenuItems(editor).flatMap(i => {
        const key = (i as { key?: string }).key || ''
        return isBasicPreviewKind(key)
          ? [{ ...i, preview: key, group: "Basic blocks", shortcut: SHORTCUTS[key] }]
          : []
      })
      defaults.sort(
        (a, b) => basicPreviewKinds.indexOf(a.preview) - basicPreviewKinds.indexOf(b.preview)
      )

      const items: NoteMenuItem[] = [
        item(
          'Ask Dito',
          'Suggested',
          'Write, explain or improve this part of your note.',
          ['ai', 'generate', 'continue'],
          Sparkles,
          () => onAI(''),
          'ai'
        ),
        item(
          'Reference a source',
          'Suggested',
          'Bring in a passage from your reading, chats or knowledge bases.',
          ['source', 'reference', 'knowledge'],
          BookOpen,
          () =>
            containerRef.current?.dispatchEvent(new CustomEvent('note-sources', { bubbles: true })),
          'source'
        ),
        item(
          'Insert favorite',
          'Suggested',
          'Keep an original answer with its source.',
          ['favorite', 'favorite'],
          Bookmark,
          () =>
            containerRef.current?.dispatchEvent(
              new CustomEvent('note-favorites', { bubbles: true })
            ),
          'favorite'
        ),
        ...defaults,
        item(
          'Callout',
          'Basic blocks',
          'Highlight a key idea, tip or warning.',
          ['callout', 'annotation', 'note'],
          Info,
          () => insert({ type: 'callout' }),
          'callout'
        ),
        item(
          'Page link',
          'Basic blocks',
          'Link to another notebook page.',
          ['page', 'page', 'link'],
          FileText,
          () => editor.getExtension(SuggestionMenu)?.openSuggestionMenu('[['),
          'pageLink'
        ),
        item(
          'Turn into sub-page',
          'Basic blocks',
          'Move the selected blocks into a new page under this one.',
          ['subpage', 'sub-page', 'child page', 'page'],
          FileText,
          () => {
            void (async () => {
              const selection = editor.getSelection()?.blocks ?? []
              const blocks = (selection.length ? selection : editor.document.slice(0, 1)).map(
                b => JSON.parse(JSON.stringify(b)) as Record<string, unknown>
              )
              if (!blocks.length) return
              const title =
                blocks
                  .map(b => {
                    const c = (b as { content?: unknown }).content
                    const text = Array.isArray(c)
                      ? c.map(i => (i && typeof i === 'object' && 'text' in i ? String((i as { text?: string }).text ?? '') : '')).join('')
                      : ''
                    return text.trim()
                  })
                  .find(Boolean) ?? 'Untitled'
              const child = await createNote(title.slice(0, 60), pageId)
              // Persist the moved blocks onto the child page.
              const { noteRequest } = await import('@/lib/notes-api')
              await noteRequest(`/${child.id}`, {
                method: 'PUT',
                body: JSON.stringify({ blocks, expected_revision: child.revision }),
              }).catch(() => undefined)
              const ids = new Set(blocks.map(b => String((b as { id?: string }).id ?? '')))
              editor.removeBlocks([...ids])
              editor.insertInlineContent([
                { type: 'pageLink', props: { pageId: child.id, title: child.title } },
                ' ',
              ])
            })()
          },
          'pageLink'
        ),
        ...(
          [
            ['image', 'Image', ImageIcon, 'image/png,image/jpeg,image/gif,image/webp', 'image'],
            ['video', 'Video', Film, 'video/mp4', 'video'],
            ['audio', 'Audio', Music, 'audio/mpeg,audio/wav', 'audio'],
            ['file', 'File', Upload, noteMediaAccept, 'file'],
          ] as const
        ).map(([key, label, Icon, accept, alias]) =>
          item(
            label,
            'Media',
            'Upload a file to this page.',
            [key, alias],
            Icon,
            () => {
              if (uploadInputRef.current) {
                uploadAnchorRef.current = editor.getTextCursorPosition().block.id
                uploadRetryRef.current = null
                uploadInputRef.current.accept = accept
                uploadInputRef.current.click()
              }
            },
            key
          )
        ),
        item(
          'Web bookmark',
          'Media',
          'Save a link with a title and a short description.',
          ['bookmark', 'bookmark'],
          Bookmark,
          () => insert({ type: 'webCard' }),
          'bookmark'
        ),
        item(
          'Embed',
          'Media',
          'Display an external page that allows embedding.',
          ['embed', 'embed'],
          Globe,
          () => insert({ type: 'webCard', props: { mode: 'embed' } }),
          'embed'
        ),
        item(
          'HTML',
          'Media',
          'Preview HTML inside an isolated frame.',
          ['html', 'web page'],
          FileCode,
          () => insert({ type: 'htmlEmbed' }),
          'htmlEmbed'
        ),
        ...(['table', 'board', 'list'] as const).map(view =>
          item(
            { table: 'Task table', board: 'Task board', list: 'Task list' }[view],
            'Linked views',
            'View and update tasks from this workspace.',
            ['task', view, 'task', { table: 'table', board: 'board', list: 'list' }[view]],
            Table2,
            () => insert({ type: 'taskView', props: { view } }),
            `task_${view}`
          )
        ),
        item(
          'Table of contents',
          'Advanced blocks',
          'Jump to headings; updates as your page changes.',
          ['toc', 'table of contents'],
          ListTree,
          () => insert({ type: 'tableOfContents' }),
          'toc'
        ),
        item(
          'Math formula',
          'Advanced blocks',
          'Write a mathematical expression using LaTeX.',
          ['math', 'formula'],
          Sigma,
          () => insert({ type: 'math' }),
          'math',
          '$$'
        ),
        ...([1, 2, 3] as const).map(level =>
          item(
            `Toggle heading ${level}`,
            'Advanced blocks',
            'Keep supporting notes inside a collapsible heading.',
            ['toggle', 'toggle', `h${level}`],
            [Heading1, Heading2, Heading3][level - 1],
            () =>
              insert({ type: 'toggleHeading', props: { level }, children: [{ type: 'paragraph' }] }),
            `toggle_heading_${level}`
          )
        ),
        ...([2, 3, 4, 5] as const).map(count =>
          item(
            `${count} columns`,
            'Advanced blocks',
            'Arrange related ideas side by side. Stacks on small screens.',
            ['columns', 'column', String(count)],
            Columns2,
            () =>
              insert({
                type: 'noteColumns',
                children: Array.from({ length: count }, () => ({
                  type: 'noteColumn',
                  children: [{ type: 'paragraph' }],
                })),
              }),
            `columns_${count}`
          )
        ),
        item(
          'Date',
          'Inline',
          'Add an editable date in your text.',
          ['date', 'date'],
          CalendarDays,
          () =>
            editor.insertInlineContent([
              { type: 'noteDate', props: { date: new Date().toLocaleDateString('en-CA') } },
              ' ',
            ]),
          'date'
        ),
        item(
          'Inline formula',
          'Inline',
          'Place a formula within a sentence.',
          ['inline math', 'inline formula'],
          Sigma,
          () => editor.insertInlineContent([{ type: 'inlineMath', props: { formula: 'x^2' } }, ' ']),
          'inlineMath',
          '$…$'
        ),
        ...LEARNING_KINDS.map(({ kind, label, alias, Icon }) =>
          item(
            label,
            'Learning',
            'Create learning material grounded in this page.',
            [kind, alias],
            Icon,
            () => {
              insert({ type: 'learning', props: { kind } })
            },
            ({ image: 'generated_image', audio: 'podcast' }[kind] || kind) as BlockPreviewKind
          )
        ),
      ]

      const needle = query.toLowerCase().trim()
      return items.filter(i =>
        [i.title, ...(i.aliases || [])].some(label => label.toLowerCase().includes(needle))
      )
    },
    [containerRef, editor, onAI, uploadAnchorRef, uploadInputRef, uploadRetryRef]
  )

  const pageItems = useCallback(
    async (query: string): Promise<NoteMenuItem[]> => {
      const { documents } = await listNotes()
      return documents
        .filter(d => d.id !== pageId && d.title.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 15)
        .map(d => ({
          title: d.title,
          preview: 'pageLink' as const,
          previewTitle: d.title,
          subtext: "Open linked page",
          icon: <FileText size={19} />,
          onItemClick: () =>
            editor.insertInlineContent([
              { type: 'pageLink', props: { pageId: d.id, title: d.title } },
              ' ',
            ]),
        }))
    },
    [editor, pageId]
  )

  return { getItems, pageItems }
}
