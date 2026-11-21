/**
 * NoteUI Lang — TypeScript port of the backend compiler
 * (backend/app/services/documents/noteui.py). A ```noteui fence in page
 * Markdown holds a small openui-style program that compiles to BlockNote
 * blocks, so live drafts, legacy imports and previews render the same rich
 * content the backend produces for nb_patch writes.
 *
 * Keep this file in sync with the Python original: same components, same
 * @functions, same syntax.
 */

import type { NoteBlock } from '@/lib/notes-api'

type Inline = Record<string, unknown>
type Value = unknown

export class NoteUIError extends Error {}

// ---------------------------------------------------------------------------
// Inline Markdown (mirrors parse_inline_md in noteui.py)
// ---------------------------------------------------------------------------

const MARKERS = ['**', '__', '~~', '*', '_', '`', '[', '$']

function parseSpans(text: string, styles: Record<string, boolean>): Inline[] {
  const out: Inline[] = []
  let buf = ''
  let i = 0
  const n = text.length
  const flush = () => {
    if (buf) {
      out.push({ type: 'text', text: buf, styles: { ...styles } })
      buf = ''
    }
  }
  while (i < n) {
    let matched = false
    for (const marker of MARKERS) {
      if (!text.startsWith(marker, i)) continue
      if (i > 0 && text[i - 1] === '\\') {
        buf += text.slice(i, i + marker.length)
        i += marker.length
        matched = true
        break
      }
      if (marker === '**' || marker === '__') {
        const close = text.indexOf(marker, i + 2)
        if (close < 0) {
          buf += marker
          i += 2
          matched = true
          break
        }
        flush()
        out.push(...parseSpans(text.slice(i + 2, close), { ...styles, bold: true }))
        i = close + 2
        matched = true
        break
      }
      if (marker === '~~') {
        const close = text.indexOf('~~', i + 2)
        if (close < 0) {
          buf += '~~'
          i += 2
          matched = true
          break
        }
        flush()
        out.push(...parseSpans(text.slice(i + 2, close), { ...styles, strike: true }))
        i = close + 2
        matched = true
        break
      }
      if (marker === '*' || marker === '_') {
        if (
          marker === '_' &&
          ((i > 0 && /[\w_]/.test(text[i - 1])) || (i + 1 < n && /[\w_]/.test(text[i + 1])))
        )
          continue
        const close = text.indexOf(marker, i + 1)
        if (close < 0) {
          buf += marker
          i += 1
          matched = true
          break
        }
        flush()
        out.push(...parseSpans(text.slice(i + 1, close), { ...styles, italic: true }))
        i = close + 1
        matched = true
        break
      }
      if (marker === '`') {
        const close = text.indexOf('`', i + 1)
        if (close < 0) {
          buf += '`'
          i += 1
          matched = true
          break
        }
        flush()
        out.push({
          type: 'text',
          text: text.slice(i + 1, close),
          styles: { ...styles, code: true },
        })
        i = close + 1
        matched = true
        break
      }
      if (marker === '[') {
        const mid = text.indexOf('](', i + 1)
        if (mid > 0) {
          const end = text.indexOf(')', mid + 2)
          if (end > 0) {
            const href = text.slice(mid + 2, end)
            const label = text.slice(i + 1, mid)
            if (/^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(href) || href === '') {
              flush()
              out.push({ type: 'link', href, content: parseSpans(label, {}) })
              i = end + 1
              matched = true
              break
            }
          }
        }
        buf += '['
        i += 1
        matched = true
        break
      }
      if (marker === '$') {
        if (text.startsWith('$$', i)) {
          const close = text.indexOf('$$', i + 2)
          if (close > i + 2) {
            const formula = text.slice(i + 2, close).trim()
            if (formula) {
              flush()
              out.push({ type: 'math', content: formula })
              i = close + 2
              matched = true
              break
            }
          }
          buf += '$$'
          i += 2
          matched = true
          break
        }
        const close = text.indexOf('$', i + 1)
        if (close > i + 1) {
          const formula = text.slice(i + 1, close)
          if (formula.trim() && !formula.startsWith(' ') && !formula.endsWith(' ')) {
            flush()
            out.push({ type: 'math', content: formula.trim() })
            i = close + 1
            matched = true
            break
          }
        }
        buf += '$'
        i += 1
        matched = true
        break
      }
    }
    if (!matched) {
      buf += text[i]
      i += 1
    }
  }
  flush()
  return out
}

function parseInlineMd(text: string): Inline[] {
  if (!text) return []
  return parseSpans(text, {})
}

// ---------------------------------------------------------------------------
// Tokenizer (mirrors _tokenize in noteui.py)
// ---------------------------------------------------------------------------

type Tok = { kind: string; val: Value; line: number }

const TWO_CHAR = new Set(['==', '!=', '<=', '>=', '&&', '||'])
const PUNCT = new Set('( ) [ ] { } , : . ? + - * / % = ! < >'.split(' '))

function tokenize(source: string): Tok[] {
  const tokens: Tok[] = []
  let i = 0
  let line = 1
  const n = source.length
  const err = (msg: string): never => {
    throw new NoteUIError(`${msg} (line ${line})`)
  }
  while (i < n) {
    const ch = source[i]
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1
      continue
    }
    if (ch === '\n') {
      line += 1
      i += 1
      continue
    }
    if (ch === '/' && source.startsWith('//', i)) {
      const end = source.indexOf('\n', i)
      i = end < 0 ? n : end
      continue
    }
    if (/\d/.test(ch) || (ch === '.' && i + 1 < n && /\d/.test(source[i + 1]))) {
      let j = i
      while (j < n && (/[\d.]/.test(source[j]))) j += 1
      const raw = source.slice(i, j)
      const num = raw.includes('.') ? parseFloat(raw) : parseInt(raw, 10)
      if (Number.isNaN(num)) err(`Bad number ${raw}`)
      tokens.push({ kind: 'num', val: num, line })
      i = j
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      let j = i + 1
      let buf = ''
      while (j < n && source[j] !== quote) {
        if (source[j] === '\\' && j + 1 < n) {
          const nxt = source[j + 1]
          buf += { n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\', '`': '`', $: '$' }[
            nxt
          ] ?? nxt
          j += 2
          continue
        }
        if (source[j] === '\n') line += 1
        buf += source[j]
        j += 1
      }
      if (j >= n) err('Unterminated string')
      tokens.push({ kind: 'str', val: buf, line })
      i = j + 1
      continue
    }
    if (ch === '`') {
      const j = source.indexOf('`', i + 1)
      if (j < 0) err('Unterminated raw string')
      tokens.push({ kind: 'str', val: source.slice(i + 1, j), line })
      line += source.slice(i, j).split('\n').length - 1
      i = j + 1
      continue
    }
    if (ch === '@') {
      let j = i + 1
      while (j < n && /[\w]/.test(source[j])) j += 1
      if (j === i + 1) err("'@' must be followed by a function name")
      tokens.push({ kind: 'fn', val: source.slice(i + 1, j), line })
      i = j
      continue
    }
    if (ch === '$') {
      let j = i + 1
      while (j < n && /[\w]/.test(source[j])) j += 1
      if (j === i + 1) err("'$' must be followed by a variable name")
      tokens.push({ kind: 'var', val: source.slice(i + 1, j), line })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < n && /[\w]/.test(source[j])) j += 1
      const word = source.slice(i, j)
      if (word === 'true' || word === 'false' || word === 'null') {
        tokens.push({ kind: 'lit', val: { true: true, false: false, null: null }[word], line })
      } else {
        tokens.push({ kind: 'ident', val: word, line })
      }
      i = j
      continue
    }
    const two = source.slice(i, i + 2)
    if (TWO_CHAR.has(two)) {
      tokens.push({ kind: 'op', val: two, line })
      i += 2
      continue
    }
    if (PUNCT.has(ch)) {
      if (ch === '=') tokens.push({ kind: 'op', val: '=', line })
      else if (ch === '&') err("Use '&&' for and")
      else if (ch === '|') err("Use '||' for or")
      else tokens.push({ kind: 'punct', val: ch, line })
      i += 1
      continue
    }
    err(`Unexpected character ${ch}`)
  }
  tokens.push({ kind: 'eof', val: null, line })
  return tokens
}

// ---------------------------------------------------------------------------
// Parser (mirrors _Parser in noteui.py)
// ---------------------------------------------------------------------------

type Node = [string, ...unknown[]]

class Parser {
  pos = 0
  constructor(private tokens: Tok[]) {}

  peek(): Tok {
    return this.tokens[this.pos]
  }
  next(): Tok {
    return this.tokens[this.pos++]
  }
  expect(value: string): Tok {
    const tok = this.next()
    if (tok.val !== value) throw new NoteUIError(`Expected ${value}, got ${tok.val} (line ${tok.line})`)
    return tok
  }
  at(value: string): boolean {
    const tok = this.peek()
    return tok.val === value && (tok.kind === 'punct' || tok.kind === 'op')
  }

  parseProgram(): Node[] {
    const stmts: Node[] = []
    while (this.peek().kind !== 'eof') stmts.push(this.parseStmt())
    return stmts
  }

  parseStmt(): Node {
    const tok = this.peek()
    if (
      (tok.kind === 'ident' || tok.kind === 'var') &&
      this.tokens[this.pos + 1]?.val === '=' &&
      this.tokens[this.pos + 1]?.kind === 'op'
    ) {
      const name = this.next().val as string
      this.next()
      return ['bind', name, this.parseExpr()]
    }
    return ['expr', this.parseExpr()]
  }

  parseExpr(): Node {
    return this.parseTernary()
  }
  parseTernary(): Node {
    const cond = this.parseOr()
    if (this.at('?')) {
      this.next()
      const yes = this.parseExpr()
      this.expect(':')
      return ['tern', cond, yes, this.parseExpr()]
    }
    return cond
  }
  parseOr(): Node {
    let left = this.parseAnd()
    while (this.at('||')) {
      this.next()
      left = ['bin', '||', left, this.parseAnd()]
    }
    return left
  }
  parseAnd(): Node {
    let left = this.parseCmp()
    while (this.at('&&')) {
      this.next()
      left = ['bin', '&&', left, this.parseCmp()]
    }
    return left
  }
  parseCmp(): Node {
    let left = this.parseAdd()
    while (this.peek().kind === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(this.peek().val as string)) {
      const op = this.next().val as string
      left = ['bin', op, left, this.parseAdd()]
    }
    return left
  }
  parseAdd(): Node {
    let left = this.parseMul()
    while (this.at('+') || this.at('-')) {
      const op = this.next().val as string
      left = ['bin', op, left, this.parseMul()]
    }
    return left
  }
  parseMul(): Node {
    let left = this.parseUnary()
    while (this.peek().val !== null && ['*', '/', '%'].includes(this.peek().val as string) && (this.peek().kind === 'op' || this.peek().kind === 'punct')) {
      const op = this.next().val as string
      left = ['bin', op, left, this.parseUnary()]
    }
    return left
  }
  parseUnary(): Node {
    if (this.at('!')) {
      this.next()
      return ['un', '!', this.parseUnary()]
    }
    if (this.at('-')) {
      this.next()
      return ['un', '-', this.parseUnary()]
    }
    return this.parsePostfix()
  }
  parsePostfix(): Node {
    let node = this.parsePrimary()
    for (;;) {
      if (this.at('.')) {
        this.next()
        const tok = this.next()
        if (tok.kind !== 'ident') throw new NoteUIError(`Expected field name after '.' (line ${tok.line})`)
        node = ['member', node, tok.val as string]
        continue
      }
      if (this.at('[')) {
        this.next()
        const index = this.parseExpr()
        this.expect(']')
        node = ['index', node, index]
        continue
      }
      break
    }
    return node
  }
  parsePrimary(): Node {
    const tok = this.next()
    if (tok.kind === 'num' || tok.kind === 'str' || tok.kind === 'lit') return ['lit', tok.val]
    if (tok.kind === 'var') return ['var', tok.val as string]
    if (tok.kind === 'fn') {
      this.expect('(')
      const args = this.parseArgs()
      this.expect(')')
      return ['fn', tok.val as string, args]
    }
    if (tok.kind === 'ident') {
      const val = tok.val as string
      if (val === 'true' || val === 'false' || val === 'null')
        return ['lit', { true: true, false: false, null: null }[val]]
      if (this.at('(')) {
        this.next()
        const args = this.parseArgs()
        this.expect(')')
        return ['call', val, args]
      }
      return ['var', val]
    }
    if (tok.kind === 'punct' && tok.val === '(') {
      const node = this.parseExpr()
      this.expect(')')
      return node
    }
    if (tok.kind === 'punct' && tok.val === '[') {
      const items: Node[] = []
      while (!this.at(']')) {
        items.push(this.parseExpr())
        if (this.at(',')) {
          this.next()
          continue
        }
        break
      }
      this.expect(']')
      return ['arr', items]
    }
    if (tok.kind === 'punct' && tok.val === '{') {
      const pairs: [string, Node][] = []
      while (!this.at('}')) {
        const k = this.next()
        if (k.kind !== 'ident' && k.kind !== 'str')
          throw new NoteUIError(`Object keys must be names or strings (line ${k.line})`)
        this.expect(':')
        pairs.push([k.val as string, this.parseExpr()])
        if (this.at(',')) {
          this.next()
          continue
        }
        break
      }
      this.expect('}')
      return ['obj', pairs]
    }
    throw new NoteUIError(`Unexpected token ${tok.val} (line ${tok.line})`)
  }
  parseArgs(): Node[] {
    const args: Node[] = []
    while (!this.at(')')) {
      args.push(this.parseExpr())
      if (this.at(',')) {
        this.next()
        continue
      }
      break
    }
    return args
  }
}

// ---------------------------------------------------------------------------
// Values & blocks (mirrors noteui.py)
// ---------------------------------------------------------------------------

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12)

function blk(type: string, props: Record<string, unknown> = {}, content?: unknown, children: NoteBlock[] = []): NoteBlock {
  const block: NoteBlock = { id: newId(), type, props, children }
  if (content !== undefined) block.content = content
  return block
}

const isBlocks = (v: Value): v is NoteBlock[] =>
  Array.isArray(v) && v.every((i) => i && typeof i === 'object' && typeof (i as NoteBlock).type === 'string')

function asBlocks(value: Value, what = 'value'): NoteBlock[] {
  if (isBlocks(value)) return [...value]
  if (Array.isArray(value)) {
    const flat: NoteBlock[] = []
    for (const item of value) flat.push(...asBlocks(item, what))
    return flat
  }
  throw new NoteUIError(`${what} must be a component or list of components`)
}

function joinText(args: Value[]): string {
  const parts: string[] = []
  for (const arg of args) {
    if (isBlocks(arg) || (Array.isArray(arg) && arg.length && isBlocks(arg[0])))
      throw new NoteUIError('Text content cannot contain components; pass them as children instead')
    if (arg === null || arg === undefined) continue
    if (typeof arg === 'boolean') parts.push(arg ? 'true' : 'false')
    else parts.push(String(arg))
  }
  return parts.join('')
}

const content = (text: string): Inline[] => parseInlineMd(text)

// ---------------------------------------------------------------------------
// Components (mirrors _COMPONENTS in noteui.py)
// ---------------------------------------------------------------------------

type Builder = (args: Value[], children: NoteBlock[] | null) => NoteBlock[]

function splitChildren(args: Value[]): [Value[], NoteBlock[] | null] {
  const last = args[args.length - 1]
  if (last !== undefined && (isBlocks(last) || (Array.isArray(last) && last.length && isBlocks(last[0]))))
    return [args.slice(0, -1), asBlocks(last, 'children')]
  return [args, null]
}

function noChildren(children: NoteBlock[] | null, name: string) {
  if (children?.length) throw new NoteUIError(`${name} does not take child components`)
}

const COMPONENTS: Record<string, Builder> = {
  Page: (args) => asBlocks(args[0] ?? [], 'Page'),
  Heading: (args, children) => cHeading(args, children, false),
  ToggleHeading: (args, children) => cHeading(args, children, true),
  Text: (args, children) => {
    noChildren(children, 'Text')
    return [blk('paragraph', {}, content(joinText(args)))]
  },
  Paragraph: (args, children) => {
    noChildren(children, 'Paragraph')
    return [blk('paragraph', {}, content(joinText(args)))]
  },
  Quote: (args, children) => {
    const [rest, tail] = splitChildren(args)
    const kids = children ?? tail
    return [blk('quote', {}, content(joinText(rest)), kids ?? [])]
  },
  Callout: (args, children) => {
    let [rest, tail] = splitChildren(args)
    const kids = children ?? tail
    let tone = 'tip'
    if (rest.length && typeof rest[0] === 'string' && ['tip', 'info', 'warning'].includes(rest[0].toLowerCase())) {
      tone = (rest[0] as string).toLowerCase()
      rest = rest.slice(1)
    }
    return [blk('callout', { tone }, content(joinText(rest)), kids ?? [])]
  },
  Bullet: (args, children) => cItem('bulletListItem', args, children),
  Numbered: (args, children) => cItem('numberedListItem', args, children),
  CheckItem: (args, children) => cItem('checkListItem', args, children),
  ToggleItem: (args, children) => cItem('toggleListItem', args, children),
  CodeBlock: (args, children) => {
    noChildren(children, 'CodeBlock')
    return [blk('codeBlock', { language: String(args[0] ?? '') }, content(joinText(args.slice(1))))]
  },
  Divider: (_args, children) => {
    noChildren(children, 'Divider')
    return [blk('divider')]
  },
  Math: (args, children) => {
    noChildren(children, 'Math')
    return [blk('mathBlock', {}, joinText(args))]
  },
  Image: media('image'),
  Video: media('video'),
  Audio: media('audio'),
  File: media('file'),
  Table: (args, children) => {
    noChildren(children, 'Table')
    const rows = args[0]
    if (!Array.isArray(rows)) throw new NoteUIError('Table expects an array of rows')
    const out = rows.map((row) => {
      if (!Array.isArray(row)) throw new NoteUIError('Each table row must be an array of cells')
      return { cells: row.map((cell) => (Array.isArray(cell) ? cell : content(String(cell)))) }
    })
    return [blk('table', {}, { rows: out })]
  },
  Columns: (args) => {
    const cols = asBlocks(args[0] ?? [], 'Columns')
    if (cols.length < 2 || cols.length > 5 || cols.some((c) => c.type !== 'noteColumn'))
      throw new NoteUIError('Columns needs 2 to 5 Column(...) children')
    return [blk('noteColumns', {}, undefined, cols)]
  },
  Column: (args) => [blk('noteColumn', {}, undefined, asBlocks(args[0] ?? [], 'Column'))],
  TableOfContents: () => [blk('tableOfContents')],
  WebCard: (args, children) => {
    noChildren(children, 'WebCard')
    return [
      blk('webCard', {
        url: String(args[0] ?? ''),
        title: String(args[1] ?? ''),
        description: String(args[2] ?? ''),
      }),
    ]
  },
  HtmlEmbed: (args, children) => {
    noChildren(children, 'HtmlEmbed')
    return [blk('htmlEmbed', { source: joinText(args) })]
  },
  TaskView: (args, children) => {
    noChildren(children, 'TaskView')
    return [blk('taskView', { view: String(args[0] ?? 'table') })]
  },
  Clip: (args, children) => {
    noChildren(children, 'Clip')
    return [
      blk('clip', {
        title: String(args[0] ?? ''),
        markdown: String(args[1] ?? ''),
        sourceUrl: String(args[2] ?? ''),
        sourceId: '',
        favoriteType: '',
        summary: '',
        metadata: '{}',
        expanded: false,
      }),
    ]
  },
  Block: (args, children) => {
    noChildren(children, 'Block')
    const raw = args[0]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as NoteBlock).type !== 'string')
      throw new NoteUIError("Block(...) expects an object with a 'type' field")
    return [ensureIds(structuredClone(raw)) as NoteBlock]
  },
  Mermaid: (args, children) => {
    noChildren(children, 'Mermaid')
    const code = joinText(args)
    return [learningBlock('mermaid', undefined, `\`\`\`mermaid\n${code}\n\`\`\``)]
  },
  Quiz: learning('quiz'),
  Flashcards: learning('flashcards'),
  Timeline: learning('timeline'),
  ConceptMap: learning('concept_map'),
  GeoGebra: learning('geogebra'),
  Research: learning('research'),
  Task: learning('task'),
  Learning: (args, children) => {
    noChildren(children, 'Learning')
    return [learningBlock(String(args[0] ?? ''), args[1], String(args[2] ?? ''))]
  },
}

function cHeading(args: Value[], children: NoteBlock[] | null, toggle: boolean): NoteBlock[] {
  const [rest, tail] = splitChildren(args)
  const kids = children ?? tail
  const level = Math.max(1, Math.min(6, Number(rest[0] ?? (toggle ? 2 : 1)) || (toggle ? 2 : 1)))
  const props: Record<string, unknown> = { level }
  if (toggle) props.collapsed = false
  return [blk(toggle ? 'toggleHeading' : 'heading', props, content(joinText(rest.slice(1))), kids ?? [])]
}

function cItem(kind: string, args: Value[], children: NoteBlock[] | null): NoteBlock[] {
  const [rest, tail] = splitChildren(args)
  const kids = children ?? tail
  const props: Record<string, unknown> = {}
  const texts = [...rest]
  if (kind === 'checkListItem' && typeof texts[texts.length - 1] === 'boolean')
    props.checked = texts.pop()
  return [blk(kind, props, content(joinText(texts)), kids ?? [])]
}

function media(kind: string): Builder {
  return (args, children) => {
    noChildren(children, kind)
    const props: Record<string, unknown> = { url: String(args[0] ?? '') }
    if (kind === 'file') props.name = String(args[1] ?? '')
    else if (args.length > 1) props.caption = String(args[1])
    return [blk(kind, props)]
  }
}

function learning(kind: string): Builder {
  return (args, children) => {
    noChildren(children, kind)
    const markdown = args.length > 1 ? String(args[1]) : ''
    return [learningBlock(kind, args[0], markdown)]
  }
}

function learningBlock(kind: string, data: Value, markdown: string): NoteBlock {
  const props: Record<string, unknown> = { kind, prompt: '', markdown, data: '{}', sourceUrl: '' }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const body = JSON.stringify(data)
    props.data = body
    if (!markdown) props.markdown = body
  } else if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        props.data = JSON.stringify(parsed)
        if (!markdown) props.markdown = data
      }
    } catch {
      if (!markdown) props.markdown = data
    }
  }
  return blk('learning', props)
}

function ensureIds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(ensureIds)
  if (node && typeof node === 'object') {
    const out = Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, ensureIds(v)]))
    if (typeof out.type === 'string' && (typeof out.id !== 'string' || !out.id)) out.id = newId()
    return out
  }
  return node
}

// ---------------------------------------------------------------------------
// @functions (mirrors _FUNCTIONS in noteui.py)
// ---------------------------------------------------------------------------

const num = (v: Value): number => {
  const f = Number(v)
  return Number.isFinite(f) ? f : 0
}
const str = (v: Value): string => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v))

function pluck(rows: Value, field: string): Value[] {
  if (!Array.isArray(rows)) return []
  if (!field) return rows
  return rows.filter((r) => r && typeof r === 'object' && field in (r as object)).map((r) => (r as Record<string, Value>)[field])
}

function numList(value: Value, field = ''): number[] {
  const items = field ? pluck(value, field) : Array.isArray(value) ? value : []
  return items.map(num).filter((v, i) => items[i] !== null && items[i] !== undefined && items[i] !== '' && !Number.isNaN(Number(items[i])))
}

function agg(name: string, values: Value, field = ''): number {
  const nums = numList(values, field)
  if (!nums.length) return 0
  if (name === 'sum') return nums.reduce((a, b) => a + b, 0)
  if (name === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length
  if (name === 'min') return Math.min(...nums)
  if (name === 'max') return Math.max(...nums)
  return nums.length
}

function parseDate(value: Value): Date | null {
  if (value instanceof Date) return value
  const d = new Date(str(value).slice(0, 10))
  return Number.isNaN(d.getTime()) ? null : d
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function fmtNumber(v: number, decimals: number | null): string {
  if (decimals === null || decimals === undefined) {
    const s = v.toLocaleString('en-US', { maximumFractionDigits: 2 })
    return s === '-0' ? '0' : s
  }
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function fnFormat(args: Value[]): string {
  const value = args[0]
  const kind = str(args[1] || 'number')
  const decimals = args[2] !== undefined ? Number(args[2]) : null
  const currency = str(args[3] || 'USD')
  const n = Number(value)
  if (!Number.isFinite(n)) return str(value)
  if (kind === 'currency') {
    const sym: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹' }
    const d = decimals ?? 2
    return `${sym[currency.toUpperCase()] ?? currency + ' '}${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
  }
  if (kind === 'percent') {
    const d = decimals ?? 0
    return `${n.toFixed(d)}%`
  }
  if (kind === 'compact') {
    for (const [div, suf] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
      if (Math.abs(n) >= div) return `${(n / div).toFixed(1)}${suf}`
    }
    return `${n}`
  }
  return fmtNumber(n, decimals)
}

function addMonths(d: Date, months: number): Date {
  const total = d.getMonth() + months
  const year = d.getFullYear() + Math.floor(total / 12)
  const month = ((total % 12) + 12) % 12
  const day = Math.min(d.getDate(), new Date(year, month + 1, 0).getDate())
  return new Date(year, month, day)
}

function monthsBetween(a: Date | null, b: Date | null): number {
  if (!a || !b) return 0
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
  if (b.getDate() < a.getDate()) months -= 1
  return months
}

function startOf(d: Date, unit: string): Date {
  if (unit === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1))
  if (unit === 'year') return new Date(d.getFullYear(), 0, 1)
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function isoDate(d: Date | null): string {
  if (!d) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fnGroupBy(args: Value[]): Value {
  const rows = Array.isArray(args[0]) ? args[0] : []
  const key = str(args[1] || '')
  const field = str(args[2] || '')
  const ag = str(args[3] || 'sum')
  const groups = new Map<Value, Record<string, Value>[]>()
  const order: Value[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const k = (row as Record<string, Value>)[key]
    if (!groups.has(k)) {
      groups.set(k, [])
      order.push(k)
    }
    groups.get(k)!.push(row as Record<string, Value>)
  }
  return order.map((k) => {
    const members = groups.get(k)!
    const value = field ? agg(ag, members, field) : ag === 'count' ? members.length : agg(ag, members, '')
    return { key: k, value }
  })
}

function fnFilter(args: Value[]): Value {
  const rows = Array.isArray(args[0]) ? args[0] : []
  const field = str(args[1] || '')
  const op = str(args[2] || '==')
  const want = args[3]
  return rows.filter((row) => {
    if (!row || typeof row !== 'object') return false
    const val = (row as Record<string, Value>)[field]
    switch (op) {
      case '==': return val === want
      case '!=': return val !== want
      case '>': return typeof val === 'number' && val > num(want)
      case '<': return typeof val === 'number' && val < num(want)
      case '>=': return typeof val === 'number' && val >= num(want)
      case '<=': return typeof val === 'number' && val <= num(want)
      case 'contains': return typeof val === 'string' ? val.includes(str(want)) : Array.isArray(val) ? val.includes(want) : false
      default: return false
    }
  })
}

function fnBucket(args: Value[]): Value {
  const rows = Array.isArray(args[0]) ? args[0] : []
  const dateField = str(args[1] || '')
  const unit = str(args[2] || 'day')
  const field = str(args[3] || '')
  const ag = str(args[4] || 'sum')
  const buckets = new Map<string, Record<string, Value>[]>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const d = parseDate((row as Record<string, Value>)[dateField])
    if (!d) continue
    let key: string
    if (unit === 'week') {
      const dow = (d.getDay() + 6) % 7
      key = isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow))
    } else if (unit === 'month') {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    } else {
      key = isoDate(d)
    }
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(row as Record<string, Value>)
  }
  return [...buckets.keys()].sort().map((k) => ({
    key: k,
    value: field ? agg(ag, buckets.get(k)!, field) : buckets.get(k)!.length,
  }))
}

function fnCumulative(args: Value[]): Value {
  const rows = args[0]
  const field = str(args[1] || '')
  if (Array.isArray(rows) && rows.length && typeof rows[0] !== 'object') {
    let total = 0
    return rows.map((v) => {
      total += num(v)
      return total
    })
  }
  let total = 0
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (row && typeof row === 'object') {
      const copy = { ...(row as Record<string, Value>) }
      total += num(copy[field])
      copy[field] = total
      return copy
    }
    return row
  })
}

function fnMovingAvg(args: Value[]): Value {
  const rows = args[0]
  const field = str(args[1] || '')
  const window = Math.max(1, Number(args[2]) || 3)
  const values = numList(rows, field)
  const avgs = values.map((_, i) => {
    const w = values.slice(Math.max(0, i - window + 1), i + 1)
    return w.reduce((a, b) => a + b, 0) / w.length
  })
  if (Array.isArray(rows) && rows.length && rows[0] && typeof rows[0] === 'object') {
    return rows.map((row, i) => ({ ...(row as Record<string, Value>), [field]: avgs[i] }))
  }
  return avgs
}

function fnStats(args: Value[]): Value {
  const nums = numList(args[0])
  if (!nums.length) return { count: 0, min: 0, max: 0, avg: 0, sum: 0 }
  const sum = nums.reduce((a, b) => a + b, 0)
  return { count: nums.length, min: Math.min(...nums), max: Math.max(...nums), avg: sum / nums.length, sum }
}

function fnDuration(args: Value[]): string {
  let seconds = Math.max(0, Math.floor(num(args[0])))
  const style = str(args[1] || 'short')
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (style === 'clock') return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
  const parts: string[] = []
  if (h) parts.push(`${h}h`)
  if (m) parts.push(h ? `${String(m).padStart(2, '0')}m` : `${m}m`)
  if (s || !parts.length) parts.push(h || m ? `${String(s).padStart(2, '0')}s` : `${s}s`)
  return parts.join(' ')
}

function fnFormatDate(args: Value[]): string {
  const d = parseDate(args[0]) ?? new Date()
  const style = str(args[1] || 'date')
  const p = (n: number) => String(n).padStart(2, '0')
  const mon = MONTHS[d.getMonth()]
  const day = d.getDate()
  switch (style) {
    case 'short': return `${mon} ${day}`
    case 'long': return `${DAYS[d.getDay()]}, ${mon} ${day}, ${d.getFullYear()}`
    case 'weekday': return DAYS[d.getDay()]
    case 'month': return `${mon} ${d.getFullYear()}`
    case 'time': return `${p(d.getHours())}:${p(d.getMinutes())}`
    case 'datetime': return `${mon} ${day}, ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
    case 'iso': return isoDate(d)
    default: return `${mon} ${day}, ${d.getFullYear()}`
  }
}

const FUNCTIONS: Record<string, (args: Value[]) => Value> = {
  Count: (a) => (Array.isArray(a[0]) || typeof a[0] === 'string' ? (a[0] as string).length ?? (a[0] as unknown[]).length : typeof a[0] === 'object' && a[0] ? Object.keys(a[0] as object).length : 0),
  First: (a) => (Array.isArray(a[0]) && a[0].length ? a[0][0] : null),
  Last: (a) => (Array.isArray(a[0]) && a[0].length ? a[0][a[0].length - 1] : null),
  Sum: (a) => agg('sum', a[0], str(a[1] || '')),
  Avg: (a) => agg('avg', a[0], str(a[1] || '')),
  Min: (a) => agg('min', a[0], str(a[1] || '')),
  Max: (a) => agg('max', a[0], str(a[1] || '')),
  Includes: (a) => (Array.isArray(a[0]) ? a[0].includes(a[1]) : typeof a[0] === 'string' ? a[0].includes(str(a[1])) : false),
  Find: (a) => {
    if (!Array.isArray(a[0]) || a.length < 3) return null
    const field = str(a[1])
    return a[0].find((r) => r && typeof r === 'object' && (r as Record<string, Value>)[field] === a[2]) ?? null
  },
  IndexOf: (a) => (Array.isArray(a[0]) ? a[0].indexOf(a[1]) : -1),
  Take: (a) => {
    if (!Array.isArray(a[0]) || a.length < 2) return []
    const n = Math.trunc(num(a[1]))
    return n >= 0 ? a[0].slice(0, n) : a[0].slice(n)
  },
  Slice: (a) => {
    if (!Array.isArray(a[0]) || a.length < 2) return []
    return a[0].slice(Math.trunc(num(a[1])), a.length > 2 ? Math.trunc(num(a[2])) : undefined)
  },
  Unique: (a) => (Array.isArray(a[0]) ? [...new Set(a[0])] : []),
  Reverse: (a) => (Array.isArray(a[0]) ? [...a[0]].reverse() : []),
  Range: (a) => {
    const start = Math.trunc(num(a[0]))
    const end = Math.trunc(num(a[1]))
    const step = a.length > 2 && num(a[2]) ? Math.trunc(num(a[2])) : 1
    const out: number[] = []
    for (let v = start; step > 0 ? v < end : v > end; v += step) out.push(v)
    return out
  },
  Flatten: (a) => (Array.isArray(a[0]) ? a[0].flatMap((x) => (Array.isArray(x) ? x : [x])) : []),
  Concat: (a) => (Array.isArray(a[0]) && Array.isArray(a[1]) ? [...a[0], ...a[1]] : []),
  Append: (a) => (Array.isArray(a[0]) ? [...a[0], a[1]] : [a[1]]),
  Prepend: (a) => (Array.isArray(a[0]) ? [a[1], ...a[0]] : [a[1]]),
  RemoveAt: (a) => {
    if (!Array.isArray(a[0]) || a.length < 2) return []
    const i = Math.trunc(num(a[1]))
    const idx = i < 0 ? a[0].length + i : i
    return a[0].filter((_, j) => j !== idx)
  },
  Chunk: (a) => {
    if (!Array.isArray(a[0]) || a.length < 2) return []
    const size = Math.max(1, Math.trunc(num(a[1])))
    const out: Value[][] = []
    for (let i = 0; i < a[0].length; i += size) out.push(a[0].slice(i, i + size))
    return out
  },
  Pick: (a) => (Array.isArray(a[0]) && a[0].length ? a[0][Math.floor(Math.random() * a[0].length)] : null),
  Shuffle: (a) => (Array.isArray(a[0]) ? [...a[0]].sort(() => Math.random() - 0.5) : []),
  Pow: (a) => (a.length > 1 ? Math.pow(num(a[0]), num(a[1])) : 0),
  Sqrt: (a) => (a.length && num(a[0]) >= 0 ? Math.sqrt(num(a[0])) : null),
  Random: (a) => {
    const min = num(a[0] ?? 0)
    const max = num(a[1] ?? 1)
    return a.length > 2 && a[2] ? Math.floor(min + Math.random() * (max - min + 1)) : min + Math.random() * (max - min)
  },
  Clamp: (a) => (a.length > 2 ? Math.min(Math.max(num(a[0]), num(a[1])), num(a[2])) : a[0] ?? 0),
  Percent: (a) => (a.length > 1 && num(a[1]) ? (num(a[0]) / num(a[1])) * 100 : 0),
  Lerp: (a) => (a.length > 2 ? num(a[0]) + (num(a[1]) - num(a[0])) * num(a[2]) : a[0] ?? 0),
  Round: (a) => {
    const d = a.length > 1 ? Math.trunc(num(a[1])) : 0
    const f = 10 ** d
    return Math.round(num(a[0]) * f) / f
  },
  Abs: (a) => Math.abs(num(a[0])),
  Floor: (a) => Math.floor(num(a[0])),
  Ceil: (a) => Math.ceil(num(a[0])),
  Format: fnFormat,
  Join: (a) => {
    const items = a.length > 1 && a[1] ? pluck(a[0], str(a[1])) : Array.isArray(a[0]) ? a[0] : [a[0]]
    const sep = a.length > 2 ? str(a[2]) : ', '
    return items.filter((x) => x !== null && x !== undefined).map(str).join(sep)
  },
  Plural: (a) => {
    const n = num(a[0])
    const word = str(a[1])
    const plural = a.length > 2 && a[2] ? str(a[2]) : word + 's'
    return `${n} ${Math.abs(n) === 1 ? word : plural}`
  },
  Pad: (a) => str(a[0]).padStart(Math.trunc(num(a[1])), a.length > 2 ? str(a[2]) : '0'),
  Upper: (a) => str(a[0]).toUpperCase(),
  Lower: (a) => str(a[0]).toLowerCase(),
  Trim: (a) => str(a[0]).trim(),
  Capitalize: (a) => str(a[0]).replace(/\b\w/g, (c) => c.toUpperCase()),
  Split: (a) => str(a[0]).split(a.length > 1 ? str(a[1]) : ',').map((p) => p.trim()).filter(Boolean),
  Replace: (a) => str(a[0]).split(str(a[1])).join(str(a[2] ?? '')),
  Duration: fnDuration,
  Default: (a) => {
    const v = a[0]
    if (v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))) return a[1]
    return v
  },
  Now: () => new Date().toISOString(),
  Today: () => isoDate(new Date()),
  FormatDate: fnFormatDate,
  AddDays: (a) => {
    const d = parseDate(a[0]) ?? new Date()
    return isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + Math.trunc(num(a[1]))))
  },
  AddMonths: (a) => isoDate(addMonths(parseDate(a[0]) ?? new Date(), Math.trunc(num(a[1])))),
  DaysBetween: (a) => {
    const f = parseDate(a[0])
    const t = parseDate(a[1])
    if (!f || !t) return 0
    return Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() - new Date(f.getFullYear(), f.getMonth(), f.getDate()).getTime()) / 86400000)
  },
  MonthsBetween: (a) => monthsBetween(parseDate(a[0]), parseDate(a[1])),
  StartOf: (a) => isoDate(startOf(parseDate(a[0]) ?? new Date(), str(a[1] || 'month'))),
  GroupBy: fnGroupBy,
  Top: (a) => {
    if (!Array.isArray(a[0]) || a.length < 3) return []
    const field = str(a[1])
    const n = Math.trunc(num(a[2]))
    const asc = a.length > 3 && a[3] === 'asc'
    const sorted = [...a[0]]
      .filter((r) => r && typeof r === 'object')
      .sort((x, y) => num((x as Record<string, Value>)[field]) - num((y as Record<string, Value>)[field]))
    return (asc ? sorted : sorted.reverse()).slice(0, Math.abs(n))
  },
  Filter: fnFilter,
  Between: (a) => {
    if (!Array.isArray(a[0]) || a.length < 4) return []
    const field = str(a[1])
    return a[0].filter((r) => {
      if (!r || typeof r !== 'object') return false
      const v = (r as Record<string, Value>)[field] as number
      const lo = a[2] as number
      const hi = a[3] as number
      return (a[2] === null || a[2] === undefined || v >= lo) && (a[3] === null || a[3] === undefined || v <= hi)
    })
  },
  Bucket: fnBucket,
  Cumulative: fnCumulative,
  MovingAvg: fnMovingAvg,
  Change: (a) => (a.length > 1 && num(a[1]) ? ((num(a[0]) - num(a[1])) / num(a[1])) * 100 : null),
  Stats: fnStats,
}

// ---------------------------------------------------------------------------
// Evaluator (mirrors _eval in noteui.py)
// ---------------------------------------------------------------------------

function evalNode(node: Node, env: Record<string, Value>): Value {
  const kind = node[0] as string
  if (kind === 'lit') return node[1] as Value
  if (kind === 'var') {
    const name = node[1] as string
    if (!(name in env)) throw new NoteUIError(`Undefined variable $${name}`)
    return env[name]
  }
  if (kind === 'arr') {
    const items = (node[1] as Node[]).map((item) => evalNode(item, env))
    if (items.length && items.every(isBlocks)) {
      const flat: NoteBlock[] = []
      for (const item of items) flat.push(...(item as NoteBlock[]))
      return flat
    }
    return items
  }
  if (kind === 'obj') {
    const out: Record<string, Value> = {}
    for (const [key, val] of node[1] as [string, Node][]) out[key] = evalNode(val, env)
    return out
  }
  if (kind === 'fn') {
    const name = node[1] as string
    const argNodes = node[2] as Node[]
    if (name === 'Each') {
      if (argNodes.length !== 3 || argNodes[1][0] !== 'lit' || typeof argNodes[1][1] !== 'string')
        throw new NoteUIError('@Each(list, "var", template) needs a list, a variable name and a template')
      const source = evalNode(argNodes[0], env)
      const varName = argNodes[1][1] as string
      if (!Array.isArray(source)) return []
      const results = source.map((item) => {
        const scoped = { ...env, [varName]: item }
        return evalNode(argNodes[2], scoped)
      })
      if (results.length && results.every(isBlocks)) {
        const flat: NoteBlock[] = []
        for (const r of results) flat.push(...(r as NoteBlock[]))
        return flat
      }
      return results
    }
    const fn = FUNCTIONS[name]
    if (!fn) throw new NoteUIError(`Unknown function @${name}`)
    const args = argNodes.map((a) => evalNode(a, env))
    try {
      return fn(args)
    } catch (exc) {
      if (exc instanceof NoteUIError) throw exc
      throw new NoteUIError(`@${name} failed: ${exc instanceof Error ? exc.message : exc}`)
    }
  }
  if (kind === 'call') {
    const name = node[1] as string
    const builder = COMPONENTS[name]
    if (!builder) throw new NoteUIError(`Unknown component ${name}()`)
    const args = (node[2] as Node[]).map((a) => evalNode(a, env))
    return builder(args, null)
  }
  if (kind === 'bin') {
    const op = node[1] as string
    if (op === '&&') return Boolean(evalNode(node[2] as Node, env)) && Boolean(evalNode(node[3] as Node, env))
    if (op === '||') return Boolean(evalNode(node[2] as Node, env)) || Boolean(evalNode(node[3] as Node, env))
    const left = evalNode(node[2] as Node, env)
    const right = evalNode(node[3] as Node, env)
    switch (op) {
      case '+':
        return typeof left === 'string' || typeof right === 'string' ? str(left) + str(right) : (left as number) + (right as number)
      case '-': return (left as number) - (right as number)
      case '*': return (left as number) * (right as number)
      case '/': return right ? (left as number) / (right as number) : null
      case '%': return right ? (left as number) % (right as number) : null
      case '==': return left === right
      case '!=': return left !== right
      case '<': return (left as number) < (right as number)
      case '>': return (left as number) > (right as number)
      case '<=': return (left as number) <= (right as number)
      case '>=': return (left as number) >= (right as number)
    }
  }
  if (kind === 'un') {
    const value = evalNode(node[2] as Node, env)
    return node[1] === '!' ? !value : -(value as number)
  }
  if (kind === 'tern') return evalNode(node[1] as Node, env) ? evalNode(node[2] as Node, env) : evalNode(node[3] as Node, env)
  if (kind === 'member') {
    const obj = evalNode(node[1] as Node, env)
    const field = node[2] as string
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return (obj as Record<string, Value>)[field]
    if (Array.isArray(obj)) return obj.filter((r) => r && typeof r === 'object').map((r) => (r as Record<string, Value>)[field])
    return null
  }
  if (kind === 'index') {
    const obj = evalNode(node[1] as Node, env)
    const idx = evalNode(node[2] as Node, env) as number
    if (Array.isArray(obj)) return obj[idx]
    if (obj && typeof obj === 'object') return (obj as Record<string, Value>)[String(idx)]
    return null
  }
  throw new NoteUIError(`Cannot evaluate ${kind}`)
}

// ---------------------------------------------------------------------------
// Public API (mirrors compile_noteui in noteui.py)
// ---------------------------------------------------------------------------

export function compileNoteui(source: string): NoteBlock[] {
  if (!source.trim()) return []
  const program = new Parser(tokenize(source)).parseProgram()
  const env: Record<string, Value> = {}
  const emitted: NoteBlock[] = []
  for (const stmt of program) {
    if (stmt[0] === 'bind') {
      env[stmt[1] as string] = evalNode(stmt[2] as Node, env)
    } else {
      const value = evalNode(stmt[1] as Node, env)
      if (isBlocks(value)) {
        emitted.push(...value)
      } else if (Array.isArray(value) && value.length && isBlocks(value[0])) {
        emitted.push(...asBlocks(value))
      } else {
        throw new NoteUIError('Top-level expressions must produce components, e.g. Page([...]) or Text(...)')
      }
    }
  }
  if ('root' in env) {
    if (!isBlocks(env.root)) throw new NoteUIError('root must be a component or list of components')
    return asBlocks(env.root)
  }
  return emitted
}

/** Fence info strings that compile NoteUI programs (mirrors NOTEUI_FENCES). */
export const NOTEUI_FENCES = new Set(['noteui', 'nb', 'note'])
