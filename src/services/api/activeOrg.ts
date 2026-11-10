/**
 * The organization the dashboard is currently scoped to. Set by AuthProvider from the server
 * session; services read it so every request targets /api/orgs/:id/... for that organization.
 * The server re-checks membership on every call, so this is a convenience, not a security control.
 */
interface ActiveOrg {
  id: string
  name: string
}

let active: ActiveOrg | null = null

export function setActiveOrg(org: ActiveOrg | null): void {
  active = org
}

export function requireActiveOrg(): ActiveOrg {
  if (!active) throw new Error('No active organization')
  return active
}
