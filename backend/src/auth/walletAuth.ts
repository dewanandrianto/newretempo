import { PG, pgCode, withTx } from '../db/client'
import { conflict, forbidden } from '../http/errors'
import type { Ctx } from '../http/types'
import { audit } from '../services/audit'
import type { VerifiedWallet } from './siwe'

/** Finds or creates the account that owns a SIWE-verified wallet. Returns the user id. */
export async function loginWithWallet(ctx: Ctx, wallet: VerifiedWallet): Promise<string> {
  const { db, config } = ctx.deps
  const short = `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`

  const find = async (): Promise<string | null> => {
    const rows = (await db`
      SELECT u.id FROM wallets w JOIN users u ON u.id = w.user_id
      WHERE w.purpose = 'login' AND w.address = ${wallet.address} AND u.status = 'active'`) as { id: string }[]
    return rows[0]?.id ?? null
  }

  let userId = await find()
  if (!userId) {
    try {
      userId = await withTx(db, async (tx) => {
        const users = (await tx`INSERT INTO users (display_name) VALUES (${`Wallet ${short}`}) RETURNING id`) as { id: string }[]
        const id = users[0].id
        await tx`
          INSERT INTO wallets (purpose, user_id, address, chain_id, verified_at, verification_method)
          VALUES ('login', ${id}, ${wallet.address}, ${config.siwe.chainId}, now(), 'siwe')`
        await audit(tx, ctx, { actorUserId: id, action: 'user.registered', resourceType: 'user', resourceId: id, metadata: { method: 'siwe' } })
        return id
      })
    } catch (err) {
      if (pgCode(err) !== PG.uniqueViolation) throw err
      userId = await find() // lost a race with a concurrent sign-in for the same wallet
    }
  }
  if (!userId) throw forbidden('This wallet account is not active')
  await db`UPDATE users SET last_login_at = now() WHERE id = ${userId}`
  await audit(db, ctx, { actorUserId: userId, action: 'auth.login', resourceType: 'user', resourceId: userId, metadata: { method: 'siwe' } })
  return userId
}

/** Attaches a SIWE-verified wallet to the signed-in account. */
export async function linkWalletToUser(ctx: Ctx, wallet: VerifiedWallet, sessionUserId: string): Promise<void> {
  const { db, config } = ctx.deps
  if (wallet.userId !== sessionUserId) throw forbidden('This challenge was issued to a different account')
  try {
    await withTx(db, async (tx) => {
      await tx`
        INSERT INTO wallets (purpose, user_id, address, chain_id, verified_at, verification_method)
        VALUES ('login', ${sessionUserId}, ${wallet.address}, ${config.siwe.chainId}, now(), 'siwe')`
      await audit(tx, ctx, { actorUserId: sessionUserId, action: 'wallet.linked', resourceType: 'wallet', metadata: { address: wallet.address } })
    })
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('This wallet is already linked to an account', 'wallet_in_use')
    throw err
  }
}
