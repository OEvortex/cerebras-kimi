import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceResourcePicker } from '@/components/workspaces/WorkspaceResourcePicker'
import { inheritedWorkspaceResources, type WorkspaceResources } from '@/lib/workspaces-api'
import { knowledgeBaseRef } from '@/lib/knowledge-helpers'

const fixture = vi.hoisted(() => ({ catalog: vi.fn() }))
vi.mock('@/lib/workspaces-api', async importOriginal => ({
  ...(await importOriginal<object>()),
  getWorkspaceResources: fixture.catalog,
}))
afterEach(cleanup)

function Picker({ initial = inheritedWorkspaceResources() }: { initial?: WorkspaceResources }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <WorkspaceResourcePicker value={value} onChange={setValue} />
      <output data-testid="policy">{JSON.stringify(value)}</output>
    </>
  )
}

it('preserves inherited access and supports an explicit empty selection per resource type', async () => {
  fixture.catalog.mockResolvedValue({
    skills: [],
    mcp: [],
    knowledge_bases: [{ id: 'account:kb:Math', name: 'Math', source: 'account' }],
  })
  render(<Picker />)
  expect(screen.getByTestId('policy')).toHaveTextContent('"knowledge_bases":null')
  fireEvent.change(screen.getByRole('combobox', { name: 'Knowledge bases assignment mode' }), {
    target: { value: 'selected' },
  })
  expect(screen.getByTestId('policy')).toHaveTextContent('"knowledge_bases":[]')
  fireEvent.click(await screen.findByRole('checkbox', { name: /Math/ }))
  expect(screen.getByTestId('policy')).toHaveTextContent('"knowledge_bases":["account:kb:Math"]')
  expect(screen.getByTestId('policy')).toHaveTextContent('"skills":null')
  fireEvent.change(screen.getByRole('combobox', { name: 'Knowledge bases assignment mode' }), {
    target: { value: 'inherit' },
  })
  expect(screen.getByTestId('policy')).toHaveTextContent('"knowledge_bases":null')
})

it('keeps stale selections visible and removable instead of silently enabling everything', async () => {
  fixture.catalog.mockResolvedValue({ skills: [], mcp: [], knowledge_bases: [] })
  render(<Picker initial={{ skills: [], mcp: [], knowledge_bases: ['deleted'] }} />)
  const missing = await screen.findByRole('checkbox', { name: /deleted/ })
  expect(missing).toBeChecked()
  fireEvent.click(missing)
  await waitFor(() => expect(screen.getByTestId('policy')).toHaveTextContent('"knowledge_bases":[]'))
})

it('keeps same-name KB identities distinct while preserving legacy names', () => {
  expect(knowledgeBaseRef({ id: 'account:kb:Math', name: 'Math' })).toBe('account:kb:Math')
  expect(knowledgeBaseRef({ id: 'workspace:ws_a:kb:Math', name: 'Math' })).toBe(
    'workspace:ws_a:kb:Math'
  )
  expect(knowledgeBaseRef({ id: 'user:kb:Math', name: 'Math' })).toBe('Math')
})
