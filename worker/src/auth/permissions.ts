export type OrgRole = 'owner' | 'admin' | 'member'
export type Permission = 'org:read' | 'org:update' | 'members:read' | 'members:manage' | 'catalog:write' | 'customers:write' | 'subscriptions:write' | 'invoices:write' | 'payments:write' | 'escrows:write' | 'wallets:write' | 'api_keys:manage'
const RANK: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 }
const MIN_ROLE: Record<Permission, OrgRole> = {'org:read':'member','members:read':'member','customers:write':'member','invoices:write':'member','org:update':'admin','members:manage':'admin','catalog:write':'admin','subscriptions:write':'admin','payments:write':'admin','escrows:write':'admin','wallets:write':'admin','api_keys:manage':'admin'}
export function can(role: OrgRole, permission: Permission): boolean { return RANK[role] >= RANK[MIN_ROLE[permission]] }
export function outranks(actor: OrgRole, target: OrgRole): boolean { return RANK[actor] > RANK[target] }
