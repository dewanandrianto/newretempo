import { z } from 'zod'
import type { ApiWallet } from '@shared/types'
import { PG, pgCode, withTx } from '../db/client'
import { conflict, notFound, validationFailed } from '../http/errors'
import type { Ctx } from '../http/types'
import { audit } from './audit'
import { evmAddress, iso, uuid } from './common'

/**
 * Merchant-declared wallet associations. Only public addresses are stored. These rows are
 * marked unverified (no signature proves control), so they must never be treated as proof of
 * ownership. SIWE-verified login wallets live on the auth routes instead.
 */
export const walletBody = z.object({
  purpose: z.enum(['payout', 'customer']),
  address: evmAddress,
  label: z.string().trim().max(80).default(''),
  customerId: uuid.optional(),
})
export const walletPatch = z.object({ label: z.string().trim().max(80) })

interface Row {
  id: string
  purpose: 'payout' | 'customer'
  address: string
  chain_id: string
  label: string
  customer_id: string | null
  verified_at: Date | null
  created_at: Date
}
const toWallet = (r: Row): ApiWallet => ({
  id: r.id,
  purpose: r.purpose,
  address: r.address,
  chainId: Number(r.chain_id),
  label: r.label,
  customerId: r.customer_id,
  verified: r.verified_at !== null,
  createdAt: iso(r.created_at) ?? '',
})

export async function listWallets(ctx: Ctx, orgId: string): Promise<ApiWallet[]> {
  const rows = (await ctx.deps.db`
    SELECT id, purpose, address, chain_id::text AS chain_id, label, customer_id, verified_at, created_at
    FROM wallets WHERE org_id = ${orgId} ORDER BY created_at DESC`) as Row[]
  return rows.map(toWallet)
}

export async function createWallet(ctx: Ctx, orgId: string, actorId: string, input: z.infer<typeof walletBody>): Promise<ApiWallet> {
  if (input.purpose === 'customer' && !input.customerId) throw validationFailed({ customerId: 'Choose the customer this wallet belongs to' })
  if (input.purpose === 'payout' && input.customerId) throw validationFailed({ customerId: 'Payout wallets belong to the organization' })
  try {
    const id = await withTx(ctx.deps.db, async (tx) => {
      if (input.customerId) {
        const c = await tx`SELECT id FROM customers WHERE org_id = ${orgId} AND id = ${input.customerId}`
        if (!c.length) throw notFound('Customer')
      }
      const rows = (await tx`
        INSERT INTO wallets (purpose, org_id, customer_id, address, chain_id, label)
        VALUES (${input.purpose}, ${orgId}, ${input.customerId ?? null}, ${input.address}, ${ctx.deps.config.siwe.chainId}, ${input.label})
        RETURNING id`) as { id: string }[]
      await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'wallet.associated', resourceType: 'wallet', resourceId: rows[0].id, metadata: { purpose: input.purpose, address: input.address, verified: false } })
      return rows[0].id
    })
    const all = await listWallets(ctx, orgId)
    return all.find((w) => w.id === id) as ApiWallet
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('This wallet is already associated', 'duplicate_wallet')
    throw err
  }
}

export async function updateWallet(ctx: Ctx, orgId: string, actorId: string, id: string, patch: z.infer<typeof walletPatch>): Promise<ApiWallet> {
  const n = await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`UPDATE wallets SET label = ${patch.label} WHERE org_id = ${orgId} AND id = ${id} RETURNING id`
    if (rows.length) await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'wallet.updated', resourceType: 'wallet', resourceId: id })
    return rows.length
  })
  if (!n) throw notFound('Wallet')
  return (await listWallets(ctx, orgId)).find((w) => w.id === id) as ApiWallet
}

export async function deleteWallet(ctx: Ctx, orgId: string, actorId: string, id: string): Promise<void> {
  await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`DELETE FROM wallets WHERE org_id = ${orgId} AND id = ${id} RETURNING id`
    if (!rows.length) throw notFound('Wallet')
    await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'wallet.removed', resourceType: 'wallet', resourceId: id })
  })
}
