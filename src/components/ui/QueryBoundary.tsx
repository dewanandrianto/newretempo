import type { ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { Sourced } from '@/services/billing'
import { EmptyState, ErrorState, PageSkeleton, TableSkeleton } from './States'

interface QueryBoundaryProps<T> {
  query: UseQueryResult<Sourced<T>>
  /** 'table' renders row skeletons, 'page' renders card + chart skeletons. */
  skeleton?: 'table' | 'page'
  isEmpty?: (data: T) => boolean
  empty?: { title: string; description: string; action?: ReactNode; icon?: ReactNode }
  children: (data: T, source: Sourced<T>['source']) => ReactNode
}

export function QueryBoundary<T>({ query, skeleton = 'table', isEmpty, empty, children }: QueryBoundaryProps<T>) {
  if (query.isPending) return skeleton === 'page' ? <PageSkeleton /> : <TableSkeleton />
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />
  const { data, source } = query.data
  if (empty && isEmpty?.(data)) return <EmptyState {...empty} />
  return <>{children(data, source)}</>
}
