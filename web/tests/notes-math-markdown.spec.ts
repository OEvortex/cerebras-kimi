import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'

import { schema } from '@/features/notes/components/editor/schema'
import { parseNoteMarkdown } from '@/features/notes/model/markdown'
import type { NoteBlock } from '@/lib/notes-api'

const editors: InstanceType<typeof schema.BlockNoteEditor>[] = []
afterEach(() => editors.splice(0).forEach(editor => editor._tiptapEditor.destroy()))

/** Parse through the real notebook schema, the way the editor does on migration. */
function parse(markdown: string): NoteBlock[] {
  const editor = BlockNoteEditor.create({ schema })
  editors.push(editor)
  return parseNoteMarkdown(markdown, text => editor.tryParseMarkdownToBlocks(text) as NoteBlock[])
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(item => {
      const node = item as { type?: string; text?: string; content?: unknown }
      return node?.type === 'text' ? String(node.text ?? '') : textOf(node?.content)
    })
    .join('')
}

const formulas = (blocks: NoteBlock[]): string[] => {
  const out: string[] = []
  const walk = (list: NoteBlock[]) =>
    list.forEach(block => {
      if (block.type === 'mathBlock') out.push(textOf(block.content))
      const inline = (items: unknown): void => {
        if (Array.isArray(items))
          items.forEach((item: { type?: string; content?: unknown }) => {
            if (item?.type === 'math') out.push(textOf(item.content))
            else if (item?.content) inline(item.content)
          })
        else if (items && typeof items === 'object' && 'rows' in items) {
          const table = items as { rows: Array<{ cells?: Array<{ content?: unknown }> }> }
          table.rows.forEach(row => (row.cells ?? []).forEach(cell => inline(cell.content)))
        }
      }
      inline(block.content)
      if (block.children) walk(block.children)
    })
  walk(blocks)
  return out
}

describe('notebook LaTeX markdown rendering', () => {
  it('keeps inline backslash-delimited formulas intact, including subscripts', () => {
    const blocks = parse(
      'For \\(E_1\\) and \\(A_{21}\\), the value \\(h\\nu = E_2 - E_1\\) holds.',
    )
    expect(formulas(blocks)).toEqual(['E_1', 'A_{21}', 'h\\nu = E_2 - E_1'])
    expect(JSON.stringify(blocks)).not.toContain('%%DT_MATH_')
    expect(JSON.stringify(blocks)).not.toContain('A*{21}')
  })

  it('turns own-line \\[...\\] and $$...$$ into display math blocks', () => {
    const blocks = parse([
      'Before',
      '',
      '\\[',
      'A_{21} = B_{21}\\frac{8\\pi h \\nu^3}{c^3}',
      '\\]',
      '',
      '$$',
      'g_1 B_{12} = g_2 B_{21}',
      '$$',
      '',
      'After',
    ].join('\n'))
    expect(blocks.filter(b => b.type === 'mathBlock').map(b => textOf(b.content)))
      .toEqual(['A_{21} = B_{21}\\frac{8\\pi h \\nu^3}{c^3}', 'g_1 B_{12} = g_2 B_{21}'])
  })

  it('restores math inside table cells and link labels', () => {
    const table = parse('| a | b |\n| --- | --- |\n| \\(x_1\\) | \\(y^2\\) |')
    expect(formulas(table).sort()).toEqual(['x_1', 'y^2'])
    expect(JSON.stringify(table)).not.toContain('%%DT_MATH_')

    const links = parse('See [\\(x_{21}\\) formula](https://example.com) here.')
    expect(formulas(links)).toEqual(['x_{21}'])
    expect(JSON.stringify(links)).not.toContain('%%DT_MATH_')
  })

  it('keeps prices literal and math adjacent to them as formulas', () => {
    const blocks = parse('Tickets cost $5 and $10, but \\(x^2\\) is the math.')
    const serialized = JSON.stringify(blocks)
    expect(serialized).toContain('Tickets cost $5 and $10')
    expect(formulas(blocks)).toEqual(['x^2'])
  })

  it('never treats code-fence contents as math', () => {
    const blocks = parse('Use `\\(x\\)` in code.\n\n```\n\\(a_{21}\\)\n```')
    expect(formulas(blocks)).toEqual([])
    expect(JSON.stringify(blocks)).not.toContain('%%DT_MATH_')
  })

  it('still migrates study-note LaTeX from a real page', () => {
    const blocks = parse([
      '# Lasers & Optical Fibers',
      '',
      '- \\(A_{21}\\) — probability per unit time of spontaneous emission. Units: s\\(^{-1}\\).',
      '- Population inversion: \\(N_1 \\gg N_2\\) (Boltzmann distribution).',
      '',
      '\\[',
      ' \\frac{dN_2}{dt}\\big|_{\\text{spont}} = -A_{21} N_2',
      '\\]',
      '',
      '| Feature | Lasers |',
      '| --- | --- |',
      '| Key | \\(n_{\\text{core}} > n_{\\text{cladding}}\\) |',
    ].join('\n'))
    const found = formulas(blocks)
    expect(found).toContain('A_{21}')
    expect(found).toContain('N_1 \\gg N_2')
    expect(found).toContain(' \\frac{dN_2}{dt}\\big|_{\\text{spont}} = -A_{21} N_2')
    expect(found).toContain('n_{\\text{core}} > n_{\\text{cladding}}')
    expect(JSON.stringify(blocks)).not.toContain('%%DT_MATH_')
  })
})
