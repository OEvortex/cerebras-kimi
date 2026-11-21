import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import NotePageTree from '@/features/notes/components/NotePageTree'
import type { NoteSummary } from '@/lib/notes-api'

const pages = [
  { id: 'root', title: 'Root', parent_id: null },
  { id: 'child', title: 'Child page', parent_id: 'root' },
] as NoteSummary[]

function renderTree(handlers: {
  onRename?: (id: string, title: string) => void
  onDuplicate?: (id: string) => void
  onDelete?: (id: string) => void
} = {}) {
  const onNavigate = vi.fn((event: React.MouseEvent) => event.preventDefault())
  render(
    <NotePageTree
      pages={pages}
      currentId="child"
      busy={false}
      onNavigate={onNavigate}
      onCreate={vi.fn()}
      {...handlers}
    />
  )
  return onNavigate
}

it('offers rename, duplicate and a confirmed delete on a tree row', () => {
  const onRename = vi.fn()
  const onDuplicate = vi.fn()
  const onDelete = vi.fn()
  renderTree({ onRename, onDuplicate, onDelete })

  fireEvent.click(screen.getByRole('button', { name: 'Page actions for Child page' }))
  expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy()

  fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
  expect(onDuplicate).toHaveBeenCalledWith('child')

  fireEvent.click(screen.getByRole('button', { name: 'Page actions for Child page' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
  expect(screen.getByText(/Delete “Child page”/)).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete page' }))
  expect(onDelete).toHaveBeenCalledWith('child')
})

it('renames a page inline and keeps the tree readable', () => {
  const onRename = vi.fn()
  renderTree({ onRename })

  fireEvent.click(screen.getByRole('button', { name: 'Page actions for Child page' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
  const input = screen.getByRole('textbox', { name: 'Rename Child page' })
  fireEvent.change(input, { target: { value: 'Renamed page' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onRename).toHaveBeenCalledWith('child', 'Renamed page')
})
