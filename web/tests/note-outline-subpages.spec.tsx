import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import NoteOutline from '@/features/notes/components/NoteOutline'
import type { NoteBlock, NoteSummary } from '@/lib/notes-api'

const blocks: NoteBlock[] = [
  {
    id: 'h1',
    type: 'heading',
    props: { level: 1 },
    content: [{ type: 'text', text: 'Unit II', styles: {} }],
  },
]

const subpages = [
  { id: 'child-a', title: 'Emission processes', parent_id: 'parent' },
  { id: 'child-b', title: 'Ruby laser', parent_id: 'parent' },
] as NoteSummary[]

it('offers the current page subpages in the outline so one can switch to them', () => {
  const onNavigateSubpage = vi.fn((event: React.MouseEvent) => event.preventDefault())
  const onCreateSubpage = vi.fn()
  render(
    <NoteOutline
      blocks={blocks}
      scroller={null}
      open
      roomy
      onToggle={vi.fn()}
      onJump={vi.fn()}
      subpages={subpages}
      onNavigateSubpage={onNavigateSubpage}
      onCreateSubpage={onCreateSubpage}
    />
  )

  expect(screen.getByRole('navigation', { name: 'On this page' })).toBeTruthy()
  expect(screen.getByText('Subpages')).toBeTruthy()
  const link = screen.getByRole('link', { name: 'Emission processes' })
  expect(link).toHaveAttribute('href', '/co-writer/child-a')
  fireEvent.click(link)
  expect(onNavigateSubpage).toHaveBeenCalledWith(expect.anything(), 'child-a')
  fireEvent.click(screen.getByRole('button', { name: 'New subpage' }))
  expect(onCreateSubpage).toHaveBeenCalledOnce()
})

it('still renders the outline when a page only has subpages and no headings', () => {
  render(
    <NoteOutline
      blocks={[]}
      scroller={null}
      open
      roomy
      onToggle={vi.fn()}
      onJump={vi.fn()}
      subpages={subpages}
    />
  )
  expect(screen.getByRole('link', { name: 'Ruby laser' })).toBeTruthy()
})
