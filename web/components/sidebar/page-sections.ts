import { CalendarDays } from 'lucide-react'
import { Columns3, LayoutGrid, MessageCircle, PenLine, Plus, type LucideIcon } from 'lucide-react'
import {
  HomeShelfIcon,
  LearningShelfIcon,
  PersonalizationShelfIcon,
  ResourcesShelfIcon,
} from './ShelfIcons'
import {
  DASHBOARD_GROUPS,
  PERSONALIZATION_GROUPS,
  visibleGroups,
  type DashboardGroup,
} from '@/components/space/dashboard-groups'
import { LEARNING_SURFACES } from '@/components/learning/surfaces'
import { categoryForPath } from '@/lib/navigation'
import { navVisibleUnderPolicy } from './nav-entries'

export interface PageEntry {
  href: string
  label: string
  icon: LucideIcon
  /** Account-level: the same in every workspace, so no workspace is shown. */
  account?: boolean
}

export interface PageSection {
  id: 'home' | 'learning' | 'resources' | 'personalization'
  label: string
  icon: LucideIcon
  /** Everything in it travels with the account rather than the workspace. */
  account?: boolean
  pages: PageEntry[]
}

/**
 * The sidebar's shelves as one page tree — the same entries, policy and
 * capability gates the shelves apply — so the page bar and the sidebar can
 * never disagree about where a page lives or what sits beside it.
 *
 * The first three shelves hold the workspace's content; partners and
 * personalization are the account's and look the same in every workspace.
 */
export function pageSections({
  allowedSurfaces,
  isAvailable,
}: {
  allowedSurfaces: readonly string[] | null
  isAvailable: ((name: string) => boolean) | null
}): PageSection[] {
  const surfaceAllowed = (kind: string) =>
    !allowedSurfaces || allowedSurfaces.includes(kind === 'mastery' || kind === 'practice' ? 'chat' : kind)
  const shelf = (groups: DashboardGroup[]) =>
    visibleGroups(groups, isAvailable).flatMap(group =>
      group.items.map(item => ({ href: item.href, label: item.title.en, icon: item.icon }))
    )
  const sections: PageSection[] = [
    {
      id: 'home',
      label: "Home",
      icon: HomeShelfIcon,
      pages: [
        { href: '/chat', label: "Chat", icon: MessageCircle },
        { href: '/calendar', label: "Calendar", icon: CalendarDays, account: true },
        { href: '/co-writer', label: "Notebook", icon: PenLine },
      ].filter(page => navVisibleUnderPolicy(page.href, allowedSurfaces)),
    },
    {
      id: 'learning',
      label: "Learning",
      icon: LearningShelfIcon,
      pages: [
        { href: '/learning/new', label: "New learning activity", icon: Plus },
        { href: '/learning', label: "All learning", icon: LayoutGrid },
        ...LEARNING_SURFACES.filter(surface => surfaceAllowed(surface.kind)).map(surface => ({
          href: surface.href,
          label: (surface.title),
          icon: surface.icon,
        })),
      ],
    },
    {
      id: 'resources',
      label: "Resources",
      icon: ResourcesShelfIcon,
      pages: [{ href: '/space', label: "All resources", icon: ResourcesShelfIcon }, ...shelf(DASHBOARD_GROUPS)],
    },
    {
      id: 'personalization',
      label: "Personalization",
      icon: PersonalizationShelfIcon,
      account: true,
      pages: [
        { href: '/personalization', label: "All personalization", icon: PersonalizationShelfIcon },
        ...shelf(PERSONALIZATION_GROUPS).filter(page => page.href !== '/agents' || navVisibleUnderPolicy(page.href, allowedSurfaces)),
      ],
    },
  ]
  return sections.map(section =>
    section.account ? { ...section, pages: section.pages.map(page => ({ ...page, account: true })) } : section
  )
}

/**
 * Views whose working toolbar carries the location itself — the reader's
 * bar sits over the document column only, the notebook's over the page —
 * so they draw the same crumbs there (see `useShelfFeature`) instead of
 * under a second bar.
 */
const OWN_HEADER = [
  /^\/co-writer\/[^/]+/,
  /^\/learning\/reading\/(?!folders\/|materials$)[^/]+/,
  /^\/learning\/watching\//,
]

/**
 * The section and page a pathname belongs to: the feature page itself, or
 * the feature page a detail view (a conversation, a book, a path, a folder,
 * a partner) lives under.
 */
export function locatePage(pathname: string, sections: PageSection[]) {
  for (const section of sections) {
    const page = section.pages.find(entry => entry.href === pathname)
    if (page) return { section, page }
  }
  return OWN_HEADER.some(pattern => pattern.test(pathname)) ? null : ownerOf(pathname, sections)
}

/** The feature page a detail path lives under, by longest prefix. */
function ownerOf(pathname: string, sections: PageSection[], workspaceOnly = false) {
  let owner: { section: PageSection; page: PageEntry } | null = null
  for (const section of sections) {
    if (workspaceOnly && section.account) continue
    for (const page of section.pages) {
      if (pathname.startsWith(`${page.href}/`) && page.href.length > (owner?.page.href.length ?? 0))
        owner = { section, page }
    }
  }
  return owner
}

const EVERY_PAGE = pageSections({ allowedSurfaces: null, isAvailable: () => true })

/**
 * Where a workspace switch lands: the same page, or the index page the
 * detail view lives under — the record itself belongs to the old workspace.
 */
export function switchDestination(pathname: string): string {
  // The account's own pages are the same on both sides of a switch.
  if (['personalization'].includes(categoryForPath(pathname))) return pathname
  if (EVERY_PAGE.some(section => section.pages.some(page => page.href === pathname))) return pathname
  const owner = ownerOf(pathname, EVERY_PAGE, true)
  if (owner) return owner.page.href
  const section = pathname.split('/')[1]
  return section ? `/${section}` : '/chat'
}
