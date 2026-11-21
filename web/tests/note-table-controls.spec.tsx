import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NoteTableControls from '@/features/notes/components/editor/NoteTableControls'

function tableFixture() {
  const outer = document.createElement('div')
  outer.className = 'bn-block-outer'
  outer.dataset.id = 'table-block'
  outer.innerHTML = `
    <table>
      <tbody>
        <tr><th>A</th><th>B</th></tr>
        <tr><td>1</td><td>2</td></tr>
      </tbody>
    </table>`
  // jsdom does not lay out nodes; keep the measurements deterministic.
  vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 400, 200)
  )
  vi.spyOn(outer.querySelector('td')!, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 30, 100, 30)
  )
  vi.spyOn(outer.querySelector('table')!, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 10, 200, 80)
  )
  return { outer, cell: outer.querySelector('td') as HTMLTableCellElement }
}

function editorFixture(cell: HTMLElement, block: Record<string, unknown>) {
  const updateBlock = vi.fn()
  const removeBlocks = vi.fn()
  return {
    editor: {
      _tiptapEditor: {
        isDestroyed: false,
        state: { selection: { from: 4 } },
        view: { domAtPos: () => ({ node: cell }) },
        on: vi.fn(),
        off: vi.fn(),
      },
      domElement: document.createElement('div'),
      onSelectionChange: () => () => undefined,
      getBlock: () => block,
      updateBlock,
      removeBlocks,
    },
    updateBlock,
    removeBlocks,
  }
}

const tableBlock = () => ({
  id: 'table-block',
  type: 'table',
  props: {},
  content: {
    type: 'tableContent',
    columnWidths: [undefined, undefined],
    headerRows: 1,
    rows: [
      { cells: [{ type: 'tableCell', props: {}, content: ['A'] }, { type: 'tableCell', props: {}, content: ['B'] }] },
      { cells: [{ type: 'tableCell', props: {}, content: ['1'] }, { type: 'tableCell', props: {}, content: ['2'] }] },
    ],
  },
})

describe('NoteTableControls', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('adds a row through the row action menu', () => {
    const { outer, cell } = tableFixture()
    document.body.appendChild(outer)
    const { editor, updateBlock } = editorFixture(cell, tableBlock())
    render(<NoteTableControls editor={editor as never} />)

    fireEvent.click(screen.getByRole('button', { name: 'Row options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert after row' }))

    expect(updateBlock).toHaveBeenCalledTimes(1)
    const content = updateBlock.mock.calls[0][1].content
    expect(content.rows).toHaveLength(3)
  })

  it('adds a column through the add button', () => {
    const { outer, cell } = tableFixture()
    document.body.appendChild(outer)
    const { editor, updateBlock } = editorFixture(cell, tableBlock())
    render(<NoteTableControls editor={editor as never} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add column' }))
    const content = updateBlock.mock.calls[0][1].content
    expect(content.rows[0].cells).toHaveLength(3)
    expect(content.columnWidths).toHaveLength(3)
  })

  it('paints a cell background from the color submenu', () => {
    const { outer, cell } = tableFixture()
    document.body.appendChild(outer)
    const { editor, updateBlock } = editorFixture(cell, tableBlock())
    render(<NoteTableControls editor={editor as never} />)

    fireEvent.click(screen.getByRole('button', { name: 'Row options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Color' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Blue' }))

    const content = updateBlock.mock.calls[0][1].content
    expect(content.rows[1].cells[0].props.backgroundColor).toBe('blue')
  })
})
