export interface MerchantUser {
  id: string
  name: string
  email: string | null
  emailVerified: boolean
  /** SIWE-verified login wallets (public addresses only). */
  wallets: string[]
}

export interface Organization {
  id: string
  name: string
  slug: string
  website?: string | null
  industry: string
  country: string
}

export type MemberRole = 'owner' | 'admin' | 'member'

export interface Membership {
  role: MemberRole
  organization: Organization
}

/** A server-issued session. The cookie itself is HttpOnly and never visible to the web app. */
export interface Session {
  user: MerchantUser
  memberships: Membership[]
  /** The organization the dashboard is currently showing, if the user belongs to one. */
  organization?: Organization
  role?: MemberRole
  /** Server policy: organization creation needs a verified email. */
  requireVerifiedEmail: boolean
}

export interface SignUpInput {
  name: string
  email: string
  password: string
}

export interface LoginInput {
  email: string
  password: string
}

export interface OrganizationInput {
  name: string
  slug: string
  website?: string
  industry: string
  country: string
}
