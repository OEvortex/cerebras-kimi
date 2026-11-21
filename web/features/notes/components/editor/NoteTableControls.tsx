'use client'

import '../note-table-controls.css'

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Copy,
  GripHorizontal,
  GripVertical,
  Palette,
  Plus,
  Search,
  Table2,
  Trash2,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { NotesEditor } from './schema'

interface Rect {
  top: number
  left: number
  width: number
  height: number
  right: number
  bottom: number
}

interface Position {
  cell: Rect | null
  table: Rect | null
  row: number
  column: number
  blockId: string | null
}

const EMPTY: Position = {
  cell: null,
  table: null,
  row: 0,
  column: 0,
  blockId: null,
}

const COLORS = [
  ['default', 'Default'],
  ['gray', 'Gray'],
  ['brown', 'Brown'],
  ['red', 'Red'],
  ['orange', 'Orange'],
  ['yellow', 'Yellow'],
  ['green', 'Green'],
  ['blue', 'Blue'],
  ['purple', 'Purple'],
  ['pink', 'Pink'],
] as const

interface CellData {
  type?: string
  props?: Record<string, unknown>
  content?: unknown[]
}

interface TableData {
  type: 'tableContent'
  columnWidths: (number | undefined)[]
  headerRows?: number
  headerCols?: number
  rows: { cells: (CellData | unknown[])[] }[]
}

function newCell(): CellData {
  return {
    type: 'tableCell',
    props: {
      colspan: 1,
      rowspan: 1,
      backgroundColor: 'default',
      textColor: 'default',
      textAlignment: 'left',
    },
    content: [],
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export default function NoteTableControls({ editor }: { editor: NotesEditor }) {
  const root = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [position, setPosition] = useState<Position>(EMPTY)
  const [menu, setMenu] = useState<'row' | 'column' | null>(null)
  const [menuAt, setMenuAt] = useState({ top: 0, left: 0 })
  const [colors, setColors] = useState(false)
  const [query, setQuery] = useState('')

  const update = useCallback(() => {
    const base = root.current
    const tiptap = editor._tiptapEditor
    if (!base || !tiptap || tiptap.isDestroyed) {
      setPosition(EMPTY)
      return
    }
    const { from } = tiptap.state.selection
    let element: HTMLElement | null
    try {
      const dom = tiptap.view.domAtPos(from)
      element = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement
    } catch {
      setPosition(EMPTY)
      return
    }
    const cell = element?.closest('td, th') as HTMLTableCellElement | null
    const row = cell?.closest('tr') as HTMLTableRowElement | null
    const table = cell?.closest('table') as HTMLTableElement | null
    const outer = cell?.closest('.bn-block-outer') as HTMLElement | null
    if (!cell || !table || !outer) {
      setPosition(EMPTY)
      setMenu(null)
      setColors(false)
      return
    }
    const baseRect = base.getBoundingClientRect()
    const cellRect = cell.getBoundingClientRect()
    const tableRect = table.getBoundingClientRect()
    const relative = (rect: DOMRect): Rect => ({
      top: rect.top - baseRect.top,
      left: rect.left - baseRect.left,
      width: rect.width,
      height: rect.height,
      right: rect.right - baseRect.left,
      bottom: rect.bottom - baseRect.top,
    })
    setPosition({
      cell: relative(cellRect),
      table: relative(tableRect),
      row: row?.rowIndex ?? 0,
      column: cell.cellIndex,
      blockId: outer.dataset.id || null,
    })
  }, [editor])

  useLayoutEffect(() => {
    update()
  }, [update])

  useEffect(() => {
    const tiptap = editor._tiptapEditor
    const close = () => {
      setMenu(null)
      setColors(false)
      setQuery('')
    }
    const unsubscribe = editor.onSelectionChange(update)
    tiptap.on('update', update)
    tiptap.on('focus', update)
    tiptap.on('blur', close)
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => {
      unsubscribe()
      tiptap.off('update', update)
      tiptap.off('focus', update)
      tiptap.off('blur', close)
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
    }
  }, [editor, update])

  useEffect(() => {
    if (menu && searchRef.current) searchRef.current.focus()
  }, [menu, colors])

  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return
      setMenu(null)
      setColors(false)
      setQuery('')
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [menu])

  const tableBlock = () => {
    const block = position.blockId ? editor.getBlock(position.blockId) : null
    if (!block || block.type !== 'table') return null
    return block
  }

  const changeTable = (mutate: (content: TableData, rows: number, columns: number) => boolean | void) => {
    const block = tableBlock()
    if (!block) return
    const content = clone(block.content as unknown as TableData)
    const columns = content.rows[0]?.cells.length || 0
    if (mutate(content, content.rows.length, columns) === false) return
    editor.updateBlock(block, { content } as never)
    setMenu(null)
    setColors(false)
    setQuery('')
    requestAnimationFrame(update)
  }

  const setColor = (color: string) => {
    changeTable((content) => {
      const paint = (cells: (CellData | unknown[])[], index: number) => {
        const cell = cells[index]
        if (!cell) return
        const target = Array.isArray(cell) ? newCellWithContent(cell) : cell
        target.props = { ...target.props, backgroundColor: color }
        cells[index] = target
      }
      if (menu === 'row') {
        const cells = content.rows[position.row]?.cells || []
        cells.forEach((_, index) => paint(cells, index))
      } else if (menu === 'column') {
        for (const row of content.rows) paint(row.cells, position.column)
      } else {
        paint(content.rows[position.row]?.cells || [], position.column)
      }
    })
  }

  const openMenu = (type: 'row' | 'column', at: { top: number; left: number }) => {
    setMenu(type)
    setMenuAt(at)
    setColors(false)
    setQuery('')
  }

  const actions = (type: 'row' | 'column') => {
    const isRow = type === 'row'
    const label = (text: string) => (isRow ? `${text} row` : `${text} column`)
    return [
      {
        icon: isRow ? Table2 : Palette,
        label: isRow ? 'Header row' : 'Header column',
        run: () =>
          changeTable((content) => {
            if (isRow) content.headerRows = content.headerRows ? 0 : 1
            else content.headerCols = content.headerCols ? 0 : 1
          }),
      },
      {
        icon: Palette,
        label: 'Color',
        submenu: true,
        run: () => setColors(!colors),
      },
      {
        icon: isRow ? ArrowDown : ArrowRight,
        label: label('Insert after'),
        run: () =>
          changeTable((content, rows, columns) => {
            const index = (isRow ? position.row : position.column) + 1
            if (isRow) {
              content.rows.splice(index, 0, {
                cells: Array.from({ length: columns }, () => newCell()),
              })
            } else {
              for (const row of content.rows) row.cells.splice(index, 0, newCell())
              content.columnWidths.splice(index, 0, undefined)
            }
          }),
      },
      {
        icon: isRow ? ArrowUp : ArrowLeft,
        label: label('Insert before'),
        run: () =>
          changeTable((content, rows, columns) => {
            const index = isRow ? position.row : position.column
            if (isRow) {
              content.rows.splice(index, 0, {
                cells: Array.from({ length: columns }, () => newCell()),
              })
            } else {
              for (const row of content.rows) row.cells.splice(index, 0, newCell())
              content.columnWidths.splice(index, 0, undefined)
            }
          }),
      },
      {
        icon: Copy,
        label: label('Duplicate'),
        run: () =>
          changeTable((content, rows, columns) => {
            const index = isRow ? position.row : position.column
            if (isRow) {
              const source = content.rows[index]
              if (!source) return false
              content.rows.splice(index + 1, 0, clone(source))
            } else {
              if (columns < 1) return false
              for (const row of content.rows) {
                const cell = row.cells[index]
                row.cells.splice(index + 1, 0, cell ? clone(cell) : newCell())
              }
              content.columnWidths.splice(index + 1, 0, content.columnWidths[index])
            }
          }),
      },
      {
        icon: XCircle,
        label: label('Clear contents'),
        run: () =>
          changeTable((content) => {
            if (isRow) {
              for (const cell of content.rows[position.row]?.cells || []) {
                if (Array.isArray(cell)) continue
                cell.content = []
              }
            } else {
              for (const row of content.rows) {
                const cell = row.cells[position.column]
                if (cell && !Array.isArray(cell)) cell.content = []
              }
            }
          }),
      },
      {
        icon: Trash2,
        label: label('Delete'),
        danger: true,
        run: () =>
          changeTable((content, rows, columns) => {
            const count = isRow ? rows : columns
            if (count <= 1) {
              const block = tableBlock()
              if (block) editor.removeBlocks([block.id])
              return false
            }
            const index = isRow ? position.row : position.column
            if (isRow) content.rows.splice(index, 1)
            else {
              for (const row of content.rows) row.cells.splice(index, 1)
              content.columnWidths.splice(index, 1)
            }
          }),
      },
    ]
  }

  const { cell, table } = position
  if (!cell || !table) return <div ref={root} className="dt-note-table-controls" aria-hidden />

  const items = actions(menu || 'row').filter(
    (item) => !query || item.label.toLowerCase().includes(query.toLowerCase())
  )
  const width = Math.min(cell.width, 240)

  return (
    <div ref={root} className="dt-note-table-controls">
      <button
        type="button"
        className="dt-note-table-grip is-column"
        style={{ top: table.top - 26, left: cell.left, width }}
        title="Column options"
        aria-label="Column options"
        onClick={() => openMenu('column', { top: table.top - 26, left: cell.left })}
      >
        <GripHorizontal size={14} />
      </button>
      <button
        type="button"
        className="dt-note-table-grip is-row"
        style={{ top: cell.top, left: table.left - 26, height: cell.height }}
        title="Row options"
        aria-label="Row options"
        onClick={() => openMenu('row', { top: cell.top, left: table.left - 26 })}
      >
        <GripVertical size={14} />
      </button>
      <button
        type="button"
        className="dt-note-table-add is-column"
        style={{ top: cell.top, left: table.right + 6, height: cell.height }}
        title="Add column"
        aria-label="Add column"
        onClick={() =>
          changeTable((content) => {
            for (const row of content.rows) row.cells.push(newCell())
            content.columnWidths.push(undefined)
          })
        }
      >
        <Plus size={15} />
      </button>
      <button
        type="button"
        className="dt-note-table-add is-row"
        style={{ top: table.bottom + 6, left: cell.left, width }}
        title="Add row"
        aria-label="Add row"
        onClick={() =>
          changeTable((content, rows, columns) => {
            content.rows.push({
              cells: Array.from({ length: columns }, () => newCell()),
            })
          })
        }
      >
        <Plus size={15} />
      </button>
      <div
        className="dt-note-table-active-cell"
        style={{ top: cell.top - 1, left: cell.left - 1, width: cell.width + 2, height: cell.height + 2 }}
      />

      {menu && (
        <div
          className="dt-note-table-menu"
          style={{ top: menuAt.top + 26, left: Math.max(4, Math.min(menuAt.left, (root.current?.clientWidth || 600) - 240)) }}
          role="menu"
        >
          <div className="dt-note-table-search">
            <Search size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search actions…"
              aria-label="Search table actions"
            />
          </div>
          <div className="dt-note-table-menu-list">
            {items.map((item, index) => {
              const Icon = item.icon
              return (
                <button
                  key={`${item.label}-${index}`}
                  type="button"
                  role="menuitem"
                  className={item.danger ? 'is-danger' : undefined}
                  onClick={item.run}
                >
                  <Icon size={15} />
                  <span>{item.label}</span>
                  {item.submenu && <ChevronRight size={14} />}
                </button>
              )
            })}
            {!items.length && <p className="dt-note-table-empty">No actions found</p>}
          </div>
          {colors && (
            <div className="dt-note-table-colors" role="menu" aria-label="Cell background color">
              <span>Background</span>
              {COLORS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="menuitem"
                  data-color={value}
                  onClick={() => setColor(value)}
                >
                  <i data-color={value} />
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function newCellWithContent(content: unknown[]): CellData {
  return { ...newCell(), content: clone(content) }
}
