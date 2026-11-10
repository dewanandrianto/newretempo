import type { ChainProjection, ChainSnapshot } from './chain'
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}'
  return JSON.stringify(value)
}
/** Resolve the entire immutable snapshot or reject. No arbitrary page-count cutoff,
 * partial financial totals, silent token cycles, or last-writer-wins proofs. */
export async function collectChainPages(fetchPage: (token?: string) => Promise<ChainSnapshot>): Promise<ChainSnapshot> {
  const first = await fetchPage()
  if (!first.pagination) return first // Legacy complete JSON protocol.
  const identity = stable([first.configuration, first.cursor, first.bindings])
  const snapshotId = first.pagination.snapshotId
  if (typeof snapshotId !== 'string' || !snapshotId) throw Error('Invalid history snapshot identity')
  const events = new Map<string, ChainSnapshot['events'][number]>()
  const projections = new Map<string, ChainProjection>()
  const visited = new Set<string>()
  let after = 0
  let page = first
  for (;;) {
    const p = page.pagination
    if (!p || p.snapshotId !== snapshotId || stable([page.configuration, page.cursor, page.bindings]) !== identity || typeof p.complete !== 'boolean' || !(p.nextToken === null || typeof p.nextToken === 'string' && p.nextToken.length > 0) || p.complete !== (p.nextToken === null)) throw Error('History snapshot changed or incomplete; retry')
    if (![p.after,p.through,p.highWater].every(n=>Number.isSafeInteger(n)&&n>=0) || p.highWater!==first.pagination.highWater || p.after!==after || p.through<p.after || p.through>p.highWater || !p.complete&&p.through===p.after) throw Error('History pagination did not advance consistently')
    after=p.through
    for (const event of page.events) {
      const previous = events.get(event.id)
      if (previous && stable(previous) !== stable(event)) throw Error('Conflicting history event')
      events.set(event.id, event)
    }
    for (const projection of page.projections) {
      const key = stable([projection.orgId, projection.kind, projection.recordId, projection.key, projection.kind === 'wallet' ? projection.values.eventId ?? [projection.transactionHash, projection.values] : null])
      const previous = projections.get(key)
      if (previous && stable(previous) !== stable(projection)) throw Error('Conflicting history projection')
      projections.set(key, projection)
    }
    if (p.complete) break
    const token = p.nextToken!
    if (visited.has(token)) throw Error('History pagination token cycle')
    visited.add(token)
    page = await fetchPage(token)
  }
  const { pagination: _pagination, ...snapshot } = first
  return { ...snapshot, events: [...events.values()], projections: [...projections.values()] }
}
