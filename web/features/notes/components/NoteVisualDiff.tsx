'use client'

import './note-history.css'

import { diffMarkdown, type DiffLine, type DiffSegment } from '../model/notes-diff'

function Segments({ segments, tone }: { segments: DiffSegment[] | null; tone: 'old' | 'new' }) {
  if (!segments) return null
  return (
    <>
      {segments.map((segment, index) => (
        <span
          key={index}
          className={
            segment.op === 'equal'
              ? undefined
              : `dt-note-diff-word is-${segment.op === 'add' ? 'added' : 'removed'}`
          }
        >
          {segment.value}
        </span>
      ))}
      {tone === 'new' && segments.length === 0 ? '\u00a0' : null}
    </>
  )
}

function lineKind(text: string): string {
  const value = text.trimStart()
  if (/^#{1,6}\s/.test(value)) return 'is-heading'
  if (/^[-*+]\s/.test(value)) return 'is-list'
  if (/^>\s?/.test(value)) return 'is-quote'
  if (value.startsWith('```')) return 'is-code'
  return ''
}

function Line({ line }: { line: DiffLine }) {
  const oldText = line.old?.map((part) => part.value).join('') || ''
  const newText = line.new?.map((part) => part.value).join('') || ''
  return (
    <div className={`dt-note-diff-line is-${line.op}`}>
      <span className="dt-note-diff-num">{line.oldNumber ?? ''}</span>
      <span className="dt-note-diff-mark">{line.oldNumber ? (line.newNumber ? ' ' : '−') : ''}</span>
      <span className={`dt-note-diff-cell ${lineKind(oldText)}`}>
        <Segments segments={line.old} tone="old" />
      </span>
      <span className="dt-note-diff-num">{line.newNumber ?? ''}</span>
      <span className="dt-note-diff-mark">{line.newNumber ? (line.oldNumber ? ' ' : '+') : ''}</span>
      <span className={`dt-note-diff-cell ${lineKind(newText)}`}>
        <Segments segments={line.new} tone="new" />
      </span>
    </div>
  )
}

export default function NoteVisualDiff({
  before,
  after,
}: {
  before: string
  after: string
}) {
  const lines = diffMarkdown(before, after)
  return (
    <div className="dt-note-diff" role="region" aria-label="Changes between versions">
      <div className="dt-note-diff-head" aria-hidden>
        <span />
        <span />
        <span>Before</span>
        <span />
        <span />
        <span>After</span>
      </div>
      <div className="dt-note-diff-body">
        {lines.length ? (
          lines.map((line, index) => <Line key={index} line={line} />)
        ) : (
          <p className="dt-note-diff-empty">No text changes.</p>
        )}
      </div>
    </div>
  )
}
