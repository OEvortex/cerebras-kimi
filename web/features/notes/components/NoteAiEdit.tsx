'use client'

import { Loader2, Sparkles, Wand2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { AI_EDIT_MODES, streamSelectionEdit, type AiEditMode } from '@/lib/note-ai'

/**
 * "Edit with AI" for the current selection.
 *
 * The model's rewrite never lands in the page directly: the result becomes a
 * suggestion on the page, so the learner accepts or dismisses it like any other
 * Co-writer proposal. The streamed draft is previewed here while it is written.
 */
export default function NoteAiEdit({
  selectedText,
  onApply,
  onAnnotate,
  annotating,
  onCancel,
}: {
  selectedText: string
  onApply: (edited: string) => void
  onAnnotate: () => void
  annotating: boolean
  onCancel: () => void
}) {
  
  const [mode, setMode] = useState<AiEditMode>('rewrite')
  const [instruction, setInstruction] = useState('')
  const [running, setRunning] = useState(false)
  const [preview, setPreview] = useState('')
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)

  useEffect(() => () => controller.current?.abort(), [])

  const run = async () => {
    if (running) return
    if (mode === 'none' && !instruction.trim()) {
      setError("Describe what to change, or pick Rewrite, Shorten or Expand.")
      return
    }
    setRunning(true)
    setError('')
    setPreview('')
    controller.current = new AbortController()
    try {
      const edited = await streamSelectionEdit({
        selectedText,
        instruction: instruction.trim(),
        mode,
        signal: controller.current.signal,
        onDelta: chunk => setPreview(current => current + chunk),
      })
      const text = edited.trim()
      if (!text) {
        setError("The model returned nothing to insert.")
        return
      }
      onApply(text)
    } catch (err) {
      if (controller.current.signal.aborted) return
      setError(err instanceof Error ? err.message : "The edit failed.")
    } finally {
      setRunning(false)
    }
  }

  return (
    <div
      className="dt-note-toolbar-panel dt-note-ai-panel"
      role="dialog"
      aria-label={"Edit with AI"}
      onMouseDown={event => event.stopPropagation()}
    >
      <div className="dt-note-ai-head">
        <span>
          <Wand2 size={14} />
          {"Edit with AI"}
        </span>
        <button
          type="button"
          aria-label={"Close"}
          className="dt-note-ai-close"
          onMouseDown={event => event.preventDefault()}
          onClick={onCancel}
        >
          <X size={13} />
        </button>
      </div>

      <div className="dt-note-ai-modes" role="group" aria-label={"What to do"}>
        {AI_EDIT_MODES.map(option => (
          <button
            key={option.mode}
            type="button"
            aria-pressed={mode === option.mode}
            className={mode === option.mode ? 'is-active' : ''}
            onMouseDown={event => event.preventDefault()}
            onClick={() => setMode(option.mode)}
          >
            {(option.label)}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={mode === 'none'}
          className={mode === 'none' ? 'is-active' : ''}
          onMouseDown={event => event.preventDefault()}
          onClick={() => setMode('none')}
        >
          {"Custom"}
        </button>
      </div>

      <input
        className="dt-note-ai-instruction"
        aria-label={"How should it change?"}
        placeholder={
          mode === 'none'
            ? "Describe the change, e.g. “explain like I’m new to this”"
            : "Optional: add a detail to include"
        }
        value={instruction}
        onChange={event => setInstruction(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void run()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      />

      {preview && !error ? (
        <div className="dt-note-ai-preview" aria-live="polite">
          {preview}
        </div>
      ) : null}
      {error ? <p className="dt-note-ai-error">{error}</p> : null}

      <div className="dt-note-ai-foot">
        <button
          type="button"
          className="dt-note-ai-annotate"
          disabled={running || annotating}
          onMouseDown={event => event.preventDefault()}
          onClick={onAnnotate}
        >
          {annotating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {"Annotate page"}
        </button>
        <button
          type="button"
          className="dt-note-ai-apply"
          disabled={running}
          onMouseDown={event => event.preventDefault()}
          onClick={() => void run()}
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
          {running ? "Editing…" : "Suggest edit"}
        </button>
      </div>
    </div>
  )
}
