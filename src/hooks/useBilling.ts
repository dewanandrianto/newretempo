import { useQuery } from '@tanstack/react-query'
import { billing, type BillingService, type Sourced } from '@/services/billing'
import { useAuth } from '@/features/auth/AuthProvider'

/** Typed query over a BillingService method. Keys are namespaced so mutations can invalidate precisely. */
export function useBilling<T>(name: string, select: (service: BillingService) => Promise<Sourced<T>>, args: string[] = []) {
  const { session } = useAuth()
  const orgId = session?.organization?.id ?? 'none'
  return useQuery({
    // Keyed by organization so cached data from one tenant can never render for another.
    queryKey: ['billing', orgId, name, ...args],
    queryFn: () => select(billing),
    staleTime: 30_000,
    retry: 1,
  })
}
