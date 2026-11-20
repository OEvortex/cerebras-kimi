'use client'

import { useCallback, type ReactNode } from 'react'

import { InstanceCrumb, type CrumbItem } from '@/components/layout/LocationCrumbs'
import { PageBarSlot } from '@/components/layout/PageChrome'
import { learningLibrary } from '@/lib/learning-library'
import { fetchMasteryTopicIndex } from '@/lib/learning-api'
import { fetchReadingCollectionIndex } from '@/lib/reading-workspace-api'
import { listKnowledgeBases } from '@/features/knowledge/api/catalog'
import { knowledgeBaseRoute } from '@/lib/resource-routes'
import {
  BOOKS_HOME,
  MASTERY_HOME,
  READING_HOME,
  bookRoute,
  masteryTopicRoute,
  readingFolderRoute,
} from '@/lib/learning-routes'
import type { Book } from '@/lib/book-types'

/**
 * The instance crumb of each kind of record, handed up into the page bar:
 * feature / this one, opening onto the others of its kind. Each lists
 * what the feature's own page lists, so the two never disagree.
 */

type CrumbProps = {
  id: string
  label: string
  onRename?: () => void
  /** Render the crumb itself, for a page composing a longer path in its slot. */
  bare?: boolean
}

function inBar(bare: boolean | undefined, crumb: ReactNode) {
  return bare ? crumb : <PageBarSlot name="instance">{crumb}</PageBarSlot>
}

export function ReadingFolderCrumb({ id, label, onRename, bare }: CrumbProps) {
  
  const load = useCallback(
    async (): Promise<CrumbItem[]> =>
      (await fetchReadingCollectionIndex()).map(collection => ({
        id: collection.workspace_id,
        label: collection.title || "Untitled collection",
        href: readingFolderRoute(collection.workspace_id),
      })),
    []
  )
  return inBar(
    bare,
    <InstanceCrumb
      label={label}
      menuLabel={"Collections"}
      currentId={id}
      load={load}
      onRename={onRename}
      all={{ label: "All collections", href: READING_HOME }}
    />
  )
}

export function MasteryPathCrumb({ id, label, onRename, bare }: CrumbProps) {
  
  const load = useCallback(
    async (): Promise<CrumbItem[]> =>
      (await fetchMasteryTopicIndex()).map(topic => ({
        id: topic.path_id,
        label: `${topic.emoji ? `${topic.emoji} ` : ''}${topic.name || topic.path_id}`,
        href: masteryTopicRoute(topic.path_id),
      })),
    []
  )
  return inBar(
    bare,
    <InstanceCrumb
      label={label}
      menuLabel={"Mastery Path"}
      currentId={id}
      load={load}
      onRename={onRename}
      all={{ label: "All paths", href: MASTERY_HOME }}
    />
  )
}

export function BookCrumb({ id, label, onRename, bare }: CrumbProps) {
  
  const load = useCallback(
    async (): Promise<CrumbItem[]> =>
      (await learningLibrary<Book>('books')).items
        .slice()
        .sort((a, b) => b.updated_at - a.updated_at)
        .map(book => ({
          id: book.id,
          label: book.title || "Untitled book",
          href: bookRoute(book.id, null, book.content_workspace_id),
          updatedAt: book.updated_at,
        })),
    []
  )
  return inBar(
    bare,
    <InstanceCrumb
      label={label}
      menuLabel={"Books"}
      currentId={id}
      load={load}
      onRename={onRename}
      all={{ label: "All books", href: BOOKS_HOME }}
    />
  )
}

export function KnowledgeBaseCrumb({ id, label, bare }: CrumbProps) {
  
  const load = useCallback(
    async (): Promise<CrumbItem[]> =>
      (await listKnowledgeBases())
        .filter(kb => kb.metadata?.type !== 'subagent')
        .map(kb => ({ id: kb.name, label: kb.name, href: knowledgeBaseRoute(kb.name) })),
    []
  )
  return inBar(
    bare,
    <InstanceCrumb
      label={label}
      menuLabel={"Knowledge bases"}
      currentId={id}
      load={load}
      all={{ label: "Knowledge Center", href: knowledgeBaseRoute() }}
    />
  )
}

