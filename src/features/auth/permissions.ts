import type { MemberRole } from '@shared/types'
import { useAuth } from './AuthProvider'

/**
 * Mirrors the server's role matrix so the UI can disable actions the server would refuse.
 * This is a usability hint only: the API enforces roles on every request.
 */
type Capability = 'catalog' | 'customers' | 'subscriptions' | 'invoices' | 'payments' | 'escrows' | 'wallets' | 'apiKeys' | 'org'

const MEMBER_CAN: Capability[] = ['customers', 'invoices']

export function roleCan(role: MemberRole | undefined, capability: Capability): boolean {
  if (role === 'owner' || role === 'admin') return true
  if (role === 'member') return MEMBER_CAN.includes(capability)
  return false
}

export function useCan(capability: Capability): boolean {
  const { session } = useAuth()
  return roleCan(session?.role, capability)
}

export const ROLE_REASON = 'Your role does not allow this action'
