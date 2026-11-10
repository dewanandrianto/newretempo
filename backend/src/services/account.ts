import type { Db } from '../db/client'

export interface AccountView {
  user: {
    id: string
    email: string | null
    emailVerified: boolean
    displayName: string
    wallets: { address: string; chainId: number }[]
  }
  memberships: {
    role: 'owner' | 'admin' | 'member'
    organization: { id: string; name: string; slug: string; website: string | null; industry: string; country: string }
  }[]
}

export async function loadAccount(db: Db, userId: string): Promise<AccountView> {
  const users = (await db`
    SELECT id, email, email_verified_at IS NOT NULL AS verified, display_name FROM users WHERE id = ${userId}`) as {
    id: string
    email: string | null
    verified: boolean
    display_name: string
  }[]
  const u = users[0]
  const wallets = (await db`
    SELECT address, chain_id::text AS chain_id FROM wallets WHERE purpose = 'login' AND user_id = ${userId} ORDER BY created_at`) as {
    address: string
    chain_id: string
  }[]
  const memberships = (await db`
    SELECT m.role, o.id, o.name, o.slug, o.website, o.industry, o.country
    FROM memberships m JOIN organizations o ON o.id = m.org_id
    WHERE m.user_id = ${userId} AND o.status = 'active'
    ORDER BY m.created_at`) as {
    role: 'owner' | 'admin' | 'member'
    id: string
    name: string
    slug: string
    website: string | null
    industry: string
    country: string
  }[]
  return {
    user: {
      id: u.id,
      email: u.email,
      emailVerified: u.verified,
      displayName: u.display_name,
      wallets: wallets.map((w) => ({ address: w.address, chainId: Number(w.chain_id) })),
    },
    memberships: memberships.map((m) => ({
      role: m.role,
      organization: { id: m.id, name: m.name, slug: m.slug, website: m.website, industry: m.industry, country: m.country },
    })),
  }
}
