import { describe, expect, it } from 'vitest'
import { diffCounts, diffMarkdown } from '@/features/notes/model/notes-diff'

describe('notes-diff', () => {
  it('keeps unchanged lines intact with matching line numbers', () => {
    const lines = diffMarkdown('alpha\nbeta', 'alpha\nbeta')
    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.op === 'equal')).toBe(true)
    expect(lines[1]).toMatchObject({ oldNumber: 2, newNumber: 2 })
    expect(diffCounts(lines)).toEqual({ added: 0, removed: 0 })
  })

  it('marks a replaced line with word-level segments', () => {
    const lines = diffMarkdown('The cell powers the pump.', 'The cell drives the pump.')
    const changed = lines.filter((line) => line.op !== 'equal')
    expect(changed.length).toBeGreaterThan(0)
    const all = changed.flatMap((line) => [
      ...(line.old || []),
      ...(line.new || []),
    ])
    expect(all.some((part) => part.value === 'powers' && part.op === 'remove')).toBe(true)
    expect(all.some((part) => part.value === 'drives' && part.op === 'add')).toBe(true)
  })

  it('reports inserted and deleted lines', () => {
    const added = diffMarkdown('one\nthree', 'one\ntwo\nthree')
    expect(diffCounts(added)).toEqual({ added: 1, removed: 0 })
    expect(added.some((line) => line.new?.map((p) => p.value).join('') === 'two')).toBe(true)

    const removed = diffMarkdown('one\ntwo\nthree', 'one\nthree')
    expect(diffCounts(removed)).toEqual({ added: 0, removed: 1 })
    expect(removed.some((line) => line.old?.map((p) => p.value).join('') === 'two')).toBe(true)
  })

  it('handles empty versions', () => {
    expect(diffMarkdown('', '')).toEqual([])
    expect(diffMarkdown('', 'new line')).toHaveLength(1)
  })
})
