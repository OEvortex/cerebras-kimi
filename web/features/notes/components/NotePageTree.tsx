'use client'

import { useState, type MouseEvent } from 'react'
import Link from '@/shared/router/link'
import { ChevronRight, FileText, Plus } from 'lucide-react'

import Tooltip from '@/shared/ui/Tooltip'
import type { NoteSummary } from '@/lib/notes-api'

export default function NotePageTree({
  pages,
  currentId,
  busy,
  embedded = false,
  onNavigate,
  onCreate,
  onMove,
}: {
  pages: NoteSummary[]
  currentId: string
  busy: boolean
  embedded?: boolean
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, id: string) => void
  onClose?: () => void
  onCreate: (parentId: string | null) => void
  onMove?: (pageId: string, parentId: string | null) => void
}) {
  
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null | undefined>(undefined)

  // Walking up from the drop target: reparenting is rejected when the target
  // is the dragged page itself or one of its descendants (a cycle).
  const createsCycle = (targetId: string | null): boolean => {
    if (!dragId) return true
    if (targetId === dragId) return true
    const byId = new Map(pages.map(p => [p.id, p]))
    let cursor = targetId ? byId.get(targetId)?.parent_id ?? null : null
    let guard = 0
    while (cursor && guard++ < 50) {
      if (cursor === dragId) return true
      cursor = byId.get(cursor)?.parent_id ?? null
    }
    return false
  }
  const canDropOn = (targetId: string | null) => dragId !== null && !createsCycle(targetId)
  const rows = (parent: string | null, depth: number, ancestors = new Set<string>()): React.ReactNode => {
    const children = pages
      .filter(p => p.parent_id === parent && !ancestors.has(p.id))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned))
    if (!children.length) return null
    return (
      <ul className={parent ? 'dt-note-tree-children' : 'dt-note-tree-roots'}>
        {children.map(page => {
          const title = page.title || "Untitled"
          const hasChildren = pages.some(p => p.parent_id === page.id)
          const expanded = !collapsed.has(page.id)
          return (
            <li key={page.id}>
              <div
                className={`dt-note-tree-row ${page.id === currentId ? 'is-current' : ''} ${
                  dropId === page.id ? 'is-drop-target' : ''
                }`}
                style={{ paddingLeft: depth * 14 }}
                draggable={Boolean(onMove)}
                onDragStart={event => {
                  setDragId(page.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', page.id)
                }}
                onDragEnd={() => {
                  setDragId(null)
                  setDropId(undefined)
                }}
                onDragOver={event => {
                  if (!onMove || !canDropOn(page.id)) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  if (dropId !== page.id) setDropId(page.id)
                }}
                onDragLeave={() => {
                  if (dropId === page.id) setDropId(undefined)
                }}
                onDrop={event => {
                  event.preventDefault()
                  const id = dragId ?? event.dataTransfer.getData('text/plain')
                  setDragId(null)
                  setDropId(undefined)
                  if (id && canDropOn(page.id) && onMove) onMove(id, page.id)
                }}
              >
                {hasChildren ? (
                  <button
                    className="dt-note-tree-toggle"
                    aria-label={(expanded ? `Collapse ${title}` : `Expand ${title}`)}
                    aria-expanded={expanded}
                    onClick={() =>
                      setCollapsed(previous => {
                        const next = new Set(previous)
                        if (expanded) next.add(page.id)
                        else next.delete(page.id)
                        return next
                      })
                    }
                  >
                    <ChevronRight size={13} className={expanded ? 'rotate-90' : ''} />
                  </button>
                ) : (
                  <span className="dt-note-tree-toggle" />
                )}
                <Link
                  href={`/co-writer/${page.id}`}
                  onClick={event => onNavigate(event, page.id)}
                  aria-current={page.id === currentId ? 'page' : undefined}
                >
                  <span className="dt-note-tree-icon" aria-hidden>
                    {page.icon || <FileText size={15} strokeWidth={1.6} />}
                  </span>
                  <span className="truncate">{title}</span>
                </Link>
                <Tooltip label={"Add a page inside"}>
                  <button
                    className="dt-note-tree-add"
                    aria-label={`Add a page inside ${title}`}
                    disabled={busy}
                    onClick={() => onCreate(page.id)}
                  >
                    <Plus size={14} />
                  </button>
                </Tooltip>
              </div>
              {expanded && rows(page.id, depth + 1, new Set([...ancestors, page.id]))}
            </li>
          )
        })}
      </ul>
    )
  }
  return (
    <nav id="note-page-tree" className="dt-note-page-tree" aria-label={"Page tree"}>
      <div className="dt-note-tree-heading">
        <div className="dt-note-tree-heading-main">
          {embedded ? (
            <span>{"Notebook"}</span>
          ) : (
            <Link href="/co-writer">{"Notebook"}</Link>
          )}
          <span className="dt-note-tree-section">{"Pages"}</span>
        </div>
        <Tooltip label={"New page"}>
          <button
            className="dt-note-icon-button"
            aria-label={"New page"}
            disabled={busy}
            onClick={() => onCreate(null)}
          >
            <Plus size={15} />
          </button>
        </Tooltip>
      </div>
      <div
        className={`dt-note-tree-scroll ${dropId === null ? 'is-drop-root' : ''}`}
        onDragOver={event => {
          if (!onMove || !canDropOn(null)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          if (dropId !== null) setDropId(null)
        }}
        onDragLeave={event => {
          if (event.currentTarget === event.target) setDropId(undefined)
        }}
        onDrop={event => {
          event.preventDefault()
          const id = dragId ?? event.dataTransfer.getData('text/plain')
          setDragId(null)
          setDropId(undefined)
          if (id && canDropOn(null) && onMove) onMove(id, null)
        }}
      >
        {rows(null, 0)}
      </div>
    </nav>
  )
}
