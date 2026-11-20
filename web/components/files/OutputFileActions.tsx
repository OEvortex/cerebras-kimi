'use client'

import { useState } from 'react'
import { Copy, FolderOpen } from 'lucide-react'

import { apiFetch } from '@/shared/api/client'
import { formatBytes } from '@/lib/doc-attachments'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

interface RenderStorage {
  file_path: string
  file_bytes: number
  cache_path?: string
  cache_bytes?: number
  cache_files?: number
  fingerprint: string
  can_reveal: boolean
}

async function request(path: string, init?: RequestInit) {
  const response = await apiFetch(path, init)
  const body = await response.json()
  if (!response.ok) throw new Error(body.detail || response.statusText)
  return body
}

export function OutputFileActions({ url, kind }: { url: string; kind: 'render' | 'generated' }) {
  const render = kind === 'render'
  const [removed, setRemoved] = useState(false)
  
  const [open, setOpen] = useState(false)
  const [storage, setStorage] = useState<RenderStorage | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  // Only provide management actions for workspace files published by the current app.
  const asset = URL.canParse(url, 'http://workspace.local')
    ? new URL(url, 'http://workspace.local')
    : null
  const path = asset?.pathname ?? ''
  const endpoint = (action: string) => `${path}/${action}${asset?.search ?? ''}`
  const supported =
    url.startsWith('/files/') &&
    /^\/files\/workspace-items\/ws_[0-9a-f]{32}\/wsi_[0-9a-f]{32}$/.test(path)
  if (!supported) return null

  async function load(): Promise<RenderStorage | null> {
    setBusy(true)
    setError('')
    try {
      const result = await request(endpoint(render ? 'render-storage' : 'file-storage'))
      setStorage(result)
      return result
    } catch (cause) {
      setError(cause instanceof Error ? (cause.message) : "Unable to load file storage.")
      return null
    } finally {
      setBusy(false)
    }
  }

  async function clean() {
    if (!storage) return
    setBusy(true)
    setError('')
    try {
      const result = await request(endpoint(render ? 'clean-render-cache' : 'remove-generated-output'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: storage.fingerprint }),
      })
      if (render) {
        setStorage({ ...storage, ...result })
        setMessage(`Freed ${formatBytes(result.freed_bytes)}. Final output is kept.`)
      } else {
        setRemoved(true)
        setMessage("Workspace file removed. The chat attachment is still available.")
      }
    } catch (cause) {
      setError(cause instanceof Error ? (cause.message) : "Unable to clean render files.")
    } finally {
      setConfirm(false)
      setBusy(false)
    }
  }

  const buttonClass =
    'rounded-md border border-[var(--border)] px-2 py-1 text-[12px] hover:bg-[var(--background)] disabled:opacity-40'
  return (
    <div className="mt-2 text-[12px]">
      <button
        type="button"
        aria-expanded={open}
        className={`${buttonClass} inline-flex items-center gap-1`}
        onClick={() => {
          setOpen(!open)
          if (!open) void load()
        }}
      >
        <FolderOpen size={14} />
        {"Output files"}
      </button>
      {open ? (
        <div className="mt-2 space-y-2 rounded-lg border border-[var(--border)] p-3">
          {busy && !storage ? <p role="status">{"Loading file storage…"}</p> : null}
          {error ? (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          ) : null}
          {message ? <p role="status">{message}</p> : null}
          {storage ? (
            <>
              <label className="block">
                {"Saved file path"} · {formatBytes(storage.file_bytes)}
                <input
                  aria-label={"Saved file path"}
                  readOnly
                  value={storage.file_path}
                  className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] p-2 font-mono text-[11px]"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`${buttonClass} inline-flex items-center gap-1`}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(storage.file_path)
                      setMessage("File path copied.")
                    } catch {
                      setError("Copy failed. Select and copy the path above.")
                    }
                  }}
                >
                  <Copy size={12} />
                  {"Copy file path"}
                </button>
                {storage.can_reveal && !removed ? (
                  <button
                    type="button"
                    disabled={busy}
                    className={buttonClass}
                    onClick={async () => {
                      setBusy(true)
                      setError('')
                      try {
                        await request(endpoint(render ? 'reveal' : 'reveal-generated-output'), { method: 'POST' })
                      } catch {
                        setError("Unable to reveal this file.")
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    {"Show in file manager"}
                  </button>
                ) : null}
              </div>
              {render && <p>
                {`Render files: ${storage.cache_files ?? 0} files · ${formatBytes(storage.cache_bytes ?? 0)}`}
              </p>}
              <p className="text-[var(--muted-foreground)]">
                {render
                  ? "Cleanup keeps the final output, source code, and chat playback."
                  : "Removing the workspace copy keeps the chat attachment available."}
              </p>
              {!removed && <button
                type="button"
                disabled={busy || (render && !storage.cache_files)}
                className={buttonClass}
                onClick={async () => {
                  setMessage('')
                  if (!render) {
                    setConfirm(true)
                    return
                  }
                  const preview = await load()
                  if (preview && (preview.cache_files ?? 0) > 0) setConfirm(true)
                }}
              >
                {render ? "Clean render files" : "Remove workspace file"}
              </button>}
            </>
          ) : !busy ? (
            <button type="button" className={buttonClass} onClick={() => void load()}>
              {"Retry"}
            </button>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        title={render ? "Clean render files?" : "Remove generated file?"}
        confirmLabel={render ? "Clean render files" : "Remove workspace file"}
        tone="danger"
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void clean()}
      >
        {render ? <>
          <p>{`Remove ${storage?.cache_files ?? 0} render files and free ${formatBytes(storage?.cache_bytes ?? 0)}?`}</p>
          <p className="mt-2">{"Cleanup keeps the final output, source code, and chat playback."}</p>
        </> : <p>{"Remove the original generated file from the workspace? The chat attachment stays available."}</p>}
      </ConfirmDialog>
    </div>
  )
}
