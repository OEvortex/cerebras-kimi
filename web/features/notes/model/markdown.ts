import type { NoteBlock } from '@/lib/notes-api'

/**
 * Math spans the notebook model emits / imports. BlockNote's markdown parser
 * eats `\(`/`\)` as escapes and treats `_` inside formulas as emphasis, so a
 * formula handed to it raw comes back mangled (`A_{21}` -> `A*{21}`). Every
 * span is replaced with an inert placeholder before parsing and restored as a
 * KaTeX-backed node afterwards.
 */
const MATH_SPAN =
  /\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$\$([\s\S]*?)\$\$|(?<![\\$])\$(?!\s)(?:\\.|[^$\n])*?(?<!\s)\$/g
const MATH_PLACEHOLDER = /%%DT_MATH_(\d+)%%/g

/** Strip the delimiters off a matched math span, returning the formula. */
function mathFormula(span: string): string {
  if (span.startsWith('\\[') || span.startsWith('\\(') || span.startsWith('$$'))
    return span.slice(2, -2)
  return span.slice(1, -1)
}

interface MathSpan {
  formula: string
  source: string
}

/** Replace every math span in a prose line with an inert placeholder. */
function maskMath(text: string, spans: MathSpan[]): string {
  return text.replace(MATH_SPAN, span => {
    spans.push({ formula: mathFormula(span), source: span })
    return `%%DT_MATH_${spans.length - 1}%%`
  })
}

type InlineItem = {
  type?: string
  text?: string
  content?: unknown
  props?: Record<string, unknown>
  styles?: Record<string, unknown>
}

/**
 * Swap placeholders for `math` inline nodes. Handles plain text runs,
 * nested inline content (links) and table cells, so a placeholder never leaks
 * into the editor as literal text.
 */
function restoreInline(value: unknown, spans: MathSpan[]): unknown {
  if (Array.isArray(value)) {
    return value.flatMap(raw => {
      const item = raw as InlineItem | null
      if (!item || typeof item !== 'object') return [raw]
      if (
        item.type === 'text' &&
        typeof item.text === 'string' &&
        item.text.includes('%%DT_MATH_')
      ) {
        const out: unknown[] = []
        let cursor = 0
        // A formula the author wrapped in `code` was meant to stay literal.
        const isCode = Boolean(item.styles?.code)
        for (const match of item.text.matchAll(MATH_PLACEHOLDER)) {
          if (match.index! > cursor)
            out.push({ ...item, text: item.text.slice(cursor, match.index) })
          const span = spans[Number(match[1])]
          if (span?.source)
            out.push(
              isCode
                ? { ...item, text: span.source }
                : { type: 'math', content: span.formula }
            )
          cursor = match.index! + match[0].length
        }
        if (cursor < item.text.length) out.push({ ...item, text: item.text.slice(cursor) })
        return out
      }
      if (item.content !== undefined)
        return { ...item, content: restoreInline(item.content, spans) }
      return [raw]
    })
  }
  if (value && typeof value === 'object' && 'rows' in value) {
    const table = value as { rows: Array<{ cells?: Array<{ content?: unknown }> }> }
    return {
      ...table,
      rows: table.rows.map(row => ({
        ...row,
        cells: (row.cells ?? []).map(cell => ({
          ...cell,
          content: restoreInline(cell.content, spans),
        })),
      })),
    }
  }
  return value
}

/** Swap %%DT_MATH_N%% placeholders back into KaTeX-rendered inline content. */
function restoreMath(blocks: NoteBlock[], spans: MathSpan[]): NoteBlock[] {
  return blocks.map(block => {
    const restored: NoteBlock = { ...block }
    if (block.content !== undefined)
      restored.content = restoreInline(block.content, spans)
    if (block.children) restored.children = restoreMath(block.children, spans)
    return restored
  })
}

/**
 * Keep editor.md math and diagram fences intact while migrating ordinary
 * Markdown into BlockNote blocks. Math is masked before the Markdown parser
 * runs and restored as `mathBlock` / `math` nodes afterwards, so formulas
 * render with KaTeX instead of leaking raw LaTeX into the page.
 */
export function parseNoteMarkdown(
  markdown: string,
  parse: (text: string) => NoteBlock[]
): NoteBlock[] {
  const result: NoteBlock[] = []
  const lines = markdown.split('\n')
  const spans: MathSpan[] = []
  let prose: string[] = []
  const flush = () => {
    const text = prose.join('\n')
    prose = []
    if (!text.trim()) return
    result.push(...restoreMath(parse(text), spans))
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const formula = /^\s*\$\$(.*?)\$\$\s*$/.exec(line)
    if (formula) {
      flush()
      result.push({
        id: crypto.randomUUID(),
        type: 'mathBlock',
        props: {},
        content: formula[1],
        children: [],
      })
      continue
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      const end = lines.findIndex((next, n) => n > index && /^\s*\$\$\s*$/.test(next))
      if (end > index) {
        flush()
        result.push({
          id: crypto.randomUUID(),
          type: 'mathBlock',
          props: {},
          content: lines.slice(index + 1, end).join('\n'),
          children: [],
        })
        index = end
        continue
      }
    }
    const tex = /^\s*\\\[(.*?)\\\]\s*$/.exec(line)
    if (tex) {
      flush()
      result.push({
        id: crypto.randomUUID(),
        type: 'mathBlock',
        props: {},
        content: tex[1],
        children: [],
      })
      continue
    }
    if (/^\s*\\\[\s*$/.test(line)) {
      const end = lines.findIndex((next, n) => n > index && /^\s*\\\]\s*$/.test(next))
      if (end > index) {
        flush()
        result.push({
          id: crypto.randomUUID(),
          type: 'mathBlock',
          props: {},
          content: lines.slice(index + 1, end).join('\n'),
          children: [],
        })
        index = end
        continue
      }
    }
    const fence = /^\s*(`{3,}|~{3,})(\S*)\s*$/.exec(line)
    if (fence) {
      let end = index + 1
      const close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`)
      while (end < lines.length && !close.test(lines[end])) end++
      if (end < lines.length && ['mermaid', 'flow', 'seq'].includes(fence[2])) {
        flush()
        result.push({
          id: crypto.randomUUID(),
          type: 'learning',
          props: {
            kind: fence[2] === 'mermaid' ? 'mermaid' : 'legacy_diagram',
            markdown: lines.slice(index, end + 1).join('\n'),
            prompt: '',
            data: '{}',
            sourceUrl: '',
          },
          children: [],
        })
      } else {
        // Code fences are literal: never turn `\(x\)` inside one into math.
        prose.push(...lines.slice(index, end + 1))
      }
      index = end
      continue
    }
    prose.push(maskMath(line, spans))
  }
  flush()
  return result
}
