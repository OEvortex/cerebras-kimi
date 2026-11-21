import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NoteHistoryPanel from '@/features/notes/components/NoteHistoryPanel'
import { restoreNoteVersion } from '@/features/notes/model/note-versions'
import type { NotePage } from '@/lib/notes-api'

vi.mock('@/shared/router/dynamic', () => ({
  default: () => function Markdown() {
    return <div data-testid="markdown-preview" />
  },
}))

const versions = [
  {
    id: 'aaaaaaaaaaaa',
    doc_id: 'page123456',
    revision: 3,
    created_at: 1760000000,
    source: 'save',
    title: 'Fourier',
    char_count: 40,
    word_count: 7,
  },
  {
    id: 'bbbbbbbbbbbb',
    doc_id: 'page123456',
    revision: 1,
    created_at: 1750000000,
    source: 'create',
    title: 'Fourier',
    char_count: 12,
    word_count: 2,
  },
]

vi.mock('@/features/notes/model/note-versions', () => ({
  listNoteVersions: vi.fn(async () => ({ versions, total: versions.length })),
  getNoteVersion: vi.fn(async (_docId: string, id: string) => ({
    ...versions.find((version) => version.id === id),
    content: id === 'aaaaaaaaaaaa' ? 'The cell powers the pump.' : 'Old text.',
    blocks: [],
  })),
  createNoteVersion: vi.fn(async () => versions[0]),
  restoreNoteVersion: vi.fn(async () => ({})),
  versionSourceLabel: (source: string) => source,
}))

const page: NotePage = {
  id: 'page123456',
  title: 'Fourier',
  content: 'The cell drives the pump.',
  blocks: [],
  parent_id: null,
  icon: '',
  cover: '',
  pinned: false,
  revision: 3,
  created_at: 1,
  updated_at: 1,
}

function renderPanel() {
  return render(
    <NoteHistoryPanel
      docId={page.id}
      page={page}
      open
      onClose={vi.fn()}
      onRestore={vi.fn()}
    />
  )
}

describe('NoteHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists versions and switches between preview and visual diff', async () => {
    renderPanel()
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /ago/ }).length).toBe(2)
    })
    expect(screen.getByRole('button', { name: /Current/ })).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('markdown-preview')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Show changes' }))
    const diff = screen.getByRole('region', { name: 'Changes between versions' })
    expect(diff.textContent).toContain('powers')
    expect(diff.textContent).toContain('drives')
    fireEvent.click(screen.getByRole('button', { name: 'Show preview' }))
    expect(screen.queryByRole('region', { name: 'Changes between versions' })).toBeNull()
  })

  it('restores the selected version with a confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onRestore = vi.fn(async () => undefined)
    render(
      <NoteHistoryPanel
        docId={page.id}
        page={page}
        open
        onClose={vi.fn()}
        onRestore={onRestore}
      />
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Restore version' }).hasAttribute('disabled')
      ).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Restore version' }))
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
    expect(onRestore.mock.calls[0][0].id).toBe('aaaaaaaaaaaa')
    expect(confirm).toHaveBeenCalled()
    expect(restoreNoteVersion).not.toHaveBeenCalled()
  })
})
