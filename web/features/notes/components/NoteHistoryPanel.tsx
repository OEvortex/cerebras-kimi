'use client'

import './note-history.css'

import dynamic from '@/shared/router/dynamic'
import { format, formatDistanceToNow } from 'date-fns'
import { Check, History, Plus, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { NotePage } from '@/lib/notes-api'
import {
  createNoteVersion,
  getNoteVersion,
  listNoteVersions,
  versionSourceLabel,
  type NoteVersion,
} from '../model/note-versions'
import NoteVisualDiff from './NoteVisualDiff'

const Markdown = dynamic(() => import('@/components/common/MarkdownRenderer'), {
  ssr: false,
})

function stamp(seconds: number): Date {
  return new Date((seconds || 0) * 1000)
}

export default function NoteHistoryPanel({
  docId,
  page,
  open,
  onClose,
  onRestore,
}: {
  docId: string
  page: NotePage
  open: boolean
  onClose: () => void
  onRestore: (version: NoteVersion) => Promise<void>
}) {
  const [versions, setVersions] = useState<NoteVersion[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, NoteVersion>>({})
  const [showDiff, setShowDiff] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await listNoteVersions(docId)
      if (!mounted.current) return
      setVersions(result.versions || [])
      setSelectedId((current) =>
        current && result.versions.some((v) => v.id === current)
          ? current
          : result.versions[0]?.id || null
      )
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [docId])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open || !selectedId || details[selectedId]) return
    let cancelled = false
    void getNoteVersion(docId, selectedId)
      .then((version) => {
        if (!cancelled && mounted.current)
          setDetails((previous) => ({ ...previous, [version.id]: version }))
      })
      .catch((err) => {
        if (!cancelled && mounted.current)
          setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open, docId, selectedId, details])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const selected = selectedId ? details[selectedId] : null
  const before = selected?.content || ''
  const after = page.content || ''
  const currentRevision = useMemo(
    () => versions.find((version) => version.revision === page.revision)?.id,
    [versions, page.revision]
  )

  const saveVersion = async () => {
    setBusy(true)
    setError('')
    try {
      await createNoteVersion(docId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    if (!selected) return
    if (!window.confirm('Restore this version? Your current content will be replaced by the restored page, and the current state stays in this history.'))
      return
    setBusy(true)
    setError('')
    try {
      await onRestore(selected)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="dt-note-history" role="dialog" aria-modal="true" aria-label="Version history">
      <div className="dt-note-history-preview">
        <header className="dt-note-history-head">
          <h2>
            {selected ? (
              <span>Version from {format(stamp(selected.created_at), 'MMM d, h:mm a')}</span>
            ) : (
              <span>Select a version</span>
            )}
          </h2>
          <div className="dt-note-history-head-actions">
            {selected && (
              <button
                type="button"
                className={`dt-note-history-toggle ${showDiff ? 'is-active' : ''}`}
                onClick={() => setShowDiff(!showDiff)}
              >
                {showDiff ? 'Show preview' : 'Show changes'}
              </button>
            )}
            <button
              type="button"
              className="dt-note-history-restore"
              disabled={!selected || busy}
              onClick={() => void restore()}
            >
              <RotateCcw size={14} />
              {busy ? 'Restoring…' : 'Restore version'}
            </button>
            <button
              type="button"
              className="dt-note-icon-button"
              aria-label="Close version history"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </header>
        {error && <p role="alert" className="dt-note-history-error">{error}</p>}
        <div className="dt-note-history-content">
          {selected ? (
            showDiff ? (
              <NoteVisualDiff before={before} after={after} />
            ) : (
              <div className="dt-note-history-markdown">
                {before ? <Markdown content={before} /> : <p className="dt-note-history-empty">This version was empty.</p>}
              </div>
            )
          ) : (
            <div className="dt-note-history-empty-state">
              <History size={30} />
              <p>{loading ? 'Loading history…' : 'Select a version to preview it.'}</p>
            </div>
          )}
        </div>
      </div>

      <aside className="dt-note-history-sidebar">
        <div className="dt-note-history-sidebar-head">
          <span>Version history</span>
          <button
            type="button"
            className="dt-note-icon-button"
            aria-label="Save a version now"
            title="Save a version now"
            disabled={busy}
            onClick={() => void saveVersion()}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="dt-note-history-list">
          {versions.length === 0 ? (
            <p className="dt-note-history-empty">No history yet. Edit the page to create a version.</p>
          ) : (
            versions.map((version) => {
              const isSelected = version.id === selectedId
              return (
                <button
                  key={version.id}
                  type="button"
                  className={`dt-note-history-item ${isSelected ? 'is-selected' : ''}`}
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => setSelectedId(version.id)}
                >
                  <span className="dt-note-history-item-top">
                    <span className="dt-note-history-item-title">
                      {formatDistanceToNow(stamp(version.created_at), { addSuffix: true })}
                    </span>
                    {version.id === currentRevision && (
                      <span className="dt-note-history-current"><Check size={11} /> Current</span>
                    )}
                  </span>
                  <span className="dt-note-history-item-meta">
                    {format(stamp(version.created_at), 'MMM d, h:mm a')} · {versionSourceLabel(version.source)}
                  </span>
                  <span className="dt-note-history-item-stats">
                    {version.word_count} words · {version.char_count} chars
                  </span>
                </button>
              )
            })
          )}
        </div>
      </aside>
    </div>
  )
}
