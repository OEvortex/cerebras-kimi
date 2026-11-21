'use client'

import { scopedUrl } from "@/lib/workspace-scope";
import { LearningCardContent } from '@/components/learning/LearningCard'

import {
  LearningShell,
  LearningEmptyState,
  LearningErrorState,
  LearningSkeleton,
} from '@/components/learning/LearningShell'


import { useEffect, useRef, useState } from 'react'

import { Search, Link2, Play, ListVideo, Rss, Loader2, ArrowLeft } from 'lucide-react'
import { browserStorage } from '@/shared/storage'
import {
  browseInvidious,
  invidiousAccount,
  type InvidiousAccountStatus,
  type InvidiousVideo,
  type InvidiousPlaylist,
} from '@/lib/video-learning-api'

/* eslint-disable @next/next/no-img-element -- Invidious thumbnails come from arbitrary user instances. */

type BrowserView = 'feed' | 'playlists' | 'search' | 'playlist'
export function WatchingBrowser({
  onDismiss,
  canDismiss,
  onSelectUrl,
}: {
  onDismiss(): void
  canDismiss: boolean
  onSelectUrl(url: string): void
}) {
  
  const [account, setAccount] = useState<InvidiousAccountStatus | null>(null)
  const [view, setView] = useState<BrowserView>('search')
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [playlist, setPlaylist] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<(InvidiousVideo | InvidiousPlaylist)[]>([])
  const [busy, setBusy] = useState(false)
  const [accountBusy, setAccountBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const scroll = useRef<HTMLElement>(null)
  const restored = useRef(false)
  const key = 'watching-browser:local'

  useEffect(() => {
    let alive = true
    setItems([])
    setAccount(null)
    void invidiousAccount('status')
      .then(status => {
        if (!alive) return
        setAccount(status)
        let saved: {
          view?: BrowserView
          query?: string
          page?: number
          playlist?: string
          scroll?: number
        } = {}
        try {
          saved = JSON.parse(browserStorage.readRaw('session', key) || '{}')
        } catch {
          /* Storage is optional. */
        }
        if (!restored.current) {
          restored.current = true
          setView(saved.view || (status.connected ? 'feed' : 'search'))
          setQuery(saved.query || '')
          setInput(saved.query || '')
          setPage(saved.page || 1)
          setPlaylist(saved.playlist || '')
        }
      })
      .catch(() => {
        if (alive) setError("Could not load the Invidious account. Please retry.")
      })
    return () => {
      alive = false
    }
  }, [false, true, key])

  useEffect(() => {
    if (!account) return
    const controller = new AbortController()
    setItems([])
    setError('')
    setBusy(false)
    if ((view !== 'search' && !account.connected) || (view === 'search' && !query.trim())) return
    setBusy(true)
    void browseInvidious(view, query, page, playlist, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return
        setItems(Array.isArray(data) ? data : data.videos || [])
        requestAnimationFrame(() => {
          try {
            if (scroll.current)
              scroll.current.scrollTop =
                JSON.parse(browserStorage.readRaw('session', key) || '{}').scroll || 0
          } catch {
            /* Optional. */
          }
        })
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [account, view, query, page, playlist, reload, key])

  function remember(position = 0) {
    try {
      browserStorage.writeRaw(
        'session',
        key,
        JSON.stringify({ view, query, page, playlist, scroll: position })
      )
    } catch {
      /* Optional. */
    }
  }
  async function connect() {
    setAccountBusy(true)
    setError('')
    try {
      const result = await invidiousAccount('authorize')
      if (result.authorize_url) {
        remember()
        window.location.assign(result.authorize_url)
      }
    } catch {
      setError("Could not connect to Invidious. Please retry.")
    } finally {
      setAccountBusy(false)
    }
  }
  async function disconnect() {
    setAccountBusy(true)
    setError('')
    try {
      const status = await invidiousAccount('disconnect')
      setAccount(status)
      setItems([])
      setView('search')
      setPage(1)
      setQuery('')
      setInput('')
      try {
        browserStorage.removeRaw('session', key)
      } catch {
        /* Optional. */
      }
    } catch {
      setError("Could not disconnect. Please retry when the instance is available.")
    } finally {
      setAccountBusy(false)
    }
  }
  function select(url: string) {
    remember(scroll.current?.scrollTop || 0)
    onSelectUrl(url)
    onDismiss()
  }
  return (
    <section className="watching-browser" aria-label={"Browse videos"}>
      <LearningShell
        scrollRef={scroll}
        onScroll={() => remember(scroll.current?.scrollTop || 0)}
        title={"Browse Invidious"}
        subtitle={"Choose a video to add to this collection."}
        action={
          <div className="flex items-center gap-2 text-sm">
            {canDismiss && (
              <button className="watching-browser-button" onClick={onDismiss}>
                <ArrowLeft size={16} />
                {"Close"}
              </button>
            )}
            <button
              className="watching-browser-button"
              disabled={accountBusy}
              onClick={() => void (account?.connected ? disconnect() : connect())}
            >
              {accountBusy ? <Loader2 className="animate-spin" size={16} /> : <Link2 size={16} />}
              {account?.connected
                ? "Disconnect Invidious"
                : account?.needs_reauthorization
                  ? "Reconnect Invidious"
                  : "Connect Invidious"}
            </button>
          </div>
        }
      >
        <div>
          {account && !account.connected && (
            <p className="mb-4 text-sm text-[var(--muted-foreground)]">
              {"Sign in with your Invidious account, then approve read-only access to return here. Your DeepTutor login is separate."}
            </p>
          )}
          <form
            className="flex gap-2"
            onSubmit={event => {
              event.preventDefault()
              if (/^https?:\/\//i.test(input.trim())) {
                select(input.trim())
                return
              }
              setView('search')
              setQuery(input.trim())
              setPage(1)
            }}
          >
            <input
              className="min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 py-3"
              aria-label={"Search videos or paste a video link"}
              placeholder={"Search videos or paste a video link"}
              value={input}
              onChange={e => setInput(e.target.value)}
            />
            <button className="watching-browser-button" type="submit" disabled={!input.trim()}>
              <Search size={18} />
              <span className="hidden sm:inline">{"Search"}</span>
            </button>
          </form>
          <nav className="mt-4 flex gap-2" aria-label={"Video browsing views"}>
            {(
              [
                ['feed', Rss, "Subscription feed"],
                ['playlists', ListVideo, "Playlists"],
                ['search', Search, "Search"],
              ] as const
            ).map(([tab, Icon, label]) => (
              <button
                key={tab}
                className="watching-browser-button"
                aria-pressed={view === tab || (tab === 'playlists' && view === 'playlist')}
                onClick={() => {
                  setView(tab)
                  setPage(1)
                }}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="mt-5">
          {error && (
            <LearningErrorState
              message={error}
              onRetry={() => {
                setReload(value => value + 1)
                if (!account)
                  void invidiousAccount('status')
                    .then(setAccount)
                    .catch(() => undefined)
              }}
            />
          )}
          {view !== 'search' && account && !account.connected ? (
            <div className="watching-browser-empty">
              <Link2 size={32} />
              <p>{"Connect your Invidious account to see subscriptions and playlists."}</p>
              <button
                className="watching-browser-button"
                onClick={() => void connect()}
                disabled={accountBusy}
              >
                {"Connect Invidious"}
              </button>
            </div>
          ) : busy ? (
            <LearningSkeleton />
          ) : (
            <>
              {view === 'playlist' && (
                <button
                  className="watching-browser-button mb-4"
                  onClick={() => {
                    setView('playlists')
                    setPage(1)
                  }}
                >
                  <ArrowLeft size={16} />
                  {"Playlists"}
                </button>
              )}
              <div className="watching-video-grid">
                {items.map(item => {
                  const isPlaylist = 'playlistId' in item
                  const video = isPlaylist ? item.videos?.[0] : item
                  const thumbnail = video?.videoThumbnails?.find(thumb =>
                    /^https?:\/\//.test(thumb.url)
                  )?.url
                  return (
                    <button
                      key={isPlaylist ? item.playlistId : item.videoId}
                      className="watching-video-card"
                      onClick={() => {
                        if (isPlaylist) {
                          setPlaylist(item.playlistId)
                          setView('playlist')
                          setPage(1)
                        } else
                          select(
                            `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`
                          )
                      }}
                    >
                      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-[var(--muted)]">
                        {thumbnail ? (
                          <img
                            src={thumbnail}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <Play size={28} />
                        )}
                        {!isPlaylist && (
                          <span className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-xs text-white">
                            {Math.floor((item.lengthSeconds || 0) / 60)}:
                            {String((item.lengthSeconds || 0) % 60).padStart(2, '0')}
                          </span>
                        )}
                      </div>
                      <div className="mt-3 flex items-center gap-3 text-left">
                        <LearningCardContent
                          title={item.title}
                          icon={isPlaylist ? <ListVideo size={18} /> : <Play size={18} />}
                          subtitle={isPlaylist ? `${item.videoCount} ${"videos"}` : item.author}
                        />
                      </div>
                    </button>
                  )
                })}
              </div>
              {!items.length && !error && (
                <LearningEmptyState
                  icon={<Play size={32} />}
                  title={
                    view === 'search' && !query
                      ? "Find a video to start learning."
                      : "No videos here yet."
                  }
                />
              )}
              {view !== 'playlists' && (items.length > 0 || page > 1) && (
                <div className="mt-6 flex justify-center gap-4">
                  <button
                    className="watching-browser-button"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    {"Previous"}
                  </button>
                  <span className="self-center">{page}</span>
                  <button
                    className="watching-browser-button"
                    disabled={!items.length}
                    onClick={() => setPage(page + 1)}
                  >
                    {"Next"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </LearningShell>
    </section>
  )
}
