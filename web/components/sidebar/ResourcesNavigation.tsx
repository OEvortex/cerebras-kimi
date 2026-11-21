'use client'

import { NavigationRow, OverviewRow, Section } from './NavigationPrimitives'
import { PersonalizationShelfIcon, ResourcesShelfIcon } from './ShelfIcons'
import {
  DASHBOARD_GROUPS,
  PERSONALIZATION_GROUPS,
  visibleGroups,
  type DashboardGroup,
} from '@/components/space/dashboard-groups'
import { useCapabilityFilter } from '@/features/capabilities/useCapabilityCatalog'

function Shelf({ groups, titled }: { groups: DashboardGroup[]; titled: boolean }) {
  
  const available = useCapabilityFilter()
  return visibleGroups(groups, available).map(group => {
    const rows = group.items.map(row => (
      <NavigationRow key={row.key} href={row.href} label={row.title} icon={row.icon} />
    ))
    return titled ? (
      <Section key={group.label} title={group.label}>
        {rows}
      </Section>
    ) : (
      <div key={group.label} className="dt-navigation-section">
        {rows}
      </div>
    )
  })
}

/** The workspace's materials. */
export function ResourcesNavigation() {
  
  return (
    <>
      <OverviewRow href="/space" label={"All resources"} icon={ResourcesShelfIcon} />
      <Shelf groups={DASHBOARD_GROUPS} titled />
    </>
  )
}

/** What travels with the account into every workspace. */
export function PersonalizationNavigation() {
  
  return (
    <>
      <OverviewRow href="/personalization" label={"All personalization"} icon={PersonalizationShelfIcon} />
      <Shelf groups={PERSONALIZATION_GROUPS} titled={false} />
    </>
  )
}
