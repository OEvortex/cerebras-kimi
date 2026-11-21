'use client'

import {
  BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from '@blocknote/core'
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react'
import {
  createReactInlineMathSpec,
  createReactMathBlockSpec,
} from '@blocknote/math-block'
import '@blocknote/math-block/style.css'
import dynamic from '@/shared/router/dynamic'
import { ArrowUpRight, FileText } from 'lucide-react'

import type { NoteBlock } from '@/lib/notes-api'
import { hasInlineMathCandidate } from '@/lib/latex-normalize'
import { parseNoteMarkdown } from '../../model/markdown'
import NoteFavoriteBlock from '../NoteFavoriteBlock'
import { noteFile } from '../NoteFile'
import {
  callout,
  htmlEmbed,
  noteColumn,
  noteColumns,
  noteDate,
  tableOfContents,
  taskView,
  toggleHeading,
  webCard,
} from '../NoteRichBlocks'
import { noteUpload } from '../NoteUpload'

const Markdown = dynamic(() => import('@/components/common/MarkdownRenderer'), { ssr: false })
const LearningContent = dynamic(() => import('../NoteLearningContent'), { ssr: false })

const mathBlockSpec = createReactMathBlockSpec()
const mathInlineSpec = createReactInlineMathSpec()

const clip = createReactBlockSpec(
  {
    type: 'clip',
    content: 'none',
    propSchema: {
      title: { default: '' },
      markdown: { default: '' },
      sourceUrl: { default: '' },
      sourceId: { default: '' },
      favoriteType: { default: '' },
      summary: { default: '' },
      metadata: { default: '{}' },
      expanded: { default: false },
    },
  },
  {
    render: function ClipBlock({ block, editor }) {
      
      if (block.props.favoriteType || /^\/notebooks?\//.test(block.props.sourceUrl))
        return (
          <NoteFavoriteBlock
            title={block.props.title}
            markdown={block.props.markdown}
            sourceUrl={block.props.sourceUrl}
            type={block.props.favoriteType}
            summary={block.props.summary}
            metadata={block.props.metadata}
            expanded={block.props.expanded}
            onActivate={() => {
              if (editor.getTextCursorPosition().block.id !== block.id)
                editor.setTextCursorPosition(block.id, 'start')
            }}
            onExpanded={expanded =>
              editor.transact(tr => {
                // Reading a saved excerpt is view state, not a content edit.
                tr.setMeta('addToHistory', false)
                editor.updateBlock(block, { props: { expanded } })
              })
            }
          />
        )
      return (
        <div className="dt-note-clip" contentEditable={false}>
          <details open>
            <summary>{block.props.title || "Excerpt"}</summary>
            <Markdown content={block.props.markdown} />
          </details>
          {block.props.sourceUrl && (
            <a data-note-source href={block.props.sourceUrl}>
              {"Return to source"}
            </a>
          )}
        </div>
      )
    },
  }
)

const learning = createReactBlockSpec(
  {
    type: 'learning',
    content: 'none',
    propSchema: {
      kind: { default: 'mermaid' },
      prompt: { default: '' },
      markdown: { default: '' },
      data: { default: '{}' },
      sourceUrl: { default: '' },
    },
  },
  {
    render: ({ block, editor }) => (
      <LearningContent
        id={block.id}
        {...block.props}
        onChange={(props: { prompt?: string; data?: string; kind?: string; markdown?: string }) =>
          editor.updateBlock(block, { props })
        }
      />
    ),
  }
)

const pageLink = createReactInlineContentSpec(
  {
    type: 'pageLink',
    propSchema: { pageId: { default: '' }, title: { default: '' } },
    content: 'none',
  },
  {
    render: ({ inlineContent }) => (
      <a className="dt-note-link" href={`/co-writer/${inlineContent.props.pageId}`}>
        <FileText size={14} aria-hidden="true" />
        <span>{inlineContent.props.title}</span>
        <ArrowUpRight size={12} aria-hidden="true" />
      </a>
    ),
  }
)

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    file: noteFile(),
    mathBlock: mathBlockSpec,
    clip: clip(),
    learning: learning(),
    noteUpload: noteUpload(),
    callout: callout(),
    toggleHeading: toggleHeading(),
    noteColumn: noteColumn(),
    noteColumns: noteColumns(),
    tableOfContents: tableOfContents(),
    webCard: webCard(),
    htmlEmbed: htmlEmbed(),
    taskView: taskView(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, pageLink, math: mathInlineSpec, noteDate },
})

export type NotesEditor = typeof schema.BlockNoteEditor

/** Legacy custom math shapes (`math` block / `inlineMath` inline with a
 *  `formula` prop) -> official math-block specs (`mathBlock` block /
 *  `math` inline with plain-text content). */
function migrateMathTypes(blocks: NoteBlock[]): NoteBlock[] {
  const migrateContent = (content: unknown): unknown => {
    if (!Array.isArray(content)) return content
    return content.map(item => {
      if (!item || typeof item !== 'object') return item
      const node = item as { type?: string; props?: { formula?: string }; content?: unknown }
      if (node.type === 'inlineMath')
        return { type: 'math', content: node.props?.formula ?? '' }
      return { ...node, content: migrateContent(node.content) }
    })
  }
  return blocks.map(block => {
    const migrated = { ...block, content: migrateContent(block.content) } as NoteBlock
    if (block.type === 'math') {
      const props = (block.props ?? {}) as { formula?: string }
      return {
        ...migrated,
        type: 'mathBlock',
        props: {},
        content: props.formula ?? '',
      } as NoteBlock
    }
    return { ...migrated, children: migrateMathTypes(block.children || []) }
  })
}

const INLINE_MATH_RE = /\$([^$\n]+?)\$/g;

/** Split `$...$` pairs out of a text run into `math` inline nodes. Only pairs
 *  the shared normalizer would call a formula are converted, so prices like
 *  "$5 and $10" stay literal. Code-styled text and `$$`/`\$` neighbours are
 *  left alone. */
function extractTextMath(item: Record<string, unknown>): unknown[] {
  const text = item.text;
  const styles = (item.styles ?? {}) as Record<string, unknown>;
  if (typeof text !== 'string' || !text.includes('$') || styles.code) return [item];
  const out: unknown[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_MATH_RE)) {
    const start = match.index!;
    const end = start + match[0].length;
    // Skip $$ display math fragments, escaped \$, and code-adjacent dollars.
    if (
      text[start - 1] === '$' ||
      text[start - 1] === '\\' ||
      text[end] === '$' ||
      text[end] === '\\'
    )
      continue;
    const body = match[1].trim();
    if (!body || !hasInlineMathCandidate(`$${body}$`)) continue;
    if (start > last) out.push({ type: 'text', text: text.slice(last, start), styles });
    out.push({ type: 'math', content: body });
    last = end;
  }
  if (!out.length) return [item];
  if (last < text.length) out.push({ type: 'text', text: text.slice(last), styles });
  return out;
}

function extractInlineMath(content: unknown): unknown {
  if (typeof content === 'string' || !content) return content;
  if (Array.isArray(content)) {
    return content.flatMap(item => {
      if (!item || typeof item !== 'object') return [item];
      const node = item as Record<string, unknown>;
      if (node.type === 'text') return extractTextMath(node);
      if (Array.isArray(node.content)) return [{ ...node, content: extractInlineMath(node.content) }];
      // Table cells: { rows: [{ cells: [[inline...]] }] }
      const table = node as { rows?: Array<{ cells?: unknown[] }> };
      if (Array.isArray(table.rows))
        return [
          {
            ...node,
            rows: table.rows.map(row => ({
              ...row,
              cells: (row.cells ?? []).map(cell =>
                Array.isArray(cell) ? extractInlineMath(cell) : cell
              ),
            })),
          },
        ];
      return [item];
    });
  }
  if (typeof content === 'object') {
    const table = content as { rows?: Array<{ cells?: unknown[] }> };
    if (Array.isArray(table.rows))
      return {
        ...table,
        rows: table.rows.map(row => ({
          ...row,
          cells: (row.cells ?? []).map(cell =>
            Array.isArray(cell) ? extractInlineMath(cell) : cell
          ),
        })),
      };
  }
  return content;
}

/** Drop inline content a block type cannot hold. A stray string there (a model
 *  echoing "timeline" into a learning block) makes the editor reject the page. */
export function fitSchema(blocks: NoteBlock[]): NoteBlock[] {
  return migrateMathTypes(blocks).map(block => {
    const spec = (schema.blockSchema as Record<string, { content?: string } | undefined>)[
      block.type
    ]
    const { content, ...rest } = block
    return {
      ...(spec?.content === 'none' ? rest : { ...rest, content: extractInlineMath(content) }),
      children: fitSchema(block.children || []),
    } as NoteBlock
  })
}

/** Reuse the notebook's normal migration before clipping into an unopened legacy page. */
export function parseLegacyNoteContent(markdown: string): NoteBlock[] {
  const editor = BlockNoteEditor.create({ schema })
  try {
    return parseNoteMarkdown(markdown, text => editor.tryParseMarkdownToBlocks(text) as NoteBlock[])
  } finally {
    editor._tiptapEditor.destroy()
  }
}
