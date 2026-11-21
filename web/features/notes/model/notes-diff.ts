/**
 * Small, dependency-free line and word diff used by the page history panel.
 *
 * The diff is intentionally text-based: versions store a Markdown projection
 * of the page, so a line diff is both cheap and easy to read. Changed lines are
 * paired and diffed again by word to keep the highlights narrow.
 */

export type DiffOp = 'equal' | 'add' | 'remove'

export interface DiffSegment {
  value: string
  op: DiffOp
}

export interface DiffLine {
  op: DiffOp
  oldNumber?: number
  newNumber?: number
  old: DiffSegment[] | null
  new: DiffSegment[] | null
}

interface Opcode {
  op: DiffOp
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
}

/** Longest-common-subsequence opcodes between two arrays. */
function opcodes<T>(a: T[], b: T[]): Opcode[] {
  const n = a.length
  const m = b.length
  const width = m + 1
  const table = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const result: Opcode[] = []
  let i = 0
  let j = 0
  const push = (
    op: DiffOp,
    aStart: number,
    bStart: number,
    aEnd: number,
    bEnd: number
  ) => {
    const last = result[result.length - 1]
    if (last && last.op === op) {
      last.aEnd = aEnd
      last.bEnd = bEnd
    } else {
      result.push({ op, aStart, aEnd, bStart, bEnd })
    }
  }
  while (i < n && j < m) {
    const aStart = i
    const bStart = j
    if (a[i] === b[j]) {
      i++
      j++
      push('equal', aStart, bStart, i, j)
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i++
      push('remove', aStart, bStart, i, j)
    } else {
      j++
      push('add', aStart, bStart, i, j)
    }
  }
  if (i < n) push('remove', i, j, n, j)
  if (j < m) push('add', i, j, i, m)
  return result
}

/** Split text into words plus the whitespace between them. */
function tokens(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) || []
}

const plain = (value: string, op: DiffOp): DiffSegment[] =>
  value ? [{ value, op }] : []

function wordDiff(before: string, after: string): DiffSegment[] {
  const a = tokens(before)
  const b = tokens(after)
  const segments: DiffSegment[] = []
  for (const part of opcodes(a, b)) {
    const oldText = a.slice(part.aStart, part.aEnd).join('')
    const newText = b.slice(part.bStart, part.bEnd).join('')
    if (part.op === 'equal') segments.push(...plain(oldText, 'equal'))
    else {
      if (oldText) segments.push(...plain(oldText, 'remove'))
      if (newText) segments.push(...plain(newText, 'add'))
    }
  }
  return segments
}

/** Produce a side-by-side, word-highlighted line diff of two Markdown strings. */
export function diffMarkdown(before: string, after: string): DiffLine[] {
  const oldLines = (before || '').split('\n')
  const newLines = (after || '').split('\n')
  const lines: DiffLine[] = []
  let oldNumber = 0
  let newNumber = 0

  for (const part of opcodes(oldLines, newLines)) {
    if (part.op === 'equal') {
      for (let k = part.aStart; k < part.aEnd; k++) {
        lines.push({
          op: 'equal',
          oldNumber: ++oldNumber,
          newNumber: ++newNumber,
          old: plain(oldLines[k], 'equal'),
          new: plain(newLines[k + (part.bStart - part.aStart)], 'equal'),
        })
      }
      continue
    }
    const removed = oldLines.slice(part.aStart, part.aEnd)
    const added = newLines.slice(part.bStart, part.bEnd)
    const pairs = Math.max(removed.length, added.length)
    for (let k = 0; k < pairs; k++) {
      const oldLine = removed[k]
      const newLine = added[k]
      const both = oldLine !== undefined && newLine !== undefined
      const segments = both ? wordDiff(oldLine, newLine) : null
      lines.push({
        op: part.op,
        oldNumber: oldLine === undefined ? undefined : ++oldNumber,
        newNumber: newLine === undefined ? undefined : ++newNumber,
        old:
          oldLine === undefined
            ? null
            : segments || plain(oldLine, 'remove'),
        new:
          newLine === undefined
            ? null
            : segments || plain(newLine, 'add'),
      })
    }
  }
  return lines
}

/** A line count summary for the history sidebar. */
export function diffCounts(lines: DiffLine[]): { added: number; removed: number } {
  return lines.reduce(
    (counts, line) => {
      if (line.oldNumber && !line.newNumber) counts.removed++
      if (line.newNumber && !line.oldNumber) counts.added++
      return counts
    },
    { added: 0, removed: 0 }
  )
}
