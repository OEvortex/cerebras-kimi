'use client'

import { useState, type MouseEvent } from 'react'
import { useActiveStyles } from '@blocknote/react'
import {
  Bold,
  ChevronDown,
  Code,
  Italic,
  Languages,
  Link as LinkIcon,
  Maximize2,
  MessageSquareText,
  Minimize2,
  PenLine,
  Sparkles,
  Strikethrough,
  Underline,
  Wand2,
} from 'lucide-react'

import Tooltip from '@/shared/ui/Tooltip'
import NoteAiEdit from '../NoteAiEdit'
import type { NotesEditor } from './schema'

const STYLE_BUTTONS = [
  ['bold', Bold, 'Bold'],
  ['italic', Italic, 'Italic'],
  ['underline', Underline, 'Underline'],
  ['strike', Strikethrough, 'Strikethrough'],
  ['code', Code, 'Code'],
] as const

const AI_ACTIONS = [
  ['Rewrite', 'Rewrite the selected text; preserve the rest of the block', PenLine],
  ['Make shorter', 'Shorten the selected text', Minimize2],
  ['Make longer', 'Expand the selected text', Maximize2],
  ['Translate', 'Translate the selected text', Languages],
  ['Explain in a comment', 'Explain this passage in a comment', MessageSquareText],
] as const

const TEXT_COLORS = {
  default: 'Default color',
  gray: 'Gray color',
  red: 'Red color',
  orange: 'Orange color',
  yellow: 'Yellow color',
  green: 'Green color',
  blue: 'Blue color',
  purple: 'Purple color',
} as const

interface NoteFormattingToolbarProps {
  editor: NotesEditor
  onAI: (instruction: string) => void
  onProposeAiEdit: (edited: string) => Promise<void>
  onAnnotatePage: () => Promise<boolean>
}

export default function NoteFormattingToolbar({
  editor,
  onAI,
  onProposeAiEdit,
  onAnnotatePage,
}: NoteFormattingToolbarProps) {
  
  const activeStyles = useActiveStyles(editor)
  const [panel, setPanel] = useState<'link' | 'ai' | 'color' | 'edit' | null>(null)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkError, setLinkError] = useState('')
  // The passage is captured when the panel opens: clicking into the panel
  // would otherwise collapse the editor selection under it.
  const [aiSelection, setAiSelection] = useState('')
  const [annotating, setAnnotating] = useState(false)

  // Atomic source/media blocks cannot receive inline formatting. BlockNote
  // also selects these on interaction; only offer tools for selected text.
  if (!editor.getSelectedText().trim()) return null

  const keep = (e: MouseEvent) => e.preventDefault()
  const color = activeStyles.textColor || 'default'

  return (
    <div
      className="dt-note-toolbar"
      onMouseDown={e => {
        if (!(e.target as HTMLElement).closest('input')) e.preventDefault()
      }}
    >
      <button
        className={`dt-note-toolbar-ai ${panel === 'ai' ? 'is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={panel === 'ai'}
        onMouseDown={keep}
        onClick={() => setPanel(panel === 'ai' ? null : 'ai')}
      >
        <Sparkles size={14} />
        {"Ask Co-writer"}
        <ChevronDown size={12} className="opacity-60" />
      </button>
      <button
        className={`dt-note-toolbar-ai ${panel === 'edit' ? 'is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={panel === 'edit'}
        aria-label={"Edit with AI"}
        onMouseDown={keep}
        onClick={() => {
          if (panel === 'edit') {
            setPanel(null)
            return
          }
          setAiSelection(editor.getSelectedText())
          setPanel('edit')
        }}
      >
        <Wand2 size={14} />
        {"Edit with AI"}
      </button>
      <span className="dt-note-toolbar-sep" aria-hidden />
      {STYLE_BUTTONS.map(([style, Icon, label]) => (
        <Tooltip key={style} label={(label)}>
          <button
            aria-label={(label)}
            aria-pressed={!!activeStyles[style]}
            onMouseDown={keep}
            onClick={() => editor.toggleStyles({ [style]: true })}
          >
            <Icon size={15} />
          </button>
        </Tooltip>
      ))}
      <Tooltip label={"Link"}>
        <button
          aria-label={"Link"}
          aria-expanded={panel === 'link'}
          onMouseDown={keep}
          onClick={() => setPanel(panel === 'link' ? null : 'link')}
        >
          <LinkIcon size={15} />
        </button>
      </Tooltip>
      <Tooltip label={"Text color"}>
        <button
          aria-label={"Text color"}
          aria-haspopup="menu"
          aria-expanded={panel === 'color'}
          onMouseDown={keep}
          onClick={() => setPanel(panel === 'color' ? null : 'color')}
        >
          <span className="dt-note-color-glyph" data-color={color}>
            A
          </span>
          <ChevronDown size={11} className="opacity-60" />
        </button>
      </Tooltip>
      {panel === 'ai' && (
        <div className="dt-note-toolbar-panel" role="menu">
          {AI_ACTIONS.map(([label, prompt, Icon]) => (
            <button
              key={label}
              role="menuitem"
              onMouseDown={keep}
              onClick={() => {
                setPanel(null)
                onAI((prompt))
              }}
            >
              <Icon size={14} />
              {(label)}
            </button>
          ))}
          <div className="dt-note-toolbar-divider" />
          <button
            role="menuitem"
            onMouseDown={keep}
            onClick={() => {
              setPanel(null)
              onAI('')
            }}
          >
            <Sparkles size={14} />
            {"Ask about the selection…"}
          </button>
        </div>
      )}
      {panel === 'color' && (
        <div className="dt-note-toolbar-panel is-colors" role="menu">
          {Object.entries(TEXT_COLORS).map(([c, name]) => (
            <button
              key={c}
              role="menuitemradio"
              aria-checked={color === c}
              onMouseDown={keep}
              onClick={() => {
                setPanel(null)
                if (c === 'default') editor.removeStyles({ textColor: color })
                else editor.addStyles({ textColor: c })
              }}
            >
              <span className="dt-note-color-glyph" data-color={c}>
                A
              </span>
              {(name)}
            </button>
          ))}
        </div>
      )}
      {panel === 'edit' && (
        <NoteAiEdit
          selectedText={aiSelection}
          annotating={annotating}
          onApply={edited => {
            setPanel(null)
            void onProposeAiEdit(edited)
          }}
          onAnnotate={() => {
            setAnnotating(true)
            void onAnnotatePage().finally(() => {
              setAnnotating(false)
              setPanel(null)
            })
          }}
          onCancel={() => setPanel(null)}
        />
      )}
      {panel === 'link' && (
        <form
          className="dt-note-link-form"
          onSubmit={e => {
            e.preventDefault()
            if (!/^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(linkUrl.trim())) {
              setLinkError("Enter a valid link")
              return
            }
            editor.createLink(linkUrl.trim())
            setPanel(null)
            editor.focus()
          }}
        >
          <input
            autoFocus
            aria-label={"Link URL"}
            placeholder={"Paste a link…"}
            value={linkUrl}
            onChange={e => setLinkUrl(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                setPanel(null)
                editor.focus()
              }
            }}
          />
          <button type="submit">{"Apply"}</button>
          {linkError && <p role="alert">{linkError}</p>}
        </form>
      )}
    </div>
  )
}
