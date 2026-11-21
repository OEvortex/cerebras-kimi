import { CalendarDays } from 'lucide-react'
import { LEARNING_HUB } from '@/lib/learning-routes'
import {
  Bot,
  GraduationCap,
  House,
  LayoutGrid,
  ListTodo,
  PenLine,
  Settings,
  type LucideIcon,
} from 'lucide-react'

export interface NavEntry {
  href: string
  label: string
  icon: LucideIcon
  tooltipKey?: string
  defaultCollapsed?: boolean
}

/**
 * The workspace features, in the order they ship in.
 *
 * This is the *default* arrangement, not the rendered one — a learner can
 * reorder these and fold the ones they don't use into "More"
 * (``lib/sidebar-layout.ts``). Adding an entry here places it for everyone,
 * including people who have already arranged their sidebar: it arrives next to
 * the neighbour it follows below rather than at the bottom of their list.
 */
const PRIMARY_NAV: NavEntry[] = [
  {
    href: '/chat',
    label: 'Home',
    icon: House,
    tooltipKey: 'Home tooltip',
  },
  {
    href: LEARNING_HUB,
    label: 'Personalized Learning',
    icon: GraduationCap,
    tooltipKey: 'One tutor, your own way to learn.',
  },
  { href: '/space', label: 'Learning Space', icon: LayoutGrid, tooltipKey: 'Space tooltip' },
  {
    href: '/calendar', label: 'Calendar', icon: CalendarDays,
  },
  {
    href: '/co-writer',
    label: 'Co-Writer',
    icon: PenLine,
    tooltipKey: 'Co-Writer tooltip',
    defaultCollapsed: true,
  },
  {
    href: '/agents',
    label: 'My Agents',
    icon: Bot,
    tooltipKey: 'Agents tooltip',
    defaultCollapsed: true,
  },
]

export const SECONDARY_NAV: NavEntry[] = [{ href: '/settings', label: 'Settings', icon: Settings }]

export const DEFAULT_COLLAPSED_NAV = PRIMARY_NAV.filter(entry => entry.defaultCollapsed).map(
  entry => entry.href
)

export const PRIMARY_NAV_HREFS = PRIMARY_NAV.map(entry => entry.href)

export const NAV_BY_HREF = new Map(
  [...PRIMARY_NAV, ...SECONDARY_NAV].map(entry => [entry.href, entry])
)

export function isNavActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}

