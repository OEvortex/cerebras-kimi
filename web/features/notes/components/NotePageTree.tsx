'use client'

import { useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import Link from '@/shared/router/link'
import { ChevronRight, Copy, FileText, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'

import Tooltip from '@/shared/ui/Tooltip'
import { useMenuPopover } from '@/shared/ui/useMenuPopover'
import type { NoteSummary } from '@/lib/notes-api'

/** The ⋯ menu a Notion row reveals on hover: rename, duplicate, delete. */
function RowMenu({
  title,
  childCount,
  disabled,
  onRename,
  onDuplicate,
  onDelete,
}: {
  title: string
  childCount: number
  disabled: boolean
  onRename: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const [open, setOpenState] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const setOpen = (value: boolean | ((current: boolean) => boolean)) => {
    const next = typeof value === 'function' ? value(open) : value
    setOpenState(next)
    if (!next) setConfirming(false)
  }
  const menu = useMenuPopover<HTMLDivElement>(open, setOpen)
  return (
    <div className="dt-note-tree-actions">
      <button
        className="dt-note-tree-more"
        aria-label={`Page actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          setOpen(!open)
        }}
      >
        <MoreHorizontal size={15} strokeWidth={1.8} />
      </button>
      {open && (
        <div ref={menu} className="dt-popover dt-note-tree-menu" role="menu">
          {confirming ? (
            <>
              <p className="dt-note-tree-confirm">
                {childCount > 0
                  ? `Delete “${title}”? Its subpages move up one level.`
                  : `Delete “${title}”? This cannot be undone.`}
              </p>
              <button
                role="menuitem"
                className="dt-menu-item is-danger"
                disabled={disabled}
                onClick={() => {
                  setOpen(false)
                  onDelete()
                }}
              >
                <Trash2 size={14} />
                {"Delete page"}
              </button>
            </>
          ) : (
            <>
              <button
                role="menuitem"
                className="dt-menu-item"
                disabled={disabled}
                onClick={() => {
                  setOpen(false)
                  onRename()
                }}
              >
                <Pencil size={14} />
                <span className="flex-1">{"Rename"}</span>
              </button>
              <button
                role="menuitem"
                className="dt-menu-item"
                disabled={disabled}
                onClick={() => {
                  setOpen(false)
                  onDuplicate()
                }}
              >
                <Copy size={14} />
                <span className="flex-1">{"Duplicate"}</span>
              </button>
              <div className="dt-menu-divider" />
              <button
                role="menuitem"
                className="dt-menu-item is-danger"
                disabled={disabled}
                onClick={() => setConfirming(true)}
              >
                <Trash2 size={14} />
                <span className="flex-1">{"Delete"}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function NotePageTree({
  pages,
  currentId,
  busy,
  embedded = false,
  onNavigate,
  onCreate,
  onMove,
  onRename,
  onDuplicate,
  onDelete,
}: {
  pages: NoteSummary[]
  currentId: string
  busy: boolean
  embedded?: boolean
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, id: string) => void
  onClose?: () => void
  onCreate: (parentId: string | null) => void
  onMove?: (pageId: string, parentId: string | null) => void
  onRename?: (id: string, title: string) => void
  onDuplicate?: (id: string) => void
  onDelete?: (id: string) => void
}) {
  
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null | undefined>(undefined)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const commitRename = (id: string) => {
    const value = renameValue.trim()
    setRenamingId(null)
    if (value) onRename?.(id, value)
  }

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
          const childCount = pages.filter(p => p.parent_id === page.id).length
          const hasChildren = childCount > 0
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
                {renamingId === page.id ? (
                  <input
                    className="dt-note-tree-rename"
                    aria-label={`Rename ${title}`}
                    autoFocus
                    value={renameValue}
                    onClick={event => event.stopPropagation()}
                    onChange={event => setRenameValue(event.target.value)}
                    onBlur={() => commitRename(page.id)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commitRename(page.id)
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        setRenamingId(null)
                      }
                    }}
                  />
                ) : (
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
                )}
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
                {onRename || onDuplicate || onDelete ? (
                  <RowMenu
                    title={title}
                    childCount={childCount}
                    disabled={busy}
                    onRename={() => {
                      setRenameValue(page.title || '')
                      setRenamingId(page.id)
                    }}
                    onDuplicate={() => onDuplicate?.(page.id)}
                    onDelete={() => onDelete?.(page.id)}
                  />
                ) : null}
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
