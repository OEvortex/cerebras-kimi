'use client'

import { useSyncExternalStore } from 'react'
import { activeWorkspaceId } from './workspace-scope'
import {
  getTaskBoard,
  normalizeTaskBoard,
  subscribeTaskBoardChanges,
  taskBoardUrl,
  type TaskBoard,
} from './task-board-api'

interface State {
  board: TaskBoard | null
  error: boolean
}
const empty: State = { board: null, error: false }
let state = empty
const listeners = new Set<() => void>()
let generation = 0
let refreshing: Promise<void> | undefined
let owners = 0
let stop: (() => void) | undefined
let syncWorkspaceId: string | undefined

function accept(board: TaskBoard) {
  // A delayed GET or mutation must not roll back a newer streamed snapshot.
  if (state.board && board.revision < state.board.revision) return
  state = { board: normalizeTaskBoard(board), error: false }
  listeners.forEach(listener => listener())
}
async function refreshTaskBoard() {
  if (refreshing) return refreshing
  const currentGeneration = generation
  refreshing = (async () => {
    try {
      const board = await getTaskBoard(undefined, syncWorkspaceId ?? activeWorkspaceId())
      if (generation === currentGeneration) accept(board)
    } catch {
      if (generation === currentGeneration) {
        state = { ...state, error: true }
        listeners.forEach(listener => listener())
      }
    } finally {
      if (generation === currentGeneration) refreshing = undefined
    }
  })()
  return refreshing
}

/** One connection per workspace board, owned by the workspace shell and reset with its scope. */

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function useTaskBoard() {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => empty
  )
}
