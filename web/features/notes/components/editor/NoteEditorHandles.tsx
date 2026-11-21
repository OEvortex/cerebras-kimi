'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SideMenuExtension, SuggestionMenu } from '@blocknote/core/extensions'
import { useExtension, useExtensionState } from '@blocknote/react'
import { closeHistory } from '@tiptap/pm/history'
import {
  ArrowDown,
  ArrowUp,
  Copy,
  GripVertical,
  ListTree,
  Plus,
  RefreshCcw,
  Trash2,
} from 'lucide-react'

import type { NoteBlock } from '@/lib/notes-api'
import Tooltip from '@/shared/ui/Tooltip'
import { learningGenerationConfig } from '../../model/learning-kinds'
import useNoteBlockDrag from '../useNoteBlockDrag'
import type { NotesEditor, schema } from './schema'

/** BlockNote nudges the side menu down by a guess at each heading level's
 *  line; the notebook's own type scale differs, so the handles measure the
 *  line themselves from the block's top instead. */
export const SIDE_MENU_FLOATING = { useFloatingOptions: { middleware: [] } }

const TABLE_ACTIONS = [
  'Add row',
  'Add column',
  'Remove last row',
  'Remove last column',
  'Toggle header row',
] as const

const BLOCK_CONVERSIONS = [
  ['paragraph', 'Text'],
  ['heading', 'Heading'],
  ['bulletListItem', 'Bullet list'],
  ['checkListItem', 'To-do list'],
] as const

function applyTableAction(
  editor: NotesEditor,
  blockId: string,
  action: (typeof TABLE_ACTIONS)[number]
) {
  const table = editor.getBlock(blockId)
  if (table?.type !== 'table') return
  const content = structuredClone(table.content)
  if (action === 'Add row')
    content.rows.push({
      cells: Array.from({ length: content.rows[0]?.cells.length || 2 }, () => []),
    })
  if (action === 'Add column') {
    content.rows.forEach(r => {
      if (r.cells.every(c => Array.isArray(c))) r.cells = [...r.cells, []]
      else
        r.cells = r.cells
          .map(c =>
            Array.isArray(c)
              ? {
                  type: 'tableCell' as const,
                  props: {
                    colspan: 1,
                    rowspan: 1,
                    backgroundColor: 'default',
                    textColor: 'default',
                    textAlignment: 'left' as const,
                  },
                  content: c,
                }
              : c
          )
          .concat([
            {
              type: 'tableCell',
              props: {
                colspan: 1,
                rowspan: 1,
                backgroundColor: 'default',
                textColor: 'default',
                textAlignment: 'left',
              },
              content: [],
            },
          ])
    })
    content.columnWidths.push(undefined)
  }
  if (action === 'Remove last row' && content.rows.length > 1) content.rows.pop()
  if (action === 'Remove last column' && content.rows[0]?.cells.length > 1) {
    content.rows.forEach(r => r.cells.pop())
    content.columnWidths.pop()
  }
  if (action === 'Toggle header row') content.headerRows = content.headerRows ? 0 : 1
  editor.updateBlock(table, { content })
}

export default function NoteEditorHandles({ editor }: { editor: NotesEditor }) {
  
  const handleRoot = useRef<HTMLDivElement>(null)
  const menu = useExtension(SideMenuExtension)
  const block = useExtensionState(SideMenuExtension, { selector: state => state?.block })
  const [open, setOpen] = useState(false)
  const drag = useNoteBlockDrag(editor)
  const blockId = block?.id

  // Centre the handles on the block's first line of text, whatever its type
  // and font; a card without text keeps them level with its top edge. The
  // side menu sits at the block's top (see SIDE_MENU_FLOATING), so the
  // offset is measured from there. Written onto the node rather than kept in
  // state: it is a measurement of the DOM, and the menu re-renders on hover.
  useLayoutEffect(() => {
    const root = handleRoot.current
    if (!blockId || !root) return
    root.style.transform = ''
    const outer = editor.domElement?.querySelector<HTMLElement>(
      `.bn-block[data-id="${CSS.escape(blockId)}"]`
    )
    const content = outer?.querySelector<HTMLElement>(':scope > .bn-block-content')
    if (!outer || !content) return
    const top = outer.getBoundingClientRect().top
    const inline = content.querySelector<HTMLElement>('.bn-inline-content')
    let center = content.getBoundingClientRect().top - top + root.offsetHeight / 2
    if (inline) {
      const range = document.createRange()
      range.selectNodeContents(inline)
      const line = [...range.getClientRects()].find(rect => rect.height > 0)
      const box = inline.getBoundingClientRect()
      const style = getComputedStyle(inline)
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5
      center = line ? line.top + line.height / 2 - top : box.top + lineHeight / 2 - top
    }
    root.style.transform = `translateY(${center - root.offsetHeight / 2}px)`
  }, [blockId, editor])

  // A menu left open by a click elsewhere would keep the handles frozen on
  // this block, and no other block would show its own.
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof PointerEvent && handleRoot.current?.contains(event.target as Node))
        return
      setOpen(false)
      menu.unfreezeMenu()
    }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', close, true)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', close, true)
    }
  }, [menu, open])

  if (!block) return null

  const closeMenu = () => {
    setOpen(false)
    menu.unfreezeMenu()
  }

  return (
    <div ref={handleRoot} className="dt-note-handle">
      <Tooltip label={"Add below · Option-click to add above"}>
        <button
          aria-label={"Add block"}
          onClick={e => {
            const [next] = editor.insertBlocks(
              [{ type: 'paragraph' }],
              block.id,
              e.altKey ? 'before' : 'after'
            )
            if (next) editor.setTextCursorPosition(next.id, 'start')
            editor.getExtension(SuggestionMenu)?.openSuggestionMenu('/')
          }}
        >
          <Plus size={16} />
        </button>
      </Tooltip>
      <Tooltip label={"Drag or open block menu"}>
        <button
          aria-label={"Drag or open block menu"}
          className="dt-note-drag-handle"
          onPointerDown={event => drag.start(event, block.id)}
          onPointerMove={drag.move}
          onPointerUp={drag.end}
          onPointerCancel={drag.cancel}
          onClick={() => {
            if (drag.consumeClick()) return
            if (!open) editor.setTextCursorPosition(block.id, 'start')
            setOpen(!open)
            if (!open) menu.freezeMenu()
            else menu.unfreezeMenu()
          }}
        >
          <GripVertical size={16} />
        </button>
      </Tooltip>
      {drag.indicator}
      {open && (
        <div className="dt-note-menu" onMouseLeave={closeMenu}>
          {block.type === 'learning' && block.props.kind !== 'task' && (
            // A generated block shows only its material; asking for another
            // version opens a conversation with the old request to edit.
            <button
              onClick={() => {
                const props = block.props as { kind: string; prompt: string; data: string }
                editor.domElement
                  ?.querySelector(`[data-id="${CSS.escape(block.id)}"]`)
                  ?.dispatchEvent(
                    new CustomEvent('note-regenerate', {
                      bubbles: true,
                      detail: {
                        blockId: block.id,
                        kind: props.kind,
                        prompt: props.prompt,
                        config: learningGenerationConfig(props.kind, props.data),
                      },
                    })
                  )
                closeMenu()
              }}
            >
              <RefreshCcw size={14} />
              {"Regenerate…"}
            </button>
          )}
          {(['up', 'down'] as const).map(direction => (
            <button
              key={direction}
              onClick={() => {
                editor.transact(tr => closeHistory(tr))
                if (direction === 'up') editor.moveBlocksUp(block.id)
                else editor.moveBlocksDown(block.id)
                editor.transact(tr => closeHistory(tr))
                closeMenu()
              }}
            >
              {direction === 'up' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
              {(direction === 'up' ? 'Move up' : 'Move down')}
            </button>
          ))}
          {(['nest', 'unnest'] as const).map(action => (
            <button
              key={action}
              disabled={action === 'nest' ? !editor.canNestBlock() : !editor.canUnnestBlock()}
              onClick={() => {
                editor.transact(tr => closeHistory(tr))
                if (action === 'nest') editor.nestBlock()
                else editor.unnestBlock()
                editor.transact(tr => closeHistory(tr))
                closeMenu()
                editor.focus()
              }}
            >
              <ListTree size={14} />
              {editor.dictionary.formatting_toolbar[action].tooltip}
            </button>
          ))}
          <button
            onClick={() => {
              const original = editor.getBlock(block.id)
              if (original) {
                const duplicate = JSON.parse(JSON.stringify(original))
                const rekey = (b: NoteBlock) => {
                  b.id = crypto.randomUUID()
                  b.children?.forEach(rekey)
                }
                rekey(duplicate)
                editor.insertBlocks([duplicate], block.id, 'after')
              }
              closeMenu()
            }}
          >
            <Copy size={14} />
            {"Duplicate"}
          </button>
          <button
            onClick={() => {
              editor.removeBlocks([block.id])
              closeMenu()
            }}
          >
            <Trash2 size={14} />
            {"Delete"}
          </button>
          {block.type === 'table' &&
            TABLE_ACTIONS.map(action => (
              <button
                key={action}
                onClick={() => {
                  applyTableAction(editor, block.id, action)
                  closeMenu()
                }}
              >
                {(action)}
              </button>
            ))}
          {block.type === 'codeBlock' && (
            <button
              onClick={() => {
                const code = editor.getBlock(block.id)
                const text = Array.isArray(code?.content)
                  ? code.content.map(c => ('text' in c ? c.text : '')).join('')
                  : ''
                handleRoot.current?.dispatchEvent(
                  new CustomEvent('note-generate', {
                    bubbles: true,
                    detail: {
                      kind: 'code',
                      prompt: `Use exec only if it is enabled to run this code and report output in a comment. Do not claim execution if unavailable.\n${text}`,
                      blockId: block.id,
                    },
                  })
                )
                closeMenu()
              }}
            >
              {"Run code"}
            </button>
          )}
          {editor.schema.blockSchema[block.type as keyof typeof schema.blockSchema].content ===
            'inline' &&
            BLOCK_CONVERSIONS.map(([type, label]) => (
              <button
                key={type}
                onClick={() => {
                  editor.updateBlock(block.id, { type })
                  closeMenu()
                }}
              >
                {(label)}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
