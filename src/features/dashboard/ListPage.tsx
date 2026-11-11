import { useMemo, useState, type ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { Sourced } from '@/services/billing'
import { Card } from '@/components/ui/Card'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { PageHeader } from '@/components/ui/PageHeader'
import { QueryBoundary } from '@/components/ui/QueryBoundary'
import { Segmented } from '@/components/ui/Segmented'

export interface ListFilter<T> {
  value: string
  label: string
  match: (row: T) => boolean
}

interface ListPageProps<T> {
  title: string
  description: string
  query: UseQueryResult<Sourced<T[]>>
  columns: Column<T>[]
  rowKey: (row: T) => string
  empty: { title: string; description: string }
  /** Primary actions for the page header, such as a "New product" dialog button. */
  actions?: ReactNode
  filters?: ListFilter<T>[]
  onRowClick?: (row: T) => void
  footer?: ReactNode
}

/** Shared list screen for live account records, with an empty state when no rows exist. */
export function ListPage<T>({ title, description, query, columns, rowKey, empty, actions, filters, onRowClick, footer }: ListPageProps<T>) {
  const [filter, setFilter] = useState('all')
  const active = useMemo(() => filters?.find((f) => f.value === filter), [filters, filter])

  return (
    <>
      <PageHeader title={title} description={description} actions={actions} />
      <Card className="overflow-hidden">
        <QueryBoundary query={query} isEmpty={(rows) => rows.length === 0} empty={empty}>
          {(rows) => {
            const visible = active ? rows.filter(active.match) : rows
            return (
              <>
                {filters && (
                  <div className="overflow-x-auto border-b border-line px-5 py-3 sm:px-6">
                    <Segmented
                      label={`Filter ${title}`}
                      value={filter}
                      onChange={setFilter}
                      options={[{ value: 'all', label: `All ${rows.length}` }, ...filters.map((f) => ({ value: f.value, label: f.label }))]}
                    />
                  </div>
                )}
                {visible.length === 0 ? (
                  <p className="px-6 py-12 text-center text-sm text-dim">Nothing matches this filter.</p>
                ) : (
                  <DataTable columns={columns} rows={visible} rowKey={rowKey} onRowClick={onRowClick} />
                )}
              </>
            )
          }}
        </QueryBoundary>
      </Card>
      {footer}
    </>
  )
}
