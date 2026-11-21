import { describe, expect, it } from 'vitest'

import { compileNoteui, NoteUIError } from '@/features/notes/model/noteui'
import { parseNoteMarkdown } from '@/features/notes/model/markdown'
import type { NoteBlock } from '@/lib/notes-api'

const types = (blocks: NoteBlock[]) => blocks.map(b => b.type)
const identity = (text: string): NoteBlock[] => [
  { id: 'p1', type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] },
]

describe('compileNoteui', () => {
  it('compiles bindings, components and inline markdown', () => {
    const blocks = compileNoteui(`
      $name = "Ada"
      Page([
        Heading(1, "Notes on " + $name),
        Text("**Bold** and $x^2$ math."),
        Callout("warning", "Careful"),
      ])
    `)
    expect(types(blocks)).toEqual(['heading', 'paragraph', 'callout'])
    expect(blocks[0].props.level).toBe(1)
    const content = blocks[1].content as { type: string; styles?: Record<string, boolean> }[]
    expect(content.some(i => i.styles?.bold)).toBe(true)
    expect(content.some(i => i.type === 'math')).toBe(true)
    expect(blocks[2].props.tone).toBe('warning')
  })

  it('nests children and columns', () => {
    const blocks = compileNoteui(
      'Columns([Column([Bullet("a"), Bullet("b", [Bullet("nested")])]), Column([Text("r")])])'
    )
    expect(types(blocks)).toEqual(['noteColumns'])
    const cols = blocks[0].children!
    expect(types(cols)).toEqual(['noteColumn', 'noteColumn'])
    expect(types(cols[0].children![1].children!)).toEqual(['bulletListItem'])
  })

  it('builds learning blocks', () => {
    const blocks = compileNoteui(
      'Quiz({questions: [{question: "2+2?", options: {A: "3", B: "4"}, correct_answer: "B"}]})\n' +
        'Mermaid(`graph TD; A-->B`)'
    )
    expect(types(blocks)).toEqual(['learning', 'learning'])
    const data = JSON.parse(blocks[0].props.data as string)
    expect(data.questions[0].correct_answer).toBe('B')
    expect(blocks[1].props.kind).toBe('mermaid')
    expect(blocks[1].props.markdown).toContain('graph TD')
  })

  it('evaluates @functions and expressions', () => {
    const blocks = compileNoteui(
      'Text(@Plural(3, "guest") + " -> " + @Format(1234.5, "currency") + " " + @Upper("ok"))'
    )
    const text = (blocks[0].content as { text?: string }[]).map(i => i.text ?? '').join('')
    expect(text).toContain('3 guests')
    expect(text).toContain('$1,234.50')
    expect(text).toContain('OK')
  })

  it('@Each expands components per item', () => {
    const blocks = compileNoteui(
      '$items = [{name: "a"}, {name: "b"}]\nPage([@Each($items, "i", Bullet(i.name))])'
    )
    expect(types(blocks)).toEqual(['bulletListItem', 'bulletListItem'])
    expect((blocks[0].content as { text: string }[])[0].text).toBe('a')
  })

  it('rejects bad programs', () => {
    expect(() => compileNoteui('Bogus(1)')).toThrow(NoteUIError)
    expect(() => compileNoteui('Text($missing)')).toThrow(NoteUIError)
    expect(() => compileNoteui('Text(@Nope(1))')).toThrow(NoteUIError)
    expect(() => compileNoteui('Columns([Column([Text("x")])])')).toThrow(NoteUIError)
  })
})

describe('parseNoteMarkdown with noteui fences', () => {
  it('compiles noteui fences into real blocks', () => {
    const blocks = parseNoteMarkdown(
      '# Hi\n\n```noteui\nPage([Callout("tip", "hi"), Text("there")])\n```\n',
      identity
    )
    // The '# Hi' prose goes through the injected markdown parser (a paragraph
    // in this stub); the fence itself must compile to real blocks.
    expect(types(blocks)).toEqual(['paragraph', 'callout', 'paragraph'])
  })

  it('keeps broken programs literal', () => {
    const blocks = parseNoteMarkdown('```noteui\nBogus(\n```\n', identity)
    expect(types(blocks)).not.toContain('callout')
  })
})
